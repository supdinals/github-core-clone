/**
 * forge.ts — the forge's core: an in-memory git object store, the repository
 * model (refs, issues, pull requests, labels) and the packfile codec.
 *
 * Everything lives in RAM: a trial starts empty, the suite builds all of its
 * fixtures through the public surfaces, and nothing has to survive a restart.
 * Object ids are plain SHA-1 over `"<type> <len>\0" + data`, exactly like git.
 */
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

export const ZERO_OID = "0000000000000000000000000000000000000000";
export const OID_RE = /^[0-9a-f]{40}$/;

export type ObjectType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

export function sha1Hex(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

/** The git object id of a payload: sha1 of the `<type> <len>\0` header + data. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, "utf8");
  return sha1Hex(Buffer.concat([header, data]));
}

// ---------------------------------------------------------------------------
// commits, trees, tags
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? "" : text.slice(split + 2);
  let tree = ZERO_OID;
  let author = "";
  let committer = "";
  const parents: string[] = [];
  for (const line of header.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) author = line.slice(7);
    else if (line.startsWith("committer ")) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function serializeCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`);
  return Buffer.from(`${lines.join("\n")}\n\n${info.message}`, "utf8");
}

/** Extract the unix timestamp from an ident line (`Name <mail> 1234 +0000`). */
export function identTimestamp(ident: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(ident);
  return match ? Number(match[1]) : 0;
}

export function formatIdent(name: string, email: string, timestamp: number): string {
  return `${name} <${email}> ${timestamp} +0000`;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString("ascii", offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString("utf8", space + 1, nul);
    const oid = data.toString("hex", nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git orders tree entries by name, directories as if suffixed with `/`. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === "40000" ? `${entry.name}/` : entry.name;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"));
    parts.push(Buffer.from(entry.oid, "hex"));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const header = split === -1 ? text : text.slice(0, split);
  const info: TagInfo = { object: ZERO_OID, type: "commit", tag: "", tagger: "", message: split === -1 ? "" : text.slice(split + 2) };
  for (const line of header.split("\n")) {
    if (line.startsWith("object ")) info.object = line.slice(7).trim();
    else if (line.startsWith("type ")) info.type = line.slice(5).trim();
    else if (line.startsWith("tag ")) info.tag = line.slice(4).trim();
    else if (line.startsWith("tagger ")) info.tagger = line.slice(7);
  }
  return info;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

/** Inflate one zlib stream starting at `offset`; also report bytes consumed. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git binary delta (`base` -> result described by `delta`). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error("delta base size mismatch");
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error("delta opcode 0 is reserved");
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error("delta target size mismatch");
  return result;
}

interface PackEntry {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

/**
 * Read a whole packfile into an oid -> object map, resolving OFS and REF
 * deltas against bases inside the pack or, for REF deltas, `external` bases.
 */
export function readPack(pack: Buffer, external?: Map<string, GitObject>): Map<string, GitObject> {
  if (pack.length < 12 + 20 || pack.toString("ascii", 0, 4) !== "PACK") {
    throw new Error("not a packfile");
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const entriesByOffset = new Map<number, PackEntry>();
  const pending: { offset: number; baseOffset?: number; baseOid?: string; delta: Buffer }[] = [];
  const objects = new Map<string, GitObject>();

  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base entry, in git's quirky varint.
      let back = pack[offset];
      offset += 1;
      let baseOffsetDelta = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset];
        offset += 1;
        baseOffsetDelta = ((baseOffsetDelta + 1) << 7) | (back & 0x7f);
      }
      const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
      if (inflated.data.length !== size) throw new Error("ofs-delta size mismatch");
      offset = inflated.next;
      pending.push({ offset: entryOffset, baseOffset: entryOffset - baseOffsetDelta, delta: inflated.data });
    } else if (typeCode === 7) {
      const baseOid = pack.toString("hex", offset, offset + 20);
      offset += 20;
      const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
      if (inflated.data.length !== size) throw new Error("ref-delta size mismatch");
      offset = inflated.next;
      pending.push({ offset: entryOffset, baseOid, delta: inflated.data });
    } else {
      const type = CODE_TYPES[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
      if (inflated.data.length !== size) throw new Error("pack object size mismatch");
      offset = inflated.next;
      const oid = hashObject(type, inflated.data);
      const entry = { oid, type, data: inflated.data };
      entriesByOffset.set(entryOffset, entry);
      objects.set(oid, { type, data: inflated.data });
    }
  }

  // Resolve deltas once every plain entry is known; loop because a delta's
  // base can itself be a delta.
  let unresolved = pending;
  while (unresolved.length) {
    const stillPending: typeof pending = [];
    let progressed = false;
    for (const item of unresolved) {
      let base: PackEntry | undefined;
      if (item.baseOffset !== undefined) base = entriesByOffset.get(item.baseOffset);
      if (!base && item.baseOid !== undefined) {
        const known = objects.get(item.baseOid) ?? external?.get(item.baseOid);
        if (known) base = { oid: item.baseOid, type: known.type, data: known.data };
      }
      if (!base) {
        stillPending.push(item);
        continue;
      }
      const data = applyDelta(base.data, item.delta);
      const oid = hashObject(base.type, data);
      const entry = { oid, type: base.type, data };
      entriesByOffset.set(item.offset, entry);
      objects.set(oid, { type: base.type, data });
      progressed = true;
    }
    if (!progressed) throw new Error("pack delta base is missing");
    unresolved = stillPending;
  }
  return objects;
}

function packEntryHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write objects as a version-2 packfile of plain (undeltified) entries. */
export function writePack(objects: Iterable<{ type: ObjectType; data: Buffer }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash("sha1").update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// repository model
// ---------------------------------------------------------------------------

export interface Viewer {
  login: string;
  id: number;
  name: string;
  email: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  comments: Comment[];
  createdAt: number;
  updatedAt: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: number;
  updatedAt: number;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: number;
  updatedAt: number;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, PullRequest>();
  nextNumber = 1;
  /** Bump on any git-state change; fetch responses cache against it. */
  generation = 0;

  touch(): void {
    this.generation += 1;
  }

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, now: number) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = "main";
    this.createdAt = now;
    this.updatedAt = now;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  get headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  store(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Follow tag objects until a non-tag object; undefined if it dead-ends. */
  peel(oid: string): string | undefined {
    let current = oid;
    for (let hops = 0; hops < 32; hops += 1) {
      const object = this.objects.get(current);
      if (!object) return undefined;
      if (object.type !== "tag") return current;
      current = parseTag(object.data).object;
    }
    return undefined;
  }

  /** Follow tags until a commit; undefined when the chain does not reach one. */
  peelToCommit(oid: string): string | undefined {
    const peeled = this.peel(oid);
    if (peeled === undefined) return undefined;
    return this.objects.get(peeled)?.type === "commit" ? peeled : undefined;
  }

  commitOf(oid: string): CommitInfo | undefined {
    const object = this.objects.get(oid);
    return object?.type === "commit" ? parseCommit(object.data) : undefined;
  }

  /** All commit oids reachable from `tip`, tip first, breadth-first. */
  commitHistory(tip: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      const commit = this.commitOf(oid);
      if (!commit) continue;
      seen.add(oid);
      order.push(oid);
      for (const parent of commit.parents) queue.push(parent);
    }
    return order;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(oid);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The best common ancestor of two commits, or undefined if unrelated. */
  mergeBase(a: string, b: string): string | undefined {
    const ancestorsOfA = new Map<string, number>();
    const queueA: [string, number][] = [[a, 0]];
    while (queueA.length) {
      const [oid, depth] = queueA.shift() as [string, number];
      if (ancestorsOfA.has(oid)) continue;
      const commit = this.commitOf(oid);
      if (!commit) continue;
      ancestorsOfA.set(oid, depth);
      for (const parent of commit.parents) queueA.push([parent, depth + 1]);
    }
    const seen = new Set<string>();
    const queueB: [string, number][] = [[b, 0]];
    let best: string | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    while (queueB.length) {
      const [oid, depth] = queueB.shift() as [string, number];
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(oid);
      if (!commit) continue;
      const depthA = ancestorsOfA.get(oid);
      if (depthA !== undefined && depthA + depth < bestScore) {
        best = oid;
        bestScore = depthA + depth;
      }
      for (const parent of commit.parents) queueB.push([parent, depth + 1]);
    }
    return best;
  }

  /** Flatten a tree (recursively) into path -> {mode, oid}. */
  flattenTree(treeOid: string, prefix = "", out = new Map<string, TreeEntry & { path: string }>()): Map<string, TreeEntry & { path: string }> {
    const object = this.objects.get(treeOid);
    if (!object || object.type !== "tree") return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === "40000") this.flattenTree(entry.oid, path, out);
      else out.set(path, { ...entry, path });
    }
    return out;
  }

  treeOfCommit(commitOid: string): Map<string, TreeEntry & { path: string }> {
    const commit = this.commitOf(commitOid);
    if (!commit) return new Map();
    return this.flattenTree(commit.tree);
  }

  /**
   * Build (and store) a tree hierarchy from a flat path -> blob map.
   * Returns the root tree oid. Empty map yields the empty tree.
   */
  buildTree(files: Map<string, { mode: string; oid: string }>): string {
    interface Dir {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const segments = path.split("/");
      let dir = root;
      for (const segment of segments.slice(0, -1)) {
        let next = dir.dirs.get(segment);
        if (!next) {
          next = { files: new Map(), dirs: new Map() };
          dir.dirs.set(segment, next);
        }
        dir = next;
      }
      dir.files.set(segments[segments.length - 1], file);
    }
    const emit = (dir: Dir): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, sub] of dir.dirs) entries.push({ mode: "40000", name, oid: emit(sub) });
      return this.store("tree", serializeTree(entries));
    };
    return emit(root);
  }

  tipOf(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }
}

// ---------------------------------------------------------------------------
// three-way merge planning (shared by REST, GraphQL and MCP merges)
// ---------------------------------------------------------------------------

export interface MergePlan {
  conflict: boolean;
  /** path -> blob entry to write, or null to delete the path. */
  changes: Map<string, { mode: string; oid: string } | null>;
}

/**
 * Compare merge-base, head and the current base tip file by file. A path
 * conflicts when head and base both changed it away from the merge-base in
 * different ways; otherwise the head side wins wherever it changed anything.
 */
export function planMerge(repo: Repo, mergeBaseOid: string | undefined, headOid: string, baseTipOid: string): MergePlan {
  const baseFiles = mergeBaseOid ? repo.treeOfCommit(mergeBaseOid) : new Map<string, TreeEntry & { path: string }>();
  const headFiles = repo.treeOfCommit(headOid);
  const tipFiles = repo.treeOfCommit(baseTipOid);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  const changes = new Map<string, { mode: string; oid: string } | null>();
  let conflict = false;
  const same = (x?: { oid: string }, y?: { oid: string }): boolean => x?.oid === y?.oid;
  for (const path of paths) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    const inTip = tipFiles.get(path);
    const headChanged = !same(inBase, inHead);
    const tipChanged = !same(inBase, inTip);
    if (headChanged && tipChanged && !same(inHead, inTip)) {
      conflict = true;
      continue;
    }
    if (headChanged) {
      changes.set(path, inHead ? { mode: inHead.mode, oid: inHead.oid } : null);
    }
  }
  return { conflict, changes };
}

/** Count added/removed lines between two texts with a small LCS diff. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText.length ? oldText.split("\n") : [];
  const newLines = newText.length ? newText.split("\n") : [];
  // LCS over lines; fixture files are small, a full table is fine, but guard
  // against pathological sizes with a cheap fallback.
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = oldLines[i] === newLines[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const common = table[0];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

// ---------------------------------------------------------------------------
// the forge root
// ---------------------------------------------------------------------------

const CLOCK_BASE = 1_767_225_600; // 2026-01-01T00:00:00Z

export class Forge {
  readonly viewer: Viewer = {
    login: "adaiversen",
    id: 1000,
    name: "ada iversen",
    email: "adaiversen@example.invalid",
  };

  repos = new Map<string, Repo>();
  private clockTicks = 0;
  private nextRepoId = 1;
  private nextObjectId = 1;
  private nextLabelId = 1;
  private nextCommentId = 1;

  /** Deterministic, strictly increasing timestamps (seconds since epoch). */
  now(): number {
    this.clockTicks += 1;
    return CLOCK_BASE + this.clockTicks;
  }

  newRepoId(): number {
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    return id;
  }

  /** Global database ids for issues and pull requests (GraphQL databaseId). */
  newObjectId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }

  newLabelId(): number {
    const id = this.nextLabelId;
    this.nextLabelId += 1;
    return id;
  }

  newCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo = new Repo(this.newRepoId(), this.viewer.login, name, description, isPrivate, this.now());
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  /** Only the viewer's own repos exist as far as any caller can tell. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.viewer.login) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewer.login) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  viewerIdent(): string {
    return formatIdent(this.viewer.name, this.viewer.email, this.now());
  }
}

// ---------------------------------------------------------------------------
// GraphQL-style global ids: base64 of `Type:databaseId`, opaque and stable.
// ---------------------------------------------------------------------------

export function globalId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`, "utf8").toString("base64");
}

export function parseGlobalId(value: string): { type: string; id: number } | null {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const split = decoded.lastIndexOf(":");
    if (split === -1) return null;
    const id = Number(decoded.slice(split + 1));
    if (!Number.isInteger(id)) return null;
    return { type: decoded.slice(0, split), id };
  } catch {
    return null;
  }
}
