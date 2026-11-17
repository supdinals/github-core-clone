# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/supdinals/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/supdinals/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in a single Node 22 process, built
only on the standard library. One in-memory store backs four surfaces:

- **Git smart HTTP** — protocol v0 and v2 ref advertisement, `ls-refs` with
  ref-prefix filtering, fetch with shallow/deepen support, and receive-pack
  with per-ref `report-status` over side-band-64k. Packfiles are read and
  written natively (including OFS/REF delta resolution on read).
- **REST v3** — repositories, branches, commits, git refs, the contents API,
  labels, issues, comments and pull requests with squash merges and
  three-way conflict detection.
- **GraphQL** — a hand-written parser and executor covering viewer,
  repository, `node`, issue/pull-request connections with cursor pagination,
  the create/close/merge mutations, and `__type` introspection.
- **MCP** — a streamable-HTTP JSON-RPC endpoint (modern `server/discover`
  era, legacy `initialize` fallback) exposing six forge tools that share the
  exact same store, so MCP writes read back identically over REST.

## Running

```sh
npm start
# or
node --experimental-strip-types main.ts
```

The process binds an ephemeral port. Under the make.fun harness it registers
the port with `$MAKEFUN_ENV_URL/register` and serves until the harness flags
the trial done; run standalone it prints the port and serves until killed.
When `MAKEFUN_SHOP_TOKEN` is set, every surface requires
`Authorization: Bearer <token>`.

## Layout

- `main.ts` — process lifecycle: bind, register, serve, exit on done.
- `app.ts` — HTTP routing and authentication across the four surfaces.
- `forge.ts` — the object store, repository model, packfile codec, merge
  planning and line-diff counting.
- `gitproto.ts` — pkt-line framing and the smart-HTTP protocol handlers.
- `rest.ts` — the REST v3 route table and serializers.
- `graphql.ts` — tokenizer, parser, schema tables and executor.
- `mcp.ts` — the JSON-RPC endpoint and tool implementations.
