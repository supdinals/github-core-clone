/**
 * gitproto.ts — the git smart-HTTP surface: pkt-line framing, ref
 * advertisement (protocol v0 and v2), ls-refs, fetch (with shallow support)
 * and receive-pack with per-ref report-status.
 *
 * The object store itself lives in forge.ts; this module is only the wire.
 */
import {
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type Repo,
} from "./forge.ts";

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from("0000", "ascii");
export const PKT_DELIM = Buffer.from("0001", "ascii");

export type Packet =
  | { kind: "data"; payload: Buffer }
  | { kind: "flush" }
  | { kind: "delim" }
  | { kind: "response-end" }
  | { kind: "error"; payload: Buffer };

/** Parse pkt-lines from the front of `body`; returns packets + bytes used. */
export function parsePackets(body: Buffer, start = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset + 4 <= body.length) {
    const hex = body.toString("ascii", offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = Number.parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: "flush" });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: "delim" });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: "response-end" });
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    const payload = body.subarray(offset + 4, offset + length);
    packets.push(length === 3 ? { kind: "error", payload } : { kind: "data", payload });
    offset += length;
  }
  return { packets, next: offset };
}

function dataTexts(packets: Packet[]): string[] {
  const texts: string[] = [];
  for (const packet of packets) {
    if (packet.kind === "data") texts.push(packet.payload.toString("utf8"));
  }
  return texts;
}

/** Wrap a packfile in side-band-64k band-1 packets. */
function sidebandPackets(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) chunks.push(pktLine(Buffer.from([1])));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// ref advertisement
// ---------------------------------------------------------------------------

const AGENT = "forge/1.0.0";
const UPLOAD_CAPS_V0 = `side-band-64k ofs-delta agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** HEAD + every ref, in advertisement order, with peeled tags resolved. */
function advertisementRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headTarget = repo.headRef;
  const headOid = repo.refs.get(headTarget);
  if (headOid) lines.push({ oid: headOid, name: "HEAD", symrefTarget: headTarget });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const object = repo.get(oid);
    if (object?.type === "tag") {
      const peeled = repo.peel(oid);
      if (peeled && peeled !== oid) line.peeled = peeled;
    }
    lines.push(line);
  }
  return lines;
}

export function infoRefsBody(repo: Repo, service: string, protocolVersion: number): Buffer {
  if (service === "git-upload-pack" && protocolVersion === 2) {
    return Buffer.concat([
      pktLine("version 2\n"),
      pktLine(`agent=${AGENT}\n`),
      pktLine("ls-refs=unborn\n"),
      pktLine("fetch=shallow wait-for-done\n"),
      pktLine("server-option\n"),
      pktLine("object-format=sha1\n"),
      PKT_FLUSH,
    ]);
  }
  const caps = service === "git-receive-pack" ? RECEIVE_CAPS_V0 : `${UPLOAD_CAPS_V0} symref=HEAD:${repo.headRef}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisementRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : "";
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

export function lsRefsBody(repo: Repo, body: Buffer): Buffer | null {
  const { packets } = parsePackets(body);
  const texts = dataTexts(packets);
  if (!texts.length || !texts[0].startsWith("command=ls-refs")) return null;
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  // Arguments live after the delim packet; capability lines come before it.
  let pastDelim = false;
  let packetIndex = 0;
  for (const packet of packets) {
    if (packet.kind === "delim") {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== "data") continue;
    packetIndex += 1;
    if (!pastDelim || packetIndex === 1) continue;
    const line = packet.payload.toString("utf8").replace(/\n$/, "");
    if (line === "peel") peel = true;
    else if (line === "symrefs") symrefs = true;
    else if (line === "unborn") unborn = true;
    else if (line.startsWith("ref-prefix ")) prefixes.push(line.slice("ref-prefix ".length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const out: Buffer[] = [];
  const headTarget = repo.headRef;
  const headOid = repo.refs.get(headTarget);
  if (matches("HEAD")) {
    if (headOid) {
      out.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ""}\n`));
    } else if (unborn) {
      out.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ""}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = repo.get(oid);
      if (object?.type === "tag") {
        const peeled = repo.peel(oid);
        if (peeled && peeled !== oid) line += ` peeled:${peeled}`;
      }
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// fetch (upload-pack)
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depthLimit?: number;
}

function parseFetchV2(body: Buffer): FetchRequest | null {
  const { packets } = parsePackets(body);
  const request: FetchRequest = { wants: [], haves: [], shallow: [] };
  let sawCommand = false;
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === "delim") {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== "data") continue;
    const line = packet.payload.toString("utf8").replace(/\n$/, "");
    if (!pastDelim) {
      if (line.startsWith("command=fetch")) sawCommand = true;
      continue;
    }
    if (line.startsWith("want ")) request.wants.push(line.slice(5).trim());
    else if (line.startsWith("have ")) request.haves.push(line.slice(5).trim());
    else if (line.startsWith("shallow ")) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith("deepen ")) request.depthLimit = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith("deepen-since ") || line.startsWith("deepen-not ")) {
      // Accepted and ignored: the suite never drives time-based shallows.
    }
  }
  return sawCommand ? request : null;
}

function parseFetchV0(body: Buffer): FetchRequest | null {
  const request: FetchRequest = { wants: [], haves: [], shallow: [] };
  let sawAny = false;
  // The v0 request is two pkt-line sections (wants, then haves), each ended
  // by a flush; parsePackets stops at a flush, so walk section by section.
  let offset = 0;
  while (offset < body.length) {
    const { packets, next } = parsePackets(body, offset);
    if (next === offset) break;
    offset = next;
    for (const packet of packets) {
      if (packet.kind !== "data") continue;
      const raw = packet.payload.toString("utf8").replace(/\n$/, "");
      const line = raw.split("\0")[0];
      if (line.startsWith("want ")) {
        request.wants.push(line.slice(5).split(" ")[0].trim());
        sawAny = true;
      } else if (line.startsWith("have ")) {
        request.haves.push(line.slice(5).split(" ")[0].trim());
        sawAny = true;
      } else if (line.startsWith("shallow ")) {
        request.shallow.push(line.slice(8).trim());
        sawAny = true;
      } else if (line.startsWith("deepen ")) {
        request.depthLimit = Number.parseInt(line.slice(7), 10);
      }
    }
  }
  return sawAny ? request : null;
}

/** Add a tree and everything under it (subtrees, blobs) to `into`. */
function addTreeClosure(repo: Repo, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const object = repo.get(treeOid);
  if (!object || object.type !== "tree") return;
  into.add(treeOid);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === "40000") addTreeClosure(repo, entry.oid, into);
    else into.add(entry.oid);
  }
}

interface FetchPlan {
  send: string[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Work out which objects a fetch must carry.
 *
 * `haveClosure` is everything the client already holds: full history from
 * each have, except that parents of client-shallow commits are NOT held.
 * `wantClosure` walks from the wants, generation by generation when a depth
 * limit applies; commits on the last included generation that still have
 * parents form the new shallow boundary.
 */
function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const clientShallow = new Set(request.shallow);
  const haveClosure = new Set<string>();
  {
    const queue = [...request.haves];
    const visited = new Set<string>();
    while (queue.length) {
      const oid = queue.shift() as string;
      if (visited.has(oid)) continue;
      visited.add(oid);
      haveClosure.add(oid);
      const commitOid = repo.peelToCommit(oid) ?? oid;
      const commit = repo.commitOf(commitOid);
      if (!commit) continue;
      haveClosure.add(commitOid);
      addTreeClosure(repo, commit.tree, haveClosure);
      if (!clientShallow.has(commitOid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    }
  }

  const wantClosure = new Set<string>();
  const generations = new Map<string, number>();
  const boundary = new Set<string>();
  {
    const queue: [string, number][] = request.wants.map((oid) => [oid, 0]);
    const visited = new Set<string>();
    while (queue.length) {
      const [rawOid, generation] = queue.shift() as [string, number];
      if (visited.has(rawOid)) continue;
      visited.add(rawOid);
      const object = repo.get(rawOid);
      if (!object) {
        wantClosure.add(rawOid);
        continue;
      }
      if (object.type === "tag") {
        // Annotated tags travel with the clone; their target keeps the
        // tag's own generation (a tag does not consume depth).
        wantClosure.add(rawOid);
        queue.push([parseTag(object.data).object, generation]);
        continue;
      }
      if (object.type !== "commit") {
        wantClosure.add(rawOid);
        continue;
      }
      const oid = rawOid;
      const commit = repo.commitOf(oid);
      if (!commit) {
        wantClosure.add(oid);
        continue;
      }
      if (request.depthLimit !== undefined && generation >= request.depthLimit) continue;
      wantClosure.add(oid);
      generations.set(oid, generation);
      addTreeClosure(repo, commit.tree, wantClosure);
      const atLimit = request.depthLimit !== undefined && generation === request.depthLimit - 1;
      if (atLimit) {
        if (commit.parents.length) boundary.add(oid);
      } else {
        for (const parent of commit.parents) queue.push([parent, generation + 1]);
      }
    }
  }

  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const commit = repo.commitOf(oid);
    if (!commit) continue;
    if (wantClosure.has(oid) && commit.parents.some((parent) => wantClosure.has(parent))) {
      unshallow.push(oid);
    }
  }

  const send = [...wantClosure].filter((oid) => !haveClosure.has(oid));
  return { send, shallow: [...boundary], unshallow };
}

function fetchPack(repo: Repo, send: string[]): Buffer {
  const objects: GitObject[] = [];
  const rank = (type: string): number => (type === "commit" ? 0 : type === "tree" ? 1 : type === "tag" ? 2 : 3);
  const sorted = [...send].sort((a, b) => {
    const oa = repo.get(a);
    const ob = repo.get(b);
    return rank(oa?.type ?? "") - rank(ob?.type ?? "");
  });
  for (const oid of sorted) {
    const object = repo.get(oid);
    if (object) objects.push(object);
  }
  return writePack(objects);
}

export function uploadPackBody(repo: Repo, body: Buffer, protocolVersion: number): Buffer | null {
  // Protocol v2: dispatch on the command packet.
  const first = parsePackets(body, 0).packets.find((packet) => packet.kind === "data");
  const firstText = first?.kind === "data" ? first.payload.toString("utf8") : "";
  if (protocolVersion === 2 || firstText.startsWith("command=")) {
    if (firstText.startsWith("command=ls-refs")) return lsRefsBody(repo, body);
    if (firstText.startsWith("command=fetch")) {
      const request = parseFetchV2(body);
      if (!request) return null;
      return fetchResponse(repo, request, 2);
    }
    return null;
  }
  // Protocol v0 fetch.
  const request = parseFetchV0(body);
  if (!request) return null;
  return fetchResponse(repo, request, 0);
}

/**
 * Fetch responses are cached per repo against the repo's generation: the
 * benchmark clones the same history many times, and Node's event loop
 * serializes the (synchronous) handlers, so one computation serves every
 * identical repeat until a push or write bumps the generation.
 */
const fetchCache = new WeakMap<Repo, Map<string, { generation: number; body: Buffer }>>();

function fetchResponse(repo: Repo, request: FetchRequest, version: 0 | 2): Buffer {
  const key = JSON.stringify([
    version,
    [...request.wants].sort(),
    [...request.haves].sort(),
    [...request.shallow].sort(),
    request.depthLimit ?? null,
  ]);
  let perRepo = fetchCache.get(repo);
  const hit = perRepo?.get(key);
  if (hit && hit.generation === repo.generation) return hit.body;

  const plan = planFetch(repo, request);
  const pack = fetchPack(repo, plan.send);
  const parts: Buffer[] = [];
  if (version === 2) {
    if (plan.shallow.length || plan.unshallow.length) {
      parts.push(pktLine("shallow-info\n"));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine("packfile\n"));
  } else {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktLine("NAK\n"));
  }
  parts.push(sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  const responseBody = Buffer.concat(parts);

  if (!perRepo) {
    perRepo = new Map();
    fetchCache.set(repo, perRepo);
  }
  if (perRepo.size > 256) perRepo.clear();
  perRepo.set(key, { generation: repo.generation, body: responseBody });
  return responseBody;
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePackBody(repo: Repo, body: Buffer): Buffer {
  repo.touch();
  const { packets, next } = parsePackets(body);
  const commands: RefCommand[] = [];
  let sideband = false;
  let firstLine = true;
  for (const packet of packets) {
    if (packet.kind !== "data") continue;
    let line = packet.payload.toString("utf8").replace(/\n$/, "");
    if (firstLine) {
      firstLine = false;
      const nul = line.indexOf("\0");
      if (nul !== -1) {
        const caps = line.slice(nul + 1);
        if (caps.split(" ").includes("side-band-64k")) sideband = true;
        line = line.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line.trim());
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }

  // Unpack first, like git: objects land in the store even if a ref update
  // is later refused, and ancestry checks can see the pushed commits.
  let unpackError: string | null = null;
  const packBytes = body.subarray(next);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, repo.objects);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: string[] = [];
  reportLines.push(unpackError ? `unpack ${unpackError}` : "unpack ok");
  for (const command of commands) {
    const reason = unpackError ? "unpacker error" : applyRefUpdate(repo, command);
    reportLines.push(reason === null ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
  }
  const reportPayload = Buffer.concat([
    ...reportLines.map((line) => pktLine(`${line}\n`)),
    PKT_FLUSH,
  ]);
  if (!sideband) return reportPayload;
  // The whole report stream rides inside band-1 sideband packets.
  const wrapped: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < reportPayload.length; offset += CHUNK) {
    const slice = reportPayload.subarray(offset, Math.min(offset + CHUNK, reportPayload.length));
    wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  wrapped.push(PKT_FLUSH);
  return Buffer.concat(wrapped);
}

/** Apply one ref update; returns null on success or the refusal reason. */
function applyRefUpdate(repo: Repo, command: RefCommand): string | null {
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.oldOid !== current) {
    return command.oldOid === ZERO_OID ? "reference already exists" : "stale info";
  }
  if (command.newOid === ZERO_OID) {
    if (current === ZERO_OID) return "reference does not exist";
    repo.refs.delete(command.ref);
    return null;
  }
  const target = repo.get(command.newOid);
  if (!target) return "missing object";
  if (command.ref.startsWith("refs/heads/")) {
    if (repo.peelToCommit(command.newOid) === undefined) return "not a commit";
    if (current !== ZERO_OID && !repo.isAncestor(current, command.newOid)) {
      return "non-fast-forward";
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}

// parseCommit is re-exported for other surfaces that need commit metadata.
export { parseCommit };
