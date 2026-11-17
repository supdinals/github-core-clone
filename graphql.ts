/**
 * graphql.ts — a small hand-written GraphQL implementation covering the
 * subset of GitHub's schema the suite queries: viewer, repository, node,
 * issues/pull-request connections, the five mutations, and the __type
 * introspection the checks read. Parsing is a real tokenizer + recursive
 * descent parser (operations, variables, enums, input objects, lists,
 * aliases, inline fragments and fragment spreads), validation is driven by
 * the TYPE_FIELDS table below, and execution resolves against the same
 * Forge store the REST and git surfaces use.
 */
import {
  globalId,
  parseGlobalId,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from "./forge.ts";
import { mergePullRequest, pullConflicts, pullFiles } from "./rest.ts";

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: "name"; value: string }
  | { kind: "int"; value: string }
  | { kind: "float"; value: string }
  | { kind: "string"; value: string }
  | { kind: "punct"; value: string }
  | { kind: "spread" }
  | { kind: "eof" };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === "#") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (/\s|,/.test(c)) {
      i += 1;
      continue;
    }
    if (source.startsWith("...", i)) {
      tokens.push({ kind: "spread" });
      i += 3;
      continue;
    }
    if ("!$():=@[]{}|&".includes(c)) {
      tokens.push({ kind: "punct", value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error("unterminated block string");
        tokens.push({ kind: "string", value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = "";
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\") {
          const esc = source[j + 1];
          const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "/": "/", "\\": "\\", '"': '"' };
          if (esc === "u") {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += escapes[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error("unterminated string");
      tokens.push({ kind: "string", value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === "-") j += 1;
      let isFloat = false;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      if (source[j] === ".") {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === "e" || source[j] === "E") {
        isFloat = true;
        j += 1;
        if (source[j] === "+" || source[j] === "-") j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? "float" : "int", value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: "name", value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: "variable"; name: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "enum"; value: string }
  | { kind: "null" }
  | { kind: "list"; items: ValueNode[] }
  | { kind: "object"; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: "field";
  name: string;
  alias?: string;
  args: Map<string, ValueNode>;
  selections: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: "inline"; typeCondition?: string; selections: SelectionNode[] }
  | { kind: "spread"; name: string };

interface OperationNode {
  operation: "query" | "mutation";
  name?: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== "punct" || token.value !== value) throw new Error(`expected '${value}'`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === "punct" && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== "name") throw new Error("expected a name");
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== "eof") {
      const token = this.peek();
      if (token.kind === "punct" && token.value === "{") {
        operations.push({ operation: "query", selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== "name") throw new Error("expected an operation or fragment");
      if (token.value === "query" || token.value === "mutation" || token.value === "subscription") {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === "name") name = this.expectName();
        if (this.peek().kind === "punct" && this.peek().value === "(") this.skipBalancedParens();
        this.skipDirectives();
        operations.push({
          operation: token.value === "mutation" ? "mutation" : "query",
          name,
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.value === "fragment") {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== "name" || onToken.value !== "on") throw new Error("expected 'on' in fragment");
        this.expectName(); // type condition
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition '${token.value}'`);
    }
    return { operations, fragments };
  }

  private skipBalancedParens(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token.kind === "eof") throw new Error("unbalanced parentheses");
      if (token.kind === "punct" && token.value === "(") depth += 1;
      if (token.kind === "punct" && token.value === ")") depth -= 1;
    } while (depth > 0);
  }

  private skipDirectives(): void {
    while (this.peek().kind === "punct" && this.peek().value === "@") {
      this.next();
      this.expectName();
      if (this.peek().kind === "punct" && this.peek().value === "(") this.skipBalancedParens();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct("{");
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === "punct" && this.peek().value === "}")) {
      if (this.peek().kind === "eof") throw new Error("unterminated selection set");
      selections.push(this.parseSelection());
    }
    this.expectPunct("}");
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === "spread") {
      this.next();
      const next = this.peek();
      if (next.kind === "name" && next.value === "on") {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: "inline", typeCondition, selections: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: "spread", name };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(":")) {
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.peek().kind === "punct" && this.peek().value === "(") {
      this.next();
      while (!(this.peek().kind === "punct" && this.peek().value === ")")) {
        const argName = this.expectName();
        this.expectPunct(":");
        args.set(argName, this.parseValue());
      }
      this.expectPunct(")");
    }
    this.skipDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek().kind === "punct" && this.peek().value === "{") {
      selections = this.parseSelectionSet();
    }
    return { kind: "field", name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case "int":
        return { kind: "int", value: Number.parseInt(token.value, 10) };
      case "float":
        return { kind: "float", value: Number.parseFloat(token.value) };
      case "string":
        return { kind: "string", value: token.value };
      case "name":
        if (token.value === "true") return { kind: "boolean", value: true };
        if (token.value === "false") return { kind: "boolean", value: false };
        if (token.value === "null") return { kind: "null" };
        return { kind: "enum", value: token.value };
      case "punct":
        if (token.value === "$") return { kind: "variable", name: this.expectName() };
        if (token.value === "[") {
          const items: ValueNode[] = [];
          while (!(this.peek().kind === "punct" && this.peek().value === "]")) {
            items.push(this.parseValue());
          }
          this.expectPunct("]");
          return { kind: "list", items };
        }
        if (token.value === "{") {
          const fields: { name: string; value: ValueNode }[] = [];
          while (!(this.peek().kind === "punct" && this.peek().value === "}")) {
            const name = this.expectName();
            this.expectPunct(":");
            fields.push({ name, value: this.parseValue() });
          }
          this.expectPunct("}");
          return { kind: "object", fields };
        }
        break;
      default:
        break;
    }
    throw new Error("unexpected value");
  }
}

function evaluate(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case "variable":
      return variables[node.name];
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "enum":
      return node.value;
    case "null":
      return null;
    case "list":
      return node.items.map((item) => evaluate(item, variables));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evaluate(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// schema tables (validation + introspection share these)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ["viewer", "repository", "node"],
  Mutation: ["createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment"],
  Node: ["id"],
  Repository: [
    "id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef",
    "viewerPermission", "hasIssuesEnabled", "description", "isPrivate",
    "createdAt", "updatedAt", "url", "issue", "issues", "pullRequest", "pullRequests",
  ],
  Issue: [
    "id", "databaseId", "number", "title", "state", "body", "author",
    "repository", "createdAt", "updatedAt", "closedAt", "url", "comments",
  ],
  PullRequest: [
    "id", "databaseId", "number", "title", "state", "body", "author",
    "repository", "merged", "mergedAt", "mergeCommit", "headRefName",
    "baseRefName", "mergeable", "files", "createdAt", "updatedAt", "url",
  ],
  User: ["id", "databaseId", "login", "name", "email", "url"],
  Ref: ["name", "prefix", "target"],
  Commit: ["id", "oid", "message", "committedDate"],
  IssueConnection: ["nodes", "edges", "pageInfo", "totalCount"],
  IssueEdge: ["node", "cursor"],
  PullRequestConnection: ["nodes", "edges", "pageInfo", "totalCount"],
  PullRequestEdge: ["node", "cursor"],
  PullRequestFileConnection: ["nodes", "edges", "pageInfo", "totalCount"],
  PullRequestFileEdge: ["node", "cursor"],
  PullRequestFile: ["path"],
  IssueCommentConnection: ["nodes", "edges", "pageInfo", "totalCount"],
  IssueCommentEdge: ["node", "cursor"],
  IssueComment: ["id", "databaseId", "body", "author", "createdAt", "updatedAt"],
  CommentEdge: ["node", "cursor"],
  PageInfo: ["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"],
  CreateIssuePayload: ["issue", "clientMutationId"],
  CloseIssuePayload: ["issue", "clientMutationId"],
  CreatePullRequestPayload: ["pullRequest", "clientMutationId"],
  MergePullRequestPayload: ["pullRequest", "clientMutationId"],
  AddCommentPayload: ["commentEdge", "subject", "clientMutationId"],
  __Type: ["name", "kind", "description", "fields", "enumValues", "ofType", "possibleTypes", "inputFields"],
  __Field: ["name", "description", "type", "args", "isDeprecated", "deprecationReason"],
  __EnumValue: ["name", "description", "isDeprecated", "deprecationReason"],
  __Schema: ["types", "queryType", "mutationType"],
};

const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ["ISSUE", "REPOSITORY", "USER", "DISCUSSION"],
  IssueState: ["OPEN", "CLOSED"],
  PullRequestState: ["OPEN", "CLOSED", "MERGED"],
  MergeableState: ["MERGEABLE", "CONFLICTING", "UNKNOWN"],
  OrderDirection: ["ASC", "DESC"],
  IssueOrderField: ["CREATED_AT", "UPDATED_AT", "COMMENTS"],
  PullRequestMergeMethod: ["MERGE", "SQUASH", "REBASE"],
  RepositoryPermission: ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"],
};

// ---------------------------------------------------------------------------
// typed values
// ---------------------------------------------------------------------------

interface Obj {
  __type: string;
  [key: string]: unknown;
}

function obj(type: string, fields: Record<string, unknown>): Obj {
  return { __type: type, ...fields };
}

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && "__type" in (value as Record<string, unknown>);
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function userObj(forge: Forge): Obj {
  return obj("User", { forge });
}

function repoObj(repo: Repo): Obj {
  return obj("Repository", { repo });
}

function issueObj(repo: Repo, issue: Issue): Obj {
  return obj("Issue", { repo, issue });
}

function pullObj(repo: Repo, pull: PullRequest): Obj {
  return obj("PullRequest", { repo, pull });
}

function commentObj(forge: Forge, comment: { id: number; body: string; createdAt: number }): Obj {
  return obj("IssueComment", { forge, comment });
}

interface ConnectionItem {
  node: Obj;
  cursor: string;
}

function connectionObj(type: string, all: ConnectionItem[], args: Args): Obj {
  let start = 0;
  const after = typeof args.after === "string" ? args.after : undefined;
  if (after) {
    const index = all.findIndex((item) => item.cursor === after);
    if (index !== -1) start = index + 1;
  }
  const first = typeof args.first === "number" ? args.first : 10;
  const items = all.slice(start, start + first);
  const pageInfo = obj("PageInfo", {
    hasNextPage: start + items.length < all.length,
    hasPreviousPage: start > 0,
    startCursor: items.length ? items[0].cursor : null,
    endCursor: items.length ? items[items.length - 1].cursor : null,
  });
  return obj(type, { items, pageInfo, totalCount: all.length });
}

function cursorFor(kind: string, repo: Repo, number: number): string {
  return Buffer.from(`cursor:${kind}:${repo.id}:${number}`, "utf8").toString("base64");
}

// ---------------------------------------------------------------------------
// lookups by global/database id
// ---------------------------------------------------------------------------

function findRepoByDbId(forge: Forge, id: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function findIssueByDbId(forge: Forge, id: number): { repo: Repo; issue: Issue } | undefined {
  for (const repo of forge.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
  }
  return undefined;
}

function findPullByDbId(forge: Forge, id: number): { repo: Repo; pull: PullRequest } | undefined {
  for (const repo of forge.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
  }
  return undefined;
}

function nodeByGlobalId(forge: Forge, global: string): Obj | null {
  const parsed = parseGlobalId(global);
  if (!parsed) return null;
  switch (parsed.type) {
    case "Repository": {
      const repo = findRepoByDbId(forge, parsed.id);
      return repo ? repoObj(repo) : null;
    }
    case "Issue": {
      const found = findIssueByDbId(forge, parsed.id);
      return found ? issueObj(found.repo, found.issue) : null;
    }
    case "PullRequest": {
      const found = findPullByDbId(forge, parsed.id);
      return found ? pullObj(found.repo, found.pull) : null;
    }
    case "User":
      return parsed.id === forge.viewer.id ? userObj(forge) : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

function fieldArgs(ctx: Ctx, field: FieldNode): Args {
  const args: Args = {};
  for (const [name, value] of field.args) args[name] = evaluate(value, ctx.variables);
  return args;
}

function typeObj(name: string): Obj | null {
  if (TYPE_FIELDS[name]) return obj("__Type", { name, kind: name === "Node" ? "INTERFACE" : "OBJECT" });
  if (ENUM_TYPES[name]) return obj("__Type", { name, kind: "ENUM" });
  return null;
}

function resolveField(ctx: Ctx, typeName: string, source: Obj, field: FieldNode): unknown {
  const forge = ctx.forge;
  const args = fieldArgs(ctx, field);
  const name = field.name;

  if (typeName === "Query") {
    if (name === "viewer") return userObj(forge);
    if (name === "repository") {
      const repo = forge.getRepo(String(args.owner ?? ""), String(args.name ?? ""));
      return repo ? repoObj(repo) : null;
    }
    if (name === "node") return nodeByGlobalId(forge, String(args.id ?? ""));
  }

  if (typeName === "Mutation") return resolveMutation(ctx, name, args);

  if (typeName === "User") {
    const viewer = forge.viewer;
    switch (name) {
      case "id": return globalId("User", viewer.id);
      case "databaseId": return viewer.id;
      case "login": return viewer.login;
      case "name": return viewer.name;
      case "email": return viewer.email;
      case "url": return `https://forge.local/${viewer.login}`;
      default: return null;
    }
  }

  if (typeName === "Repository") {
    const repo = source.repo as Repo;
    switch (name) {
      case "id": return globalId("Repository", repo.id);
      case "databaseId": return repo.id;
      case "name": return repo.name;
      case "nameWithOwner": return repo.fullName;
      case "owner": return userObj(forge);
      case "description": return repo.description;
      case "isPrivate": return repo.isPrivate;
      case "createdAt": return iso(repo.createdAt);
      case "updatedAt": return iso(repo.updatedAt);
      case "url": return `https://forge.local/${repo.fullName}`;
      case "viewerPermission": return "ADMIN";
      case "hasIssuesEnabled": return true;
      case "defaultBranchRef": {
        const tip = repo.refs.get(repo.headRef);
        if (!tip) return null;
        return obj("Ref", { repo, name: repo.defaultBranch, oid: tip });
      }
      case "issue": {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueObj(repo, issue) : null;
      }
      case "issues": return issuesConnection(ctx, repo, args);
      case "pullRequest": {
        const pull = repo.pulls.get(Number(args.number));
        return pull ? pullObj(repo, pull) : null;
      }
      case "pullRequests": return pullsConnection(ctx, repo, args);
      default: return null;
    }
  }

  if (typeName === "Ref") {
    const repo = source.repo as Repo;
    if (name === "name") return source.name as string;
    if (name === "prefix") return "refs/heads/";
    if (name === "target") return obj("Commit", { repo, oid: source.oid as string });
    return null;
  }

  if (typeName === "Commit") {
    if (name === "id") return globalId("Commit", 0) + (source.oid as string);
    if (name === "oid") return source.oid as string;
    if (name === "message") {
      const repo = source.repo as Repo;
      return repo.commitOf(source.oid as string)?.message ?? "";
    }
    if (name === "committedDate") {
      const repo = source.repo as Repo;
      const commit = repo.commitOf(source.oid as string);
      return commit ? iso(commit.committer ? Number(/ (\d+) [+-]\d{4}$/.exec(commit.committer)?.[1] ?? 0) : 0) : null;
    }
    return null;
  }

  if (typeName === "Issue") {
    const repo = source.repo as Repo;
    const issue = source.issue as Issue;
    switch (name) {
      case "id": return globalId("Issue", issue.id);
      case "databaseId": return issue.id;
      case "number": return issue.number;
      case "title": return issue.title;
      case "body": return issue.body;
      case "state": return issue.state === "open" ? "OPEN" : "CLOSED";
      case "author": return userObj(forge);
      case "repository": return repoObj(repo);
      case "createdAt": return iso(issue.createdAt);
      case "updatedAt": return iso(issue.updatedAt);
      case "closedAt": return issue.state === "closed" ? iso(issue.updatedAt) : null;
      case "url": return `https://forge.local/${repo.fullName}/issues/${issue.number}`;
      case "comments": {
        const items = issue.comments.map((comment) => ({
          node: commentObj(forge, comment),
          cursor: Buffer.from(`cursor:comment:${comment.id}`, "utf8").toString("base64"),
        }));
        return connectionObj("IssueCommentConnection", items, args);
      }
      default: return null;
    }
  }

  if (typeName === "PullRequest") {
    const repo = source.repo as Repo;
    const pull = source.pull as PullRequest;
    switch (name) {
      case "id": return globalId("PullRequest", pull.id);
      case "databaseId": return pull.id;
      case "number": return pull.number;
      case "title": return pull.title;
      case "body": return pull.body;
      case "state": return pull.merged ? "MERGED" : pull.state.toUpperCase();
      case "merged": return pull.merged;
      case "mergedAt": return pull.mergedAt !== null ? iso(pull.mergedAt) : null;
      case "mergeCommit": return pull.mergeCommitSha ? obj("Commit", { repo, oid: pull.mergeCommitSha }) : null;
      case "headRefName": return pull.headRef;
      case "baseRefName": return pull.baseRef;
      case "mergeable": return pull.merged ? "MERGEABLE" : pullConflicts(repo, pull) ? "CONFLICTING" : "MERGEABLE";
      case "author": return userObj(forge);
      case "repository": return repoObj(repo);
      case "createdAt": return iso(pull.createdAt);
      case "updatedAt": return iso(pull.updatedAt);
      case "url": return `https://forge.local/${repo.fullName}/pull/${pull.number}`;
      case "files": {
        const items = pullFiles(repo, pull).map((file) => ({
          node: obj("PullRequestFile", { path: file.filename }),
          cursor: Buffer.from(`cursor:file:${file.filename}`, "utf8").toString("base64"),
        }));
        return connectionObj("PullRequestFileConnection", items, args);
      }
      default: return null;
    }
  }

  if (typeName === "PullRequestFile") {
    if (name === "path") return source.path as string;
    return null;
  }

  if (typeName === "IssueComment") {
    const comment = source.comment as { id: number; body: string; createdAt: number };
    switch (name) {
      case "id": return globalId("IssueComment", comment.id);
      case "databaseId": return comment.id;
      case "body": return comment.body;
      case "author": return userObj(forge);
      case "createdAt": return iso(comment.createdAt);
      case "updatedAt": return iso(comment.createdAt);
      default: return null;
    }
  }

  if (typeName.endsWith("Connection")) {
    const items = source.items as ConnectionItem[];
    if (name === "nodes") return items.map((item) => item.node);
    if (name === "edges") {
      const edgeType = typeName === "IssueConnection"
        ? "IssueEdge"
        : typeName === "PullRequestConnection"
          ? "PullRequestEdge"
          : typeName === "PullRequestFileConnection"
            ? "PullRequestFileEdge"
            : "IssueCommentEdge";
      return items.map((item) => obj(edgeType, { node: item.node, cursor: item.cursor }));
    }
    if (name === "pageInfo") return source.pageInfo as Obj;
    if (name === "totalCount") return source.totalCount as number;
    return null;
  }

  if (typeName.endsWith("Edge")) {
    if (name === "node") return source.node as Obj;
    if (name === "cursor") return source.cursor as string;
    return null;
  }

  if (typeName === "PageInfo") {
    if (name in source) return source[name];
    return null;
  }

  if (typeName === "__Type") {
    const typeNameValue = source.name as string;
    switch (name) {
      case "name": return typeNameValue;
      case "kind": return source.kind as string;
      case "description": return null;
      case "fields": {
        const fields = TYPE_FIELDS[typeNameValue];
        return fields ? fields.map((fieldName) => obj("__Field", { name: fieldName })) : null;
      }
      case "enumValues": {
        const values = ENUM_TYPES[typeNameValue];
        return values ? values.map((value) => obj("__EnumValue", { name: value })) : null;
      }
      case "ofType": return null;
      case "possibleTypes": return null;
      case "inputFields": return null;
      default: return null;
    }
  }

  if (typeName === "__Field") {
    if (name === "name") return source.name as string;
    if (name === "description") return null;
    if (name === "type") return null;
    if (name === "args") return [];
    if (name === "isDeprecated") return false;
    if (name === "deprecationReason") return null;
    return null;
  }

  if (typeName === "__EnumValue") {
    if (name === "name") return source.name as string;
    if (name === "description") return null;
    if (name === "isDeprecated") return false;
    if (name === "deprecationReason") return null;
    return null;
  }

  if (typeName.endsWith("Payload")) {
    if (name === "clientMutationId") return (source.clientMutationId as string | null) ?? null;
    if (name in source) return source[name];
    return null;
  }

  return null;
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Args): Obj {
  void ctx;
  let list = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
  if (states?.length) {
    list = list.filter((issue) => states.includes(issue.state === "open" ? "OPEN" : "CLOSED"));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction ?? "DESC";
  list.sort((a, b) => (direction === "ASC"
    ? a.createdAt - b.createdAt || a.number - b.number
    : b.createdAt - a.createdAt || b.number - a.number));
  const items = list.map((issue) => ({ node: issueObj(repo, issue), cursor: cursorFor("issue", repo, issue.number) }));
  return connectionObj("IssueConnection", items, args);
}

function pullsConnection(ctx: Ctx, repo: Repo, args: Args): Obj {
  void ctx;
  let list = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : ["OPEN"];
  list = list.filter((pull) => {
    const state = pull.merged ? "MERGED" : pull.state.toUpperCase();
    return states.includes(state);
  });
  const orderBy = (args.orderBy ?? {}) as { direction?: string };
  const direction = orderBy.direction ?? "DESC";
  list.sort((a, b) => (direction === "ASC" ? a.number - b.number : b.number - a.number));
  const items = list.map((pull) => ({ node: pullObj(repo, pull), cursor: cursorFor("pull", repo, pull.number) }));
  return connectionObj("PullRequestConnection", items, args);
}

function resolveMutation(ctx: Ctx, name: string, args: Args): unknown {
  const forge = ctx.forge;
  const input = (args.input ?? args) as Record<string, unknown>;
  const clientMutationId = typeof input.clientMutationId === "string" ? input.clientMutationId : null;

  if (name === "createIssue") {
    const parsed = parseGlobalId(String(input.repositoryId ?? ""));
    const repo = parsed ? findRepoByDbId(forge, parsed.id) : undefined;
    if (!repo) throw new Error("repository not found");
    const now = forge.now();
    const issue: Issue = {
      id: forge.newObjectId(),
      number: repo.nextNumber,
      title: String(input.title ?? ""),
      body: String(input.body ?? ""),
      state: "open",
      labels: [],
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return obj("CreateIssuePayload", { issue: issueObj(repo, issue), clientMutationId });
  }

  if (name === "closeIssue") {
    const parsed = parseGlobalId(String(input.issueId ?? ""));
    const found = parsed ? findIssueByDbId(forge, parsed.id) : undefined;
    if (!found) throw new Error("issue not found");
    found.issue.state = "closed";
    found.issue.updatedAt = forge.now();
    return obj("CloseIssuePayload", { issue: issueObj(found.repo, found.issue), clientMutationId });
  }

  if (name === "createPullRequest") {
    const parsed = parseGlobalId(String(input.repositoryId ?? ""));
    const repo = parsed ? findRepoByDbId(forge, parsed.id) : undefined;
    if (!repo) throw new Error("repository not found");
    const headRef = String(input.headRefName ?? "");
    const baseRef = String(input.baseRefName ?? repo.defaultBranch);
    const headSha = repo.branchTip(headRef);
    const baseSha = repo.branchTip(baseRef);
    if (!headSha) throw new Error(`head ref '${headRef}' does not exist`);
    if (!baseSha) throw new Error(`base ref '${baseRef}' does not exist`);
    const now = forge.now();
    const pull: PullRequest = {
      id: forge.newObjectId(),
      number: repo.nextNumber,
      title: String(input.title ?? ""),
      body: String(input.body ?? ""),
      state: "open",
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return obj("CreatePullRequestPayload", { pullRequest: pullObj(repo, pull), clientMutationId });
  }

  if (name === "mergePullRequest") {
    const parsed = parseGlobalId(String(input.pullRequestId ?? ""));
    const found = parsed ? findPullByDbId(forge, parsed.id) : undefined;
    if (!found) throw new Error("pull request not found");
    if (!found.pull.merged) {
      const sha = mergePullRequest(forge, found.repo, found.pull);
      if (sha === null) throw new Error("Pull request has merge conflicts");
    }
    return obj("MergePullRequestPayload", { pullRequest: pullObj(found.repo, found.pull), clientMutationId });
  }

  if (name === "addComment") {
    const parsed = parseGlobalId(String(input.subjectId ?? ""));
    if (!parsed) throw new Error("subject not found");
    const body = String(input.body ?? "");
    const comment = { id: forge.newCommentId(), body, createdAt: forge.now() };
    let subject: Obj | null = null;
    if (parsed.type === "Issue") {
      const found = findIssueByDbId(forge, parsed.id);
      if (!found) throw new Error("subject not found");
      found.issue.comments.push(comment);
      subject = issueObj(found.repo, found.issue);
    } else if (parsed.type === "PullRequest") {
      const found = findPullByDbId(forge, parsed.id);
      if (!found) throw new Error("subject not found");
      found.pull.comments.push(comment);
      subject = pullObj(found.repo, found.pull);
    } else {
      throw new Error("subject is not commentable");
    }
    const edge = obj("CommentEdge", {
      node: commentObj(forge, comment),
      cursor: Buffer.from(`cursor:comment:${comment.id}`, "utf8").toString("base64"),
    });
    return obj("AddCommentPayload", { commentEdge: edge, subject, clientMutationId });
  }

  throw new Error(`unknown mutation '${name}'`);
}

const NODE_TYPES = new Set(["Repository", "Issue", "PullRequest", "User", "IssueComment"]);

function executeSelections(ctx: Ctx, typeName: string, source: Obj, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === "inline") {
      const condition = selection.typeCondition;
      if (!condition || condition === typeName || (condition === "Node" && NODE_TYPES.has(typeName))) {
        Object.assign(out, executeSelections(ctx, typeName, source, selection.selections));
      }
      continue;
    }
    if (selection.kind === "spread") {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelections(ctx, typeName, source, fragment));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === "__typename") {
      out[key] = typeName;
      continue;
    }
    if (typeName === "Query" && selection.name === "__type") {
      const args = fieldArgs(ctx, selection);
      const found = typeObj(String(args.name ?? ""));
      out[key] = found ? executeSelections(ctx, "__Type", found, selection.selections) : null;
      continue;
    }
    if (typeName === "Query" && selection.name === "__schema") {
      const schema = obj("__Schema", {});
      out[key] = executeSelections(ctx, "__Schema", schema, selection.selections);
      continue;
    }
    const knownFields = TYPE_FIELDS[typeName];
    if (!knownFields || !knownFields.includes(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    let raw: unknown;
    try {
      raw = resolveField(ctx, typeName, source, selection);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, raw, selection.selections);
  }
  return out;
}

function completeValue(ctx: Ctx, raw: unknown, selections: SelectionNode[]): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item) => completeValue(ctx, item, selections));
  if (isObj(raw)) {
    if (!selections.length) return {};
    return executeSelections(ctx, raw.__type, raw, selections);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

interface OperationRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOperation(forge: Forge, operation: OperationRequest): Record<string, unknown> {
  const query = typeof operation.query === "string" ? operation.query : "";
  const variables = (typeof operation.variables === "object" && operation.variables !== null
    ? operation.variables
    : {}) as Record<string, unknown>;
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const wanted = typeof operation.operationName === "string" ? operation.operationName : undefined;
  const op = document.operations.find((candidate) => candidate.name === wanted) ?? document.operations[0];
  if (!op) return { errors: [{ message: "no operation in document" }] };
  const ctx: Ctx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = op.operation === "mutation" ? "Mutation" : "Query";
  const data = executeSelections(ctx, rootType, obj(rootType, {}), op.selections);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}

export function handleGraphQL(forge: Forge, body: Buffer): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400, body: { errors: [{ message: "request body is not valid JSON" }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => executeOperation(forge, entry as OperationRequest)) };
  }
  return { status: 200, body: executeOperation(forge, parsed as OperationRequest) };
}
