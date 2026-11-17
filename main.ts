/**
 * Entry point for the forge.
 *
 * The harness starts this file as `node main.ts`, reads the port we register,
 * drives the server over HTTP, and finally flips a done flag; our job is to
 * bind an ephemeral port, announce it, serve until told to stop, and exit 0.
 *
 * When MAKEFUN_ENV_URL is absent (a plain local run) we simply serve forever
 * and print the port, which is how the SDK's local runner is used in dev.
 */
import { createServer, type Server } from "node:http";

import { createForgeHandler } from "./app.ts";

const REGISTER_ATTEMPTS = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One JSON request against the harness control plane, with a hard timeout. */
async function controlRequest(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`control plane answered HTTP ${response.status} for ${url}`);
  }
  const text = await response.text();
  return text.length ? JSON.parse(text) : {};
}

/** POST our port to $MAKEFUN_ENV_URL/register, backing off between attempts. */
async function registerPort(base: string, port: number): Promise<void> {
  let delay = 250;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt += 1) {
    try {
      await controlRequest(`${base}/register`, {
        method: "POST",
        body: JSON.stringify({ port }),
      });
      return;
    } catch (err) {
      lastError = err;
      await sleep(delay);
      delay = Math.min(delay * 2, 2_000);
    }
  }
  throw new Error(`could not register the port with the harness: ${String(lastError)}`);
}

/** Long-poll $MAKEFUN_ENV_URL/done until the harness says the trial is over. */
async function waitForDone(base: string): Promise<void> {
  for (;;) {
    try {
      const state = (await controlRequest(`${base}/done`)) as { done?: unknown };
      if (state && state.done === true) return;
    } catch {
      // A flaky control plane must not kill the forge mid-trial; keep polling.
    }
    await sleep(250);
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function main(): Promise<void> {
  const server = createServer(createForgeHandler());
  const port = await listen(server);
  const controlBase = process.env.MAKEFUN_ENV_URL;

  if (!controlBase) {
    // Local development: no harness, serve until killed.
    process.stdout.write(`forge listening on http://127.0.0.1:${port}\n`);
    return;
  }

  await registerPort(controlBase.replace(/\/$/, ""), port);
  await waitForDone(controlBase.replace(/\/$/, ""));

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
