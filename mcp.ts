/**
 * mcp.ts — the Model Context Protocol surface: a stateless streamable-HTTP
 * JSON-RPC endpoint speaking the modern protocol era (server/discover,
 * 2026-07-28) with a legacy initialize fallback. Six tools expose the forge
 * (create/get repo, create/list issues, create/merge pull requests) over the
 * same store as REST, so anything made here reads back identically there.
 */
import type { Forge, Repo } from "./forge.ts";
import { issueJson, mergePullRequest, pullJson, repoJson } from "./rest.ts";

const SERVER_INFO = { name: "forge", version: "1.0.0" };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: "create_repo",
    description: "Create a new repository owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Repository description" },
        private: { type: "boolean", description: "Whether the repository is private" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_repo",
    description: "Fetch a repository by owner and name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login" },
        repo: { type: "string", description: "Repository name" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_issue",
    description: "Open a new issue on a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "list_issues",
    description: "List a repository's issues, optionally filtered by state.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login" },
        repo: { type: "string", description: "Repository name" },
        state: { type: "string", description: "Filter: open, closed or all" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_pull_request",
    description: "Open a pull request from a head branch into a base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "Pull request title" },
        head: { type: "string", description: "Head branch name" },
        base: { type: "string", description: "Base branch name" },
        body: { type: "string", description: "Pull request body" },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "merge_pull_request",
    description: "Squash-merge an open pull request into its base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login" },
        repo: { type: "string", description: "Repository name" },
        pull_number: { type: "number", description: "Pull request number" },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
];

/** Built once and reused verbatim: two tools/list calls must be identical. */
const TOOLS_LIST_RESULT = { tools: TOOLS };

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: ["2026-07-28"],
    protocolVersion: "2026-07-28",
    serverInfo: SERVER_INFO,
    capabilities: { tools: { listChanged: false } },
    _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
  };
}

function toolResult(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

function findRepo(forge: Forge, args: Record<string, unknown>): Repo | undefined {
  const owner = typeof args.owner === "string" ? args.owner : "";
  const name = typeof args.repo === "string" ? args.repo : "";
  return forge.getRepo(owner, name);
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return null;
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === "") {
      return toolError(`missing required argument '${required}' for tool '${name}'`);
    }
  }
  switch (name) {
    case "create_repo": {
      const repoName = String(args.name);
      if (forge.getRepo(forge.viewer.login, repoName)) {
        return toolError(`repository '${repoName}' already exists`);
      }
      const repo = forge.createRepo(
        repoName,
        typeof args.description === "string" ? args.description : "",
        typeof args.private === "boolean" ? args.private : false,
      );
      return toolResult(repoJson(forge, repo));
    }
    case "get_repo": {
      const repo = findRepo(forge, args);
      if (!repo) return toolError("repository not found");
      return toolResult(repoJson(forge, repo));
    }
    case "create_issue": {
      const repo = findRepo(forge, args);
      if (!repo) return toolError("repository not found");
      const now = forge.now();
      const issue = {
        id: forge.newObjectId(),
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === "string" ? args.body : "",
        state: "open" as const,
        labels: [] as string[],
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return toolResult(issueJson(forge, repo, issue));
    }
    case "list_issues": {
      const repo = findRepo(forge, args);
      if (!repo) return toolError("repository not found");
      const state = typeof args.state === "string" ? args.state : "open";
      let issues = [...repo.issues.values()];
      if (state === "open") issues = issues.filter((issue) => issue.state === "open");
      else if (state === "closed") issues = issues.filter((issue) => issue.state === "closed");
      issues.sort((a, b) => a.number - b.number);
      return toolResult(issues.map((issue) => issueJson(forge, repo, issue)));
    }
    case "create_pull_request": {
      const repo = findRepo(forge, args);
      if (!repo) return toolError("repository not found");
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.branchTip(head);
      const baseSha = repo.branchTip(base);
      if (!headSha) return toolError(`head branch '${head}' does not exist`);
      if (!baseSha) return toolError(`base branch '${base}' does not exist`);
      const now = forge.now();
      const pull = {
        id: forge.newObjectId(),
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === "string" ? args.body : "",
        state: "open" as const,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return toolResult(pullJson(forge, repo, pull));
    }
    case "merge_pull_request": {
      const repo = findRepo(forge, args);
      if (!repo) return toolError("repository not found");
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return toolError("pull request not found");
      if (pull.merged) return toolError("pull request is already merged");
      const sha = mergePullRequest(forge, repo, pull);
      if (sha === null) return toolError("pull request has merge conflicts");
      return toolResult({ sha, merged: true, message: "Pull Request successfully merged", pull_request: pullJson(forge, repo, pull) });
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

interface RpcResponse {
  status: number;
  body?: unknown;
}

function rpcResult(id: unknown, result: unknown): RpcResponse {
  return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcResponse {
  return { status, body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } } };
}

function handleOne(forge: Forge, request: Record<string, unknown>): RpcResponse {
  const method = typeof request.method === "string" ? request.method : "";
  const id = request.id;
  const params = (typeof request.params === "object" && request.params !== null
    ? request.params
    : {}) as Record<string, unknown>;

  if (method.startsWith("notifications/")) return { status: 202 };

  switch (method) {
    case "server/discover":
      return rpcResult(id, discoverResult());
    case "initialize":
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, TOOLS_LIST_RESULT);
    case "tools/call": {
      const toolName = typeof params.name === "string" ? params.name : "";
      const args = (typeof params.arguments === "object" && params.arguments !== null
        ? params.arguments
        : {}) as Record<string, unknown>;
      const result = callTool(forge, toolName, args);
      if (result === null) return rpcError(id, -32602, `unknown tool '${toolName}'`);
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `method '${method}' not found`);
  }
}

export function handleMcp(forge: Forge, body: Buffer): RpcResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => handleOne(forge, entry as Record<string, unknown>))
      .filter((response) => response.body !== undefined)
      .map((response) => response.body);
    return { status: 200, body: responses };
  }
  if (parsed === null || typeof parsed !== "object") {
    return rpcError(null, -32600, "Invalid Request", 400);
  }
  return handleOne(forge, parsed as Record<string, unknown>);
}
