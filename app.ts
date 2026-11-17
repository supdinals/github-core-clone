/**
 * app.ts — HTTP wiring: one handler that routes between the health probe,
 * the git smart-HTTP surface, REST v3, GraphQL and MCP, all over a single
 * Forge store created fresh for this process.
 *
 * Authentication: the suite presents `Authorization: Bearer <token>` where
 * the token is this process's MAKEFUN_SHOP_TOKEN. When that variable is set
 * the bearer value must match it exactly; when it is unset (local dev) any
 * Authorization header is accepted and a missing one is a 401.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { Forge } from "./forge.ts";
import { infoRefsBody, receivePackBody, uploadPackBody } from "./gitproto.ts";
import { handleGraphQL } from "./graphql.ts";
import { handleMcp } from "./mcp.ts";
import { handleRest, type ApiRequest } from "./rest.ts";

const MAX_BODY_BYTES = 128 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...(extra ?? {}) });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-cache" });
  res.end(body);
}

export function createForgeHandler(): (req: IncomingMessage, res: ServerResponse) => void {
  const forge = new Forge();
  let requestCounter = 0;

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (!header) return false;
    const expected = process.env.MAKEFUN_SHOP_TOKEN;
    if (expected) return header === `Bearer ${expected}` || header === expected;
    return true;
  };

  return (req, res) => {
    void (async () => {
      try {
        const method = req.method ?? "GET";
        const url = new URL(req.url ?? "/", "http://forge.local");
        let pathname = url.pathname;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          // Keep the raw path; routing will 404 it.
        }
        requestCounter += 1;
        const requestId = `req-${requestCounter.toString(36)}-${Date.now().toString(36)}`;

        if (pathname === "/healthz" && method === "GET") {
          sendJson(res, 200, { ok: true });
          return;
        }

        const body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req);

        // --- REST v3 -----------------------------------------------------
        if (pathname === "/api/v3" || pathname.startsWith("/api/v3/")) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: "Bad credentials" }, { "x-github-request-id": requestId });
            return;
          }
          const apiRequest: ApiRequest = {
            method,
            path: pathname,
            query: url.searchParams,
            body,
            host: req.headers.host ?? "forge.local",
          };
          const response = handleRest(forge, apiRequest);
          const headers: Record<string, string> = {
            "x-github-request-id": requestId,
            ...(response.headers ?? {}),
          };
          if (response.status === 204) {
            res.writeHead(204, headers);
            res.end();
            return;
          }
          sendJson(res, response.status, response.body ?? {}, headers);
          return;
        }

        // --- GraphQL ------------------------------------------------------
        if (pathname === "/api/graphql" && method === "POST") {
          if (!authorized(req)) {
            sendJson(res, 401, { errors: [{ message: "Bad credentials" }] });
            return;
          }
          const response = handleGraphQL(forge, body);
          sendJson(res, response.status, response.body);
          return;
        }

        // --- MCP ----------------------------------------------------------
        if (pathname === "/mcp" && method === "POST") {
          if (!authorized(req)) {
            sendJson(res, 401, {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32001, message: "Unauthorized" },
            });
            return;
          }
          const response = handleMcp(forge, body);
          if (response.status === 202 || response.body === undefined) {
            res.writeHead(202);
            res.end();
            return;
          }
          sendJson(res, response.status, response.body);
          return;
        }

        // --- git smart HTTP ------------------------------------------------
        const gitMatch = /^\/([^/]+)\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch) {
          const [, owner, repoName, endpoint] = gitMatch;
          if (!authorized(req)) {
            res.writeHead(401, { "content-type": "text/plain", "www-authenticate": 'Bearer realm="forge"' });
            res.end("unauthorized");
            return;
          }
          const repo = forge.getRepo(owner, repoName);
          if (!repo) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("repository not found");
            return;
          }
          const protocolHeader = req.headers["git-protocol"];
          const protocolVersion = typeof protocolHeader === "string" && protocolHeader.includes("version=2") ? 2 : 0;
          if (endpoint === "info/refs" && method === "GET") {
            const service = url.searchParams.get("service") ?? "";
            if (service !== "git-upload-pack" && service !== "git-receive-pack") {
              res.writeHead(400, { "content-type": "text/plain" });
              res.end("unknown service");
              return;
            }
            sendBuffer(res, 200, infoRefsBody(repo, service, protocolVersion), `application/x-${service}-advertisement`);
            return;
          }
          if (endpoint === "git-upload-pack" && method === "POST") {
            const payload = uploadPackBody(repo, body, protocolVersion);
            if (payload === null) {
              res.writeHead(400, { "content-type": "text/plain" });
              res.end("malformed upload-pack request");
              return;
            }
            sendBuffer(res, 200, payload, "application/x-git-upload-pack-result");
            return;
          }
          if (endpoint === "git-receive-pack" && method === "POST") {
            sendBuffer(res, 200, receivePackBody(repo, body), "application/x-git-receive-pack-result");
            return;
          }
          res.writeHead(405, { "content-type": "text/plain" });
          res.end("method not allowed");
          return;
        }

        sendJson(res, 404, { message: "Not Found" });
      } catch (err) {
        // The forge must never die on a bad request.
        try {
          if (!res.headersSent) sendJson(res, 500, { message: `internal error: ${err instanceof Error ? err.message : String(err)}` });
          else res.end();
        } catch {
          // Socket already gone.
        }
      }
    })();
  };
}
