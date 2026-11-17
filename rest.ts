/**
 * rest.ts — the GitHub REST v3 surface the suite drives: meta, the viewer,
 * repositories, branches, commits, git refs, the contents API, labels,
 * issues, comments and pull requests (including squash merges).
 *
 * Handlers are pure functions over the Forge store: app.ts adapts HTTP to
 * the ApiRequest/ApiResponse pair used here.
 */
import {
  globalId,
  identTimestamp,
  lineDiffCounts,
  parseCommit,
  parseTree,
  planMerge,
  serializeCommit,
  ZERO_OID,
  type Forge,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
  type TreeEntry,
} from "./forge.ts";

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Buffer;
  host: string;
}

export interface ApiResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function fail(status: number, message: string): ApiResponse {
  return { status, body: { message, documentation_url: "https://docs.github.com/rest" } };
}

function notFound(): ApiResponse {
  return fail(404, "Not Found");
}

/** Parse a JSON request body; `{}` for an empty body, null when malformed. */
function jsonBody(req: ApiRequest): Record<string, unknown> | null {
  const text = req.body.toString("utf8").trim();
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// ---------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------

export function userJson(forge: Forge): Record<string, unknown> {
  const viewer = forge.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: globalId("User", viewer.id),
    type: "User",
    site_admin: false,
    name: viewer.name,
    email: viewer.email,
  };
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId("Repository", repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(forge),
    private: repo.isPrivate,
    html_url: `https://forge.local/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `https://forge.local/api/v3/repos/${repo.fullName}`,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.updatedAt),
    pushed_at: iso(repo.updatedAt),
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? "private" : "public",
    archived: false,
    disabled: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId("Label", label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId("Issue", issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is Label => label !== undefined)
      .map(labelJson),
    user: userJson(forge),
    comments: issue.comments.length,
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    closed_at: issue.state === "closed" ? iso(issue.updatedAt) : null,
    html_url: `https://forge.local/${repo.fullName}/issues/${issue.number}`,
    url: `https://forge.local/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `https://forge.local/api/v3/repos/${repo.fullName}`,
  };
}

export function commentJson(forge: Forge, comment: { id: number; body: string; createdAt: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId("IssueComment", comment.id),
    body: comment.body,
    user: userJson(forge),
    created_at: iso(comment.createdAt),
    updated_at: iso(comment.createdAt),
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: globalId("PullRequest", pull.id),
    number: pull.number,
    state: pull.merged ? "closed" : pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt !== null ? iso(pull.mergedAt) : null,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: userJson(forge),
      repo: repoJson(forge, repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userJson(forge),
      repo: repoJson(forge, repo),
    },
    user: userJson(forge),
    comments: 0,
    created_at: iso(pull.createdAt),
    updated_at: iso(pull.updatedAt),
    closed_at: pull.state === "closed" || pull.merged ? iso(pull.updatedAt) : null,
    html_url: `https://forge.local/${repo.fullName}/pull/${pull.number}`,
    url: `https://forge.local/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    diff_url: `https://forge.local/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `https://forge.local/${repo.fullName}/pull/${pull.number}.patch`,
    mergeable: null,
    draft: false,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.get(oid);
  const commit = object?.type === "commit" ? parseCommit(object.data) : null;
  const ident = (raw: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(raw);
    if (!match) return { name: raw, email: "", date: iso(0) };
    return { name: match[1], email: match[2], date: iso(Number(match[3])) };
  };
  return {
    sha: oid,
    node_id: globalId("Commit", 0) + oid,
    commit: {
      author: ident(commit?.author ?? ""),
      committer: ident(commit?.committer ?? ""),
      message: commit?.message ?? "",
      tree: { sha: commit?.tree ?? ZERO_OID },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

function paginate<T>(req: ApiRequest, items: T[]): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(Math.max(Number(req.query.get("per_page") ?? 30) || 30, 1), 100);
  const pageNumber = Math.max(Number(req.query.get("page") ?? 1) || 1, 1);
  const start = (pageNumber - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const lastPage = Math.ceil(items.length / perPage);
    const params = new URLSearchParams(req.query);
    const url = (page: number): string => {
      params.set("per_page", String(perPage));
      params.set("page", String(page));
      return `<http://${req.host}${req.path}?${params.toString()}>`;
    };
    headers.link = `${url(pageNumber + 1)}; rel="next", ${url(lastPage)}; rel="last"`;
  }
  return { page: slice, headers };
}

// ---------------------------------------------------------------------------
// repository routes
// ---------------------------------------------------------------------------

function createRepo(forge: Forge, req: ApiRequest): ApiResponse {
  const body = jsonBody(req);
  if (body === null) return fail(400, "Problems parsing JSON");
  const name = str(body.name);
  if (!name || !/^[\w][\w.-]*$/.test(name) || name === "." || name === "..") {
    return fail(422, "Repository creation failed: name is invalid");
  }
  if (forge.getRepo(forge.viewer.login, name)) {
    return fail(422, "Repository creation failed: name already exists on this account");
  }
  const repo = forge.createRepo(name, str(body.description) ?? "", bool(body.private) ?? false);
  if (body.auto_init === true) {
    const blob = repo.store("blob", Buffer.from(`# ${name}\n`, "utf8"));
    const files = new Map<string, { mode: string; oid: string }>([["README.md", { mode: "100644", oid: blob }]]);
    const tree = repo.buildTree(files);
    const ident = forge.viewerIdent();
    const commit = repo.store(
      "commit",
      serializeCommit({ tree, parents: [], author: ident, committer: ident, message: "Initial commit" }),
    );
    repo.refs.set(repo.headRef, commit);
  }
  return { status: 201, body: repoJson(forge, repo) };
}

function patchRepo(forge: Forge, repo: Repo, req: ApiRequest): ApiResponse {
  const body = jsonBody(req);
  if (body === null) return fail(400, "Problems parsing JSON");
  const description = str(body.description);
  if (description !== undefined) repo.description = description;
  const isPrivate = bool(body.private);
  if (isPrivate !== undefined) repo.isPrivate = isPrivate;
  const name = str(body.name);
  if (name !== undefined && name !== repo.name) {
    if (forge.getRepo(repo.owner, name)) return fail(422, "name already exists on this account");
    forge.repos.delete(repo.fullName);
    repo.name = name;
    forge.repos.set(repo.fullName, repo);
  }
  const defaultBranch = str(body.default_branch);
  if (defaultBranch !== undefined) repo.defaultBranch = defaultBranch;
  repo.updatedAt = forge.now();
  return { status: 200, body: repoJson(forge, repo) };
}

function listBranches(repo: Repo): Record<string, unknown>[] {
  return [...repo.refs.keys()]
    .filter((ref) => ref.startsWith("refs/heads/"))
    .sort()
    .map((ref) => ({
      name: ref.slice("refs/heads/".length),
      commit: { sha: repo.refs.get(ref) },
      protected: false,
    }));
}

function listCommits(repo: Repo, req: ApiRequest): ApiResponse {
  const shaParam = req.query.get("sha");
  let tip: string | undefined;
  if (shaParam) {
    tip = repo.refs.get(`refs/heads/${shaParam}`)
      ?? repo.refs.get(`refs/tags/${shaParam}`)
      ?? repo.refs.get(shaParam)
      ?? (repo.get(shaParam)?.type === "commit" ? shaParam : repo.peelToCommit(shaParam));
  } else {
    tip = repo.refs.get(repo.headRef);
  }
  if (!tip) return { status: 200, body: [] };
  const history = repo.commitHistory(tip);
  const decorated = history.map((oid, index) => {
    const commit = repo.commitOf(oid);
    return { oid, index, time: commit ? identTimestamp(commit.committer) : 0 };
  });
  decorated.sort((a, b) => b.time - a.time || a.index - b.index);
  const { page, headers } = paginate(req, decorated);
  return { status: 200, body: page.map((entry) => commitJson(repo, entry.oid)), headers };
}

// ---------------------------------------------------------------------------
// git refs routes
// ---------------------------------------------------------------------------

function createRef(forge: Forge, repo: Repo, req: ApiRequest): ApiResponse {
  const body = jsonBody(req);
  if (body === null) return fail(400, "Problems parsing JSON");
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (!ref || !ref.startsWith("refs/") || !sha) return fail(422, "Invalid ref or sha");
  const target = repo.get(sha);
  if (!target) return fail(422, "Object does not exist");
  if (ref.startsWith("refs/heads/") && repo.peelToCommit(sha) === undefined) {
    return fail(422, "Object is not a commit");
  }
  if (repo.refs.has(ref)) return fail(422, "Reference already exists");
  repo.refs.set(ref, sha);
  repo.updatedAt = forge.now();
  repo.touch();
  return {
    status: 201,
    body: { ref, node_id: globalId("Ref", repo.id), object: { sha, type: target.type } },
  };
}

function getRef(repo: Repo, ref: string): ApiResponse {
  const sha = repo.refs.get(ref);
  if (!sha) return notFound();
  const target = repo.get(sha);
  return {
    status: 200,
    body: { ref, node_id: globalId("Ref", repo.id), object: { sha, type: target?.type ?? "commit" } },
  };
}

// ---------------------------------------------------------------------------
// contents API
// ---------------------------------------------------------------------------

type PathNode =
  | { kind: "file"; oid: string; mode: string }
  | { kind: "dir"; oid: string; entries: (TreeEntry & { path: string })[] };

/** Resolve a slash path inside a tree to a file or a directory listing. */
function resolvePath(repo: Repo, treeOid: string, segments: string[]): PathNode | null {
  let current = treeOid;
  for (let depth = 0; depth < segments.length; depth += 1) {
    const object = repo.get(current);
    if (!object || object.type !== "tree") return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[depth]);
    if (!entry) return null;
    if (depth === segments.length - 1) {
      if (entry.mode === "40000") {
        const dirObject = repo.get(entry.oid);
        if (!dirObject || dirObject.type !== "tree") return null;
        const children = parseTree(dirObject.data).map((child) => ({
          ...child,
          path: segments.join("/"),
        }));
        return { kind: "dir", oid: entry.oid, entries: children };
      }
      return { kind: "file", oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== "40000") return null;
    current = entry.oid;
  }
  // Empty path: the root directory itself.
  const object = repo.get(current);
  if (!object || object.type !== "tree") return null;
  return { kind: "dir", oid: current, entries: parseTree(object.data).map((child) => ({ ...child, path: "" })) };
}

function contentEntryJson(repo: Repo, path: string, name: string, oid: string, mode: string): Record<string, unknown> {
  const isDir = mode === "40000";
  const object = repo.get(oid);
  return {
    name,
    path,
    sha: oid,
    size: isDir ? 0 : object?.data.length ?? 0,
    type: isDir ? "dir" : "file",
    encoding: isDir ? undefined : "base64",
  };
}

function getContents(repo: Repo, segments: string[], req: ApiRequest): ApiResponse {
  const refName = req.query.get("ref") ?? repo.defaultBranch;
  const tip = repo.branchTip(refName);
  if (!tip) return notFound();
  const commit = repo.commitOf(tip);
  if (!commit) return notFound();
  const node = resolvePath(repo, commit.tree, segments);
  if (!node) return notFound();
  if (node.kind === "file") {
    const blob = repo.get(node.oid);
    if (!blob) return notFound();
    const name = segments[segments.length - 1];
    return {
      status: 200,
      body: {
        ...contentEntryJson(repo, segments.join("/"), name, node.oid, node.mode),
        content: blob.data.toString("base64"),
        encoding: "base64",
      },
    };
  }
  const base = segments.join("/");
  const listing = node.entries.map((entry) => {
    const childPath = base ? `${base}/${entry.name}` : entry.name;
    return contentEntryJson(repo, childPath, entry.name, entry.oid, entry.mode);
  });
  return { status: 200, body: listing };
}

/** Commit a flattened file map onto a branch, creating the branch if asked. */
function commitFiles(
  forge: Forge,
  repo: Repo,
  branch: string,
  files: Map<string, { mode: string; oid: string }>,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  let parent = repo.refs.get(ref);
  if (parent === undefined && branch !== repo.defaultBranch) {
    // A contents write to a fresh branch starts from the default branch tip.
    parent = repo.refs.get(repo.headRef);
  }
  const tree = repo.buildTree(files);
  const ident = forge.viewerIdent();
  const commit = repo.store(
    "commit",
    serializeCommit({
      tree,
      parents: parent ? [parent] : [],
      author: ident,
      committer: ident,
      message,
    }),
  );
  repo.refs.set(ref, commit);
  repo.updatedAt = forge.now();
  repo.touch();
  return commit;
}

function flatFilesOf(repo: Repo, branch: string): Map<string, { mode: string; oid: string }> {
  const tip = repo.branchTip(branch) ?? (branch !== repo.defaultBranch ? repo.refs.get(repo.headRef) : undefined);
  const files = new Map<string, { mode: string; oid: string }>();
  if (!tip) return files;
  for (const [path, entry] of repo.treeOfCommit(tip)) {
    files.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return files;
}

function putContents(forge: Forge, repo: Repo, segments: string[], req: ApiRequest): ApiResponse {
  const body = jsonBody(req);
  if (body === null) return fail(400, "Problems parsing JSON");
  const message = str(body.message);
  const content = str(body.content);
  if (message === undefined || content === undefined) return fail(422, "message and content are required");
  const branch = str(body.branch) ?? repo.defaultBranch;
  const path = segments.join("/");
  if (!path) return fail(422, "path is required");
  const files = flatFilesOf(repo, branch);
  const existing = files.get(path);
  const expectedSha = str(body.sha);
  if (expectedSha !== undefined && (!existing || existing.oid !== expectedSha)) {
    return fail(409, `${path} does not match ${expectedSha}`);
  }
  if (existing && expectedSha === undefined) {
    return fail(422, "sha is required when updating a file");
  }
  let data: Buffer;
  try {
    data = Buffer.from(content.replace(/\s/g, ""), "base64");
  } catch {
    return fail(422, "content is not valid base64");
  }
  const blobOid = repo.store("blob", data);
  files.set(path, { mode: existing?.mode ?? "100644", oid: blobOid });
  const commitSha = commitFiles(forge, repo, branch, files, message);
  const commit = repo.commitOf(commitSha);
  return {
    status: existing ? 200 : 201,
    body: {
      content: {
        name: segments[segments.length - 1],
        path,
        sha: blobOid,
        size: data.length,
        type: "file",
        encoding: "base64",
      },
      commit: {
        sha: commitSha,
        message,
        author: { name: forge.viewer.name, email: forge.viewer.email, date: iso(forge.now()) },
        tree: { sha: commit?.tree ?? ZERO_OID },
      },
    },
  };
}

function deleteContents(forge: Forge, repo: Repo, segments: string[], req: ApiRequest): ApiResponse {
  const body = jsonBody(req);
  if (body === null) return fail(400, "Problems parsing JSON");
  const message = str(body.message);
  const sha = str(body.sha);
  if (message === undefined || sha === undefined) return fail(422, "message and sha are required");
  const branch = str(body.branch) ?? repo.defaultBranch;
  const path = segments.join("/");
  const files = flatFilesOf(repo, branch);
  const existing = files.get(path);
  if (!existing) return notFound();
  if (existing.oid !== sha) return fail(409, `${path} does not match ${sha}`);
  files.delete(path);
  const commitSha = commitFiles(forge, repo, branch, files, message);
  return { status: 200, body: { content: null, commit: { sha: commitSha, message } } };
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

function createLabel(forge: Forge, repo: Repo, req: ApiRequest): ApiResponse {
  const body = jsonBody(req);
  if (body === null) return fail(400, "Problems parsing JSON");
  const name = str(body.name);
  if (!name) return fail(422, "name is required");
  if (repo.labels.has(name)) return fail(422, `Label '${name}' already exists`);
  const color = (str(body.color) ?? "ededed").replace(/^#/, "").toLowerCase();
  const label: Label = {
    id: forge.newLabelId(),
    name,
    color,
    description: str(body.description) ?? "",
  };
  repo.labels.set(name, label);
  return { status: 201, body: labelJson(label) };
}

// ---------------------------------------------------------------------------
// issues and comments
// ---------------------------------------------------------------------------

function sortedIssues(repo: Repo, req: ApiRequest): Issue[] {
  const state = req.query.get("state") ?? "open";
  let issues = [...repo.issues.values()];
  if (state === "open") issues = issues.filter((issue) => issue.state === "open");
  else if (state === "closed") issues = issues.filter((issue) => issue.state === "closed");
  const direction = req.query.get("direction") ?? "desc";
  issues.sort((a, b) => (direction === "asc" ? a.number - b.number : b.number - a.number));
  return issues;
}

function createIssue(forge: Forge, repo: Repo, req: ApiRequest): ApiResponse {
  const body = jsonBody(req);
  if (body === null) return fail(400, "Problems parsing JSON");
  const title = str(body.title);
  if (!title) return fail(422, "title is required");
  const labelNames: string[] = [];
  if (Array.isArray(body.labels)) {
    for (const raw of body.labels) {
      const name = typeof raw === "string" ? raw : str((raw as Record<string, unknown>)?.name);
      if (name === undefined) return fail(422, "labels must be names");
      if (!repo.labels.has(name)) return fail(422, `Label '${name}' does not exist in this repository`);
      labelNames.push(name);
    }
  }
  const now = forge.now();
  const issue: Issue = {
    id: forge.newObjectId(),
    number: repo.nextNumber,
    title,
    body: str(body.body) ?? "",
    state: "open",
    labels: labelNames,
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return { status: 201, body: issueJson(forge, repo, issue) };
}

function patchIssue(forge: Forge, repo: Repo, issue: Issue, req: ApiRequest): ApiResponse {
  const body = jsonBody(req);
  if (body === null) return fail(400, "Problems parsing JSON");
  const title = str(body.title);
  if (title !== undefined) issue.title = title;
  const text = str(body.body);
  if (text !== undefined) issue.body = text;
  const state = str(body.state);
  if (state === "closed" || state === "open") issue.state = state;
  if (Array.isArray(body.labels)) {
    const names: string[] = [];
    for (const raw of body.labels) {
      const name = typeof raw === "string" ? raw : str((raw as Record<string, unknown>)?.name);
      if (name === undefined || !repo.labels.has(name)) return fail(422, "unknown label");
      names.push(name);
    }
    issue.labels = names;
  }
  issue.updatedAt = forge.now();
  return { status: 200, body: issueJson(forge, repo, issue) };
}

/** Issues and PRs share one comment stream per number, like GitHub. */
function commentTarget(repo: Repo, number: number): { comments: Issue["comments"] } | undefined {
  return repo.issues.get(number) ?? repo.pulls.get(number);
}

function addComment(forge: Forge, repo: Repo, number: number, req: ApiRequest): ApiResponse {
  const body = jsonBody(req);
  if (body === null) return fail(400, "Problems parsing JSON");
  const text = str(body.body);
  if (text === undefined) return fail(422, "body is required");
  const target = commentTarget(repo, number);
  if (!target) return notFound();
  const comment = { id: forge.newCommentId(), body: text, createdAt: forge.now() };
  target.comments.push(comment);
  return { status: 201, body: commentJson(forge, comment) };
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

function sortedPulls(repo: Repo, req: ApiRequest): PullRequest[] {
  const state = req.query.get("state") ?? "open";
  let pulls = [...repo.pulls.values()];
  if (state === "open") pulls = pulls.filter((pull) => pull.state === "open" && !pull.merged);
  else if (state === "closed") pulls = pulls.filter((pull) => pull.state === "closed" || pull.merged);
  const direction = req.query.get("direction") ?? "desc";
  pulls.sort((a, b) => (direction === "asc" ? a.number - b.number : b.number - a.number));
  return pulls;
}

function branchName(raw: string): string {
  const colon = raw.indexOf(":");
  return colon === -1 ? raw : raw.slice(colon + 1);
}

function createPull(forge: Forge, repo: Repo, req: ApiRequest): ApiResponse {
  const body = jsonBody(req);
  if (body === null) return fail(400, "Problems parsing JSON");
  const title = str(body.title);
  const headRaw = str(body.head);
  if (!title || !headRaw) return fail(422, "title and head are required");
  const head = branchName(headRaw);
  const base = branchName(str(body.base) ?? repo.defaultBranch);
  const headSha = repo.branchTip(head);
  if (!headSha) return fail(422, `Head ref '${head}' does not exist`);
  const baseSha = repo.branchTip(base);
  if (!baseSha) return fail(422, `Base ref '${base}' does not exist`);
  if (headSha === baseSha) return fail(422, "No commits between branches");
  const now = forge.now();
  const pull: PullRequest = {
    id: forge.newObjectId(),
    number: repo.nextNumber,
    title,
    body: str(body.body) ?? "",
    state: "open",
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
  return { status: 201, body: pullJson(forge, repo, pull) };
}

export interface PullFile {
  filename: string;
  status: "added" | "removed" | "modified";
  additions: number;
  deletions: number;
  headOid?: string;
}

/** The three-dot file diff of a pull request: merge-base tree vs head tree. */
export function pullFiles(repo: Repo, pull: PullRequest): PullFile[] {
  const headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  const mergeBase = repo.mergeBase(headSha, baseSha);
  const fromFiles = mergeBase ? repo.treeOfCommit(mergeBase) : new Map();
  const toFiles = repo.treeOfCommit(headSha);
  const paths = new Set<string>([...fromFiles.keys(), ...toFiles.keys()]);
  const files: PullFile[] = [];
  const textOf = (oid?: string): string => {
    if (!oid) return "";
    const object = repo.get(oid);
    return object ? object.data.toString("utf8") : "";
  };
  for (const path of [...paths].sort()) {
    const from = fromFiles.get(path);
    const to = toFiles.get(path);
    if (from?.oid === to?.oid) continue;
    if (!from && to) {
      const counts = lineDiffCounts("", textOf(to.oid));
      files.push({ filename: path, status: "added", additions: counts.additions, deletions: 0, headOid: to.oid });
    } else if (from && !to) {
      const counts = lineDiffCounts(textOf(from.oid), "");
      files.push({ filename: path, status: "removed", additions: 0, deletions: counts.deletions, headOid: undefined });
    } else if (from && to) {
      const counts = lineDiffCounts(textOf(from.oid), textOf(to.oid));
      files.push({ filename: path, status: "modified", additions: counts.additions, deletions: counts.deletions, headOid: to.oid });
    }
  }
  return files;
}

function listPullFiles(repo: Repo, pull: PullRequest): ApiResponse {
  const files = pullFiles(repo, pull).map((file) => ({
    filename: file.filename,
    sha: file.headOid ?? ZERO_OID,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.additions + file.deletions,
  }));
  return { status: 200, body: files };
}

/**
 * Squash-merge a pull request onto its base branch. Shared by the REST,
 * GraphQL and MCP surfaces so all three agree on conflicts and results.
 * Returns the merge commit sha, or null when the merge conflicts.
 */
export function mergePullRequest(forge: Forge, repo: Repo, pull: PullRequest): string | null {
  const headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  if (repo.isAncestor(headSha, baseSha)) {
    // Everything on the head is already on the base: nothing to write.
    pull.merged = true;
    pull.mergedAt = forge.now();
    pull.mergeCommitSha = baseSha;
    pull.state = "closed";
    pull.updatedAt = forge.now();
    return baseSha;
  }
  const mergeBase = repo.mergeBase(headSha, baseSha);
  const plan = planMerge(repo, mergeBase, headSha, baseSha);
  if (plan.conflict) return null;
  const files = flatFilesOf(repo, pull.baseRef);
  for (const [path, change] of plan.changes) {
    if (change === null) files.delete(path);
    else files.set(path, change);
  }
  const tree = repo.buildTree(files);
  const ident = forge.viewerIdent();
  const message = `${pull.title} (#${pull.number})${pull.body ? `\n\n${pull.body}` : ""}`;
  const commit = repo.store(
    "commit",
    serializeCommit({ tree, parents: [baseSha], author: ident, committer: ident, message }),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  pull.merged = true;
  pull.mergedAt = forge.now();
  pull.mergeCommitSha = commit;
  pull.state = "closed";
  pull.updatedAt = forge.now();
  repo.updatedAt = forge.now();
  repo.touch();
  return commit;
}

/** Would merging this pull request conflict right now? */
export function pullConflicts(repo: Repo, pull: PullRequest): boolean {
  const headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  if (repo.isAncestor(headSha, baseSha)) return false;
  const mergeBase = repo.mergeBase(headSha, baseSha);
  return planMerge(repo, mergeBase, headSha, baseSha).conflict;
}

function mergePullRoute(forge: Forge, repo: Repo, pull: PullRequest, req: ApiRequest): ApiResponse {
  const body = jsonBody(req);
  if (body === null) return fail(400, "Problems parsing JSON");
  if (pull.merged) return fail(405, "Pull Request has already been merged");
  if (pull.state === "closed") return fail(405, "Pull Request is not mergeable");
  const method = str(body.merge_method) ?? "squash";
  if (method !== "squash" && method !== "merge" && method !== "rebase") {
    return fail(405, `merge_method '${method}' is not supported`);
  }
  const sha = mergePullRequest(forge, repo, pull);
  if (sha === null) {
    return fail(405, "Pull Request has merge conflicts and cannot be merged");
  }
  return { status: 200, body: { sha, merged: true, message: "Pull Request successfully merged" } };
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

export function handleRest(forge: Forge, req: ApiRequest): ApiResponse {
  const method = req.method;
  const path = req.path.replace(/\/$/, "") || "/";
  const segments = path.split("/").filter((part) => part.length > 0);
  // segments[0] is "api", segments[1] is "v3" — app.ts guarantees the prefix.
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (method !== "GET") return notFound();
    return {
      status: 200,
      headers: { "x-oauth-scopes": "repo, user, admin:org, gist" },
      body: {
        current_user_url: "https://forge.local/api/v3/user",
        repository_url: "https://forge.local/api/v3/repos/{owner}/{repo}",
      },
    };
  }

  if (rest[0] === "meta" && rest.length === 1 && method === "GET") {
    return {
      status: 200,
      body: {
        verifiable_password_authentication: false,
        installed_version: "1.0.0",
        github_developer_version: "v3",
      },
    };
  }

  if (rest[0] === "user" && rest.length === 1 && method === "GET") {
    return { status: 200, body: userJson(forge) };
  }

  if (rest[0] === "user" && rest[1] === "repos" && rest.length === 2) {
    if (method === "GET") {
      const { page, headers } = paginate(req, forge.viewerRepos());
      return { status: 200, body: page.map((repo) => repoJson(forge, repo)), headers };
    }
    if (method === "POST") return createRepo(forge, req);
    return notFound();
  }

  if (rest[0] !== "repos" || rest.length < 3) return notFound();
  const owner = rest[1];
  const repoName = rest[2];
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return notFound();
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (method === "GET") return { status: 200, body: repoJson(forge, repo) };
    if (method === "PATCH") return patchRepo(forge, repo, req);
    if (method === "DELETE") {
      forge.deleteRepo(owner, repoName);
      return { status: 204 };
    }
    return notFound();
  }

  if (tail[0] === "branches") {
    if (tail.length === 1 && method === "GET") return { status: 200, body: listBranches(repo) };
    if (tail.length >= 2 && method === "GET") {
      const branch = tail.slice(1).join("/");
      const sha = repo.branchTip(branch);
      if (!sha) return notFound();
      return { status: 200, body: { name: branch, commit: { sha }, protected: false } };
    }
    return notFound();
  }

  if (tail[0] === "commits") {
    if (tail.length === 1 && method === "GET") return listCommits(repo, req);
    if (tail.length === 2 && method === "GET") {
      const oid = tail[1];
      if (repo.get(oid)?.type !== "commit") return notFound();
      return { status: 200, body: commitJson(repo, oid) };
    }
    return notFound();
  }

  if (tail[0] === "git" && tail[1] === "refs") {
    if (tail.length === 2 && method === "POST") return createRef(forge, repo, req);
    if (tail.length === 2 && method === "GET") {
      const all = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => ({
        ref,
        object: { sha, type: repo.get(sha)?.type ?? "commit" },
      }));
      return { status: 200, body: all };
    }
    if (tail.length >= 3 && method === "GET") {
      return getRef(repo, `refs/${tail.slice(2).join("/")}`);
    }
    return notFound();
  }
  if (tail[0] === "git" && tail[1] === "ref" && tail.length >= 3 && method === "GET") {
    return getRef(repo, `refs/${tail.slice(2).join("/")}`);
  }

  if (tail[0] === "contents") {
    const pathSegments = tail.slice(1);
    if (method === "GET") return getContents(repo, pathSegments, req);
    if (method === "PUT") return putContents(forge, repo, pathSegments, req);
    if (method === "DELETE") return deleteContents(forge, repo, pathSegments, req);
    return notFound();
  }

  if (tail[0] === "labels") {
    if (tail.length === 1 && method === "GET") {
      const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map(labelJson);
      return { status: 200, body: labels };
    }
    if (tail.length === 1 && method === "POST") return createLabel(forge, repo, req);
    return notFound();
  }

  if (tail[0] === "issues") {
    if (tail.length === 1) {
      if (method === "GET") {
        const { page, headers } = paginate(req, sortedIssues(repo, req));
        return { status: 200, body: page.map((issue) => issueJson(forge, repo, issue)), headers };
      }
      if (method === "POST") return createIssue(forge, repo, req);
      return notFound();
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number)) return notFound();
    if (tail.length === 2) {
      const issue = repo.issues.get(number);
      if (!issue) return notFound();
      if (method === "GET") return { status: 200, body: issueJson(forge, repo, issue) };
      if (method === "PATCH") return patchIssue(forge, repo, issue, req);
      return notFound();
    }
    if (tail.length === 3 && tail[2] === "comments") {
      const target = commentTarget(repo, number);
      if (!target) return notFound();
      if (method === "GET") {
        return { status: 200, body: target.comments.map((comment) => commentJson(forge, comment)) };
      }
      if (method === "POST") return addComment(forge, repo, number, req);
      return notFound();
    }
    return notFound();
  }

  if (tail[0] === "pulls") {
    if (tail.length === 1) {
      if (method === "GET") {
        const { page, headers } = paginate(req, sortedPulls(repo, req));
        return { status: 200, body: page.map((pull) => pullJson(forge, repo, pull)), headers };
      }
      if (method === "POST") return createPull(forge, repo, req);
      return notFound();
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number)) return notFound();
    const pull = repo.pulls.get(number);
    if (!pull) return notFound();
    if (tail.length === 2) {
      if (method === "GET") return { status: 200, body: pullJson(forge, repo, pull) };
      if (method === "PATCH") {
        const body = jsonBody(req);
        if (body === null) return fail(400, "Problems parsing JSON");
        const state = str(body.state);
        if (state === "closed" || state === "open") pull.state = state;
        const title = str(body.title);
        if (title !== undefined) pull.title = title;
        const text = str(body.body);
        if (text !== undefined) pull.body = text;
        pull.updatedAt = forge.now();
        return { status: 200, body: pullJson(forge, repo, pull) };
      }
      return notFound();
    }
    if (tail.length === 3 && tail[2] === "files" && method === "GET") return listPullFiles(repo, pull);
    if (tail.length === 3 && tail[2] === "merge" && method === "PUT") return mergePullRoute(forge, repo, pull, req);
    if (tail.length === 3 && tail[2] === "comments" && method === "GET") {
      return { status: 200, body: pull.comments.map((comment) => commentJson(forge, comment)) };
    }
    return notFound();
  }

  return notFound();
}
