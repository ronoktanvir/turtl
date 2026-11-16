import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Tripwire for the security review's finding 4: one account's activity must not be able to make a read fail for
// every other account. Convex stops a function that reads too many documents, so a read whose size grows with the
// whole deployment is a lever anyone can pull: create enough projects, keys and reports and Stop fails for everyone.
//
// 1. Nothing reads the _scheduled_functions system table without an index bound (every account's jobs land there).
//    Cancel by the job ids kept on the row instead (convex/runner/jobs.ts).
// 2. No public query, mutation or action collect()s a table without an index that picks out one project, case or
//    account (an eq() in withIndex), outside the single-owner demo's own branch (AUTH_REQUIRED unset).
// A read that truly needs an exception is named in ALLOWED with the reason, in plain words.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const convexDir = join(root, "convex");
const BUILDERS = new Set(["query", "mutation", "action"]);

// "convex/<file>.ts:<line text>" -> why the read is allowed.
const ALLOWED = {
  "convex/dev.ts:_scheduled_functions": "dev tools only: requireDevTools refuses with AUTH_REQUIRED=true, so no account can reach it",
  "convex/memory/reset.ts:_scheduled_functions": "an internal booking-demo reset the operator runs from a terminal on a demo deployment with DEV_TOOLS_ENABLED",
  "convex/runner/jobs.ts:_scheduled_functions": "for attempts dispatched before job ids were kept: bounded by a 15-minute lookback and take(1000)",
};

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "_generated" || entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.test\./.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

// The calls in a chain like ctx.db.query("t").withIndex(...).order("desc").collect(), from the root outwards.
function chainOf(call) {
  const links = [];
  let node = call;
  while (node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      links.unshift({ name: node.expression.name.text, args: node.arguments, receiver: node.expression.expression });
      node = node.expression.expression;
    } else if (ts.isPropertyAccessExpression(node)) node = node.expression;
    else if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
    else break;
  }
  return links;
}

const textOf = (node) => node.getText();
const isSystem = (link) => ts.isPropertyAccessExpression(link.receiver) && link.receiver.name.text === "system";

/** Every database read chain in a file: the table, its links, where it is, and the node of its last call. */
function readChains(source) {
  const found = [];
  const visit = (node) => {
    // The outermost call of a chain: its parent is not a property access continuing it.
    if (ts.isCallExpression(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) {
      const links = chainOf(node);
      const start = links.findIndex((link) => link.name === "query" && link.args.length === 1 && ts.isStringLiteral(link.args[0]));
      if (start !== -1 && /\bdb\b/.test(textOf(links[start].receiver))) {
        found.push({ table: links[start].args[0].text, system: isSystem(links[start]), links: links.slice(start + 1), node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const has = (chain, name) => chain.links.some((link) => link.name === name);
const index = (chain) => chain.links.find((link) => link.name === "withIndex");
const bounded = (chain) => ["take", "first", "unique", "paginate"].some((name) => has(chain, name));

// A _scheduled_functions read must be bounded by its index: a range that ends in take/first, or at least a lower
// bound on _creationTime (a lookback) before collect().
function scheduledProblem(chain) {
  const range = index(chain);
  if (!range) return "reads every job with no index bound";
  const callback = range.args[1] ? textOf(range.args[1]) : "";
  if (!/\.(eq|gt|gte)\(/.test(callback)) return "uses an index with no bound";
  if (!bounded(chain) && !/\.(gt|gte)\(/.test(callback)) return "collects without a lower bound";
  return null;
}

// Does this node run only in the single-owner demo? It does when it sits on the false side of accessEnforced() (or a
// name bound to it), on the true side of !accessEnforced(), or after `if (accessEnforced()) return ...`.
function demoOnly(node, boundNames) {
  const enforced = (expr) => {
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "accessEnforced") return true;
    return ts.isIdentifier(expr) && boundNames.has(expr.text);
  };
  const negated = (expr) => ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken && enforced(expr.operand);
  const leaves = (statement) => ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || (ts.isBlock(statement) && statement.statements.some(leaves));
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isConditionalExpression(parent)) {
      if (child === parent.whenFalse && enforced(parent.condition)) return true;
      if (child === parent.whenTrue && negated(parent.condition)) return true;
    }
    if (ts.isIfStatement(parent)) {
      if (child === parent.elseStatement && enforced(parent.expression)) return true;
      if (child === parent.thenStatement && negated(parent.expression)) return true;
    }
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      const before = parent.statements.slice(0, parent.statements.indexOf(child));
      if (before.some((statement) => ts.isIfStatement(statement) && !statement.elseStatement && enforced(statement.expression) && leaves(statement.thenStatement))) return true;
      // requireDevTools() throws with accounts on (convex/access.ts), so what follows it runs only in the demo.
      if (before.some((statement) => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && textOf(statement.expression.expression) === "requireDevTools")) return true;
    }
  }
  return false;
}

// The public functions a file exports: the builder call of each, from convex/functions.ts (which every public function
// uses) or from convex/_generated/server.
function publicDefinitions(file, source) {
  const builders = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    const from = resolve(dirname(file), statement.moduleSpecifier.text);
    if (!from.endsWith(join("convex", "_generated", "server")) && from !== join(convexDir, "functions")) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      if (BUILDERS.has((element.propertyName ?? element.name).text)) builders.add(element.name.text);
    }
  }
  const found = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !ts.getModifiers?.(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const call = declaration.initializer;
      if (call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && builders.has(call.expression.text)) found.push({ name: declaration.name.getText(), call });
    }
  }
  return found;
}

const within = (node, outer) => node.pos >= outer.pos && node.end <= outer.end;

export function problemsIn(file, text = readFileSync(file, "utf8")) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const id = relative(root, file).split("\\").join("/");
  const chains = readChains(source);
  const problems = [];
  for (const chain of chains) {
    if (chain.table !== "_scheduled_functions" || !chain.system) continue;
    const problem = scheduledProblem(chain);
    if (problem && !(`${id}:_scheduled_functions` in ALLOWED)) problems.push(`${id}: a _scheduled_functions read ${problem}`);
  }
  for (const definition of publicDefinitions(file, source)) {
    const boundNames = new Set();
    const collectNames = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name) && /^accessEnforced\(\)$/.test(textOf(node.initializer))) boundNames.add(node.name.text);
      ts.forEachChild(node, collectNames);
    };
    collectNames(definition.call);
    for (const chain of chains) {
      if (!within(chain.node, definition.call) || !has(chain, "collect")) continue;
      const range = index(chain);
      const scoped = range && range.args[1] && /\.eq\(/.test(textOf(range.args[1]));
      if (scoped || demoOnly(chain.node, boundNames)) continue;
      const key = `${id}:${definition.name}:${chain.table}`;
      if (!(key in ALLOWED)) problems.push(`${key}: collect() over ${chain.table} ${range ? "through an index with no eq()" : "with no index"} in a public function`);
    }
  }
  return [...new Set(problems)];
}

// 3. (Second review, finding 15.) The same holds for every function a cron reaches: the internal functions convex/crons.ts
//    names, everything they call or schedule through `internal.*`, and the helpers they call in their own module or
//    import from another. A cron runs for every account at once, so a read there that grows with the deployment fails
//    for everyone, and one that takes the whole set in a fixed order makes later rows wait on earlier ones.

// "convex/<file>.ts:<function>:<table>" -> why a cron may collect it.
const CRON_ALLOWED = {
  "convex/github/installations.ts:repositoryRows:githubInstallationRepositories":
    "one repository's rows, by its full name: one per GitHub installation that holds a repository of that name, which no account can grow for another",
};

const parsedFiles = new Map();
const parsed = (file) => {
  if (!parsedFiles.has(file)) parsedFiles.set(file, ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  return parsedFiles.get(file);
};
const moduleFile = (base) => [`${base}.ts`, join(base, "index.ts")].find((candidate) => { try { readFileSync(candidate); return true; } catch { return false; } });

/** A module's top-level functions and definitions by name. */
function declarationsOf(file) {
  const found = new Map();
  for (const statement of parsed(file).statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) found.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) found.set(declaration.name.text, declaration.initializer);
  }
  return found;
}

/** What a module imports by name from relative paths: local name -> the module and the name there. */
function importsOf(file) {
  const found = new Map();
  for (const statement of parsed(file).statements) {
    if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier.text.startsWith(".") || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    const target = moduleFile(resolve(dirname(file), statement.moduleSpecifier.text));
    if (!target) continue;
    for (const element of statement.importClause.namedBindings.elements) found.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text });
  }
  return found;
}

/** The functions a node refers to: `internal.a.b.c` (convex/a/b.ts, c), and top-level names of its own module or imported
 * ones. With `scheduled: false`, only the helpers it calls, not the functions it runs or schedules through `internal`. */
function referencesIn(file, node, { scheduled = true } = {}) {
  const declarations = declarationsOf(file);
  const imported = importsOf(file);
  const found = [];
  const visit = (child) => {
    if (scheduled && ts.isPropertyAccessExpression(child) && !ts.isPropertyAccessExpression(child.parent)) {
      const path = textOf(child).replace(/\s+/g, "").split(".");
      if (path[0] === "internal" && path.length >= 3) {
        const target = moduleFile(join(convexDir, ...path.slice(1, -1)));
        if (target) found.push({ file: target, name: path[path.length - 1] });
      }
    }
    if (ts.isIdentifier(child) && !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child)) {
      if (declarations.has(child.text) && declarations.get(child.text) !== node) found.push({ file, name: child.text });
      else if (imported.has(child.text)) found.push(imported.get(child.text));
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Every module function a cron reaches, as file -> names. */
export function cronReached() {
  const crons = join(convexDir, "crons.ts");
  return reachedFrom(referencesIn(crons, parsed(crons)));
}

/** Every module function reached from these, as file -> names. */
export function reachedFrom(start, options) {
  const reached = new Map();
  const queue = [...start];
  while (queue.length) {
    const { file, name } = queue.shift();
    if (reached.get(file)?.has(name)) continue;
    const node = declarationsOf(file).get(name);
    if (!node) continue;
    reached.set(file, (reached.get(file) ?? new Set()).add(name));
    queue.push(...referencesIn(file, node, options));
  }
  return reached;
}

export function cronProblems(reached = cronReached()) {
  const problems = [];
  for (const [file, names] of reached) {
    const id = relative(root, file).split("\\").join("/");
    const chains = readChains(parsed(file));
    for (const name of names) {
      const node = declarationsOf(file).get(name);
      const boundNames = new Set();
      const collectNames = (child) => {
        if (ts.isVariableDeclaration(child) && child.initializer && ts.isIdentifier(child.name) && /^accessEnforced\(\)$/.test(textOf(child.initializer))) boundNames.add(child.name.text);
        ts.forEachChild(child, collectNames);
      };
      collectNames(node);
      for (const chain of chains) {
        if (!within(chain.node, node) || !has(chain, "collect")) continue;
        const range = index(chain);
        // Scoped means the first eq() names one project, case, account or row (a field ending in Id, or account): an
        // eq() on a state such as settledAt still picks out every account's rows.
        const first = range && range.args[1] ? /\.eq\(\s*"(\w+)"/.exec(textOf(range.args[1]))?.[1] : undefined;
        const scoped = first !== undefined && (/Id$/.test(first) || first === "account");
        if (scoped || demoOnly(chain.node, boundNames) || `${id}:${name}:${chain.table}` in CRON_ALLOWED) continue;
        problems.push(`${id}:${name}:${chain.table}: collect() over ${chain.table} ${range ? "through an index that picks no one project, case or account" : "with no index"} in a function a cron reaches`);
      }
    }
  }
  return [...new Set(problems)];
}

test("no function a cron reaches collects a whole shared table", () => {
  const reached = cronReached();
  // The crons' own entry points, and what they hand work to, are all followed.
  const names = (file) => [...(reached.get(join(convexDir, file)) ?? [])];
  for (const [file, name] of [
    ["monitor.ts", "tick"], ["monitor.ts", "checkProject"], ["protectedApp/watching.ts", "claim"], ["protectedApp/watching.ts", "takeTurn"],
    ["pullRequests.ts", "refreshActive"], ["pullRequests.ts", "syncDue"], ["prTracking/records.ts", "claimDue"],
    ["onboarding/prepare.ts", "refreshActive"], ["onboarding/prepare.ts", "syncDue"], ["onboarding/records.ts", "claimDue"],
    ["routing/log.ts", "settlePending"], ["account/deletion.ts", "resumeStalled"],
  ]) assert.ok(names(file).includes(name), `${file}:${name} is reached from convex/crons.ts`);
  assert.deepEqual(cronProblems(reached), [], "Read a cron's rows through an index range (a due time, an eq() on one project) with take(n), and give each row its own action.");
  for (const [key, reason] of Object.entries(CRON_ALLOWED)) {
    const [file, name] = key.split(":");
    assert.ok(reached.get(join(root, file))?.has(name), `${key} is allowed but no cron reaches it. Remove it from CRON_ALLOWED.`);
    assert.ok(reason.length >= 30, `${key} needs a written reason`);
  }
});

// 4. Some scheduled functions read rows that others can grow on one project or one case (the monitor's cases, customers'
//    reports, chat turns), so even a read scoped to that project or case must be bounded: every read they reach ends in
//    take(n), first(), unique() or paginate(). A collect() that cannot grow is named in STRICT_ALLOWED with why.
const STRICT = [
  ["structural/records.ts", "examineContext"], // the examine_broader_causes step: a project's cases and their evidence
  ["routing/log.ts", "settlePending"], // the settling cron: every account's agent runs
  ["intake/records.ts", "claim"], ["intake/records.ts", "triageInput"], ["intake/records.ts", "land"], // triage of one report
];
const STRICT_ALLOWED = {
  "convex/workflow.ts:loadSteps:steps": "a case's steps: as many as its workflow template has, which only turtl's runner adds to",
};

export function strictProblems(reached) {
  const problems = [];
  for (const [file, names] of reached) {
    const id = relative(root, file).split("\\").join("/");
    const chains = readChains(parsed(file));
    for (const name of names) {
      const node = declarationsOf(file).get(name);
      for (const chain of chains) {
        if (!within(chain.node, node) || !has(chain, "collect") || `${id}:${name}:${chain.table}` in STRICT_ALLOWED) continue;
        problems.push(`${id}:${name}:${chain.table}: collect() in a function a scheduled read reaches, where a project's or case's rows can be grown by others`);
      }
    }
  }
  return [...new Set(problems)];
}

test("the structural step, the settling cron and triage read only a bounded number of rows, however a project grows", () => {
  const reached = reachedFrom(STRICT.map(([file, name]) => ({ file: join(convexDir, file), name })), { scheduled: false });
  for (const [file, name] of STRICT) assert.ok(reached.get(join(convexDir, file))?.has(name), `${file}:${name} exists`);
  assert.ok(reached.get(join(convexDir, "workflow.ts"))?.has("loadSteps"), "the helpers they call are followed");
  assert.deepEqual(strictProblems(reached), [], "Bound the read with take(n) (the newest or the first so many), and say in the code what is lost past it.");
  for (const [key, reason] of Object.entries(STRICT_ALLOWED)) {
    const [file, name] = key.split(":");
    assert.ok(reached.get(join(root, file))?.has(name), `${key} is allowed but nothing listed reaches it. Remove it from STRICT_ALLOWED.`);
    assert.ok(reason.length >= 30, `${key} needs a written reason`);
  }
  // The shape it was written for: the structural step read every case on the project.
  const file = join(convexDir, "example", "history.ts");
  parsedFiles.set(file, ts.createSourceFile(file, 'import { internalQuery } from "../_generated/server";\nexport const context = internalQuery({ args: {}, handler: async (ctx, { appId }) => ctx.db.query("cases").withIndex("by_app_and_signature", (q) => q.eq("appId", appId)).collect() });', ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  try {
    assert.equal(strictProblems(new Map([[file, new Set(["context"])]])).length, 1);
  } finally {
    parsedFiles.delete(file);
  }
});

test("the cron tripwire catches the pull-request sweep it was written for", () => {
  // The shape finding 15 found in prTracking/records.ts: every unsettled pull request, read whole for the 30-second cron.
  const file = join(convexDir, "example", "sweep.ts");
  const text = [
    'import { internalQuery } from "../_generated/server";',
    'export const active = internalQuery({ args: {}, handler: async (ctx) => ctx.db.query("pullRequests").withIndex("by_settled", (q) => q.eq("settledAt", undefined)).collect() });',
    'export const everything = internalQuery({ args: {}, handler: async (ctx) => ctx.db.query("apps").collect() });',
    'export const oneProject = internalQuery({ args: {}, handler: async (ctx, { appId }) => ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", appId)).collect() });',
    'export const due = internalQuery({ args: {}, handler: async (ctx) => ctx.db.query("pullRequests").withIndex("by_settled_and_next_sync", (q) => q.eq("settledAt", undefined).lte("nextSyncAt", 1)).take(100) });',
  ].join("\n");
  parsedFiles.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  try {
    assert.deepEqual(cronProblems(new Map([[file, new Set(["active", "everything", "oneProject", "due"])]])), [
      "convex/example/sweep.ts:active:pullRequests: collect() over pullRequests through an index that picks no one project, case or account in a function a cron reaches",
      "convex/example/sweep.ts:everything:apps: collect() over apps with no index in a function a cron reaches",
    ]);
  } finally {
    parsedFiles.delete(file);
  }
});

test("no read of the scheduled jobs or of a whole shared table can be made to fail by another account's activity", () => {
  const problems = sourceFiles(convexDir).flatMap((file) => problemsIn(file));
  assert.deepEqual(
    problems,
    [],
    "Bound these reads: cancel scheduled jobs by the ids kept on the row (convex/runner/jobs.ts), and read a table " +
      "through an index that picks one project, case or account (withIndex(..., q => q.eq(...))) with take(n). " +
      "If a read truly needs neither, add it to ALLOWED in this file with the reason.",
  );
});

test("the scan sees every public function, whichever module its builder comes from", () => {
  const pattern = /^export const (\w+) = (query|mutation|action)\(/gm;
  for (const file of sourceFiles(convexDir)) {
    const text = readFileSync(file, "utf8");
    const seen = publicDefinitions(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)).map((definition) => definition.name);
    for (const [, name] of text.matchAll(pattern)) assert.ok(seen.includes(name), `${relative(root, file)}:${name} is not seen`);
  }
});

test("every allowance still names a read that exists, and says why", () => {
  for (const [key, reason] of Object.entries(ALLOWED)) {
    const [file, ...rest] = key.split(":");
    const source = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const chains = readChains(source);
    const exists = rest.length === 1
      ? chains.some((chain) => chain.system && chain.table === "_scheduled_functions")
      : publicDefinitions(join(root, file), source).some((definition) => definition.name === rest[0]) && chains.some((chain) => chain.table === rest[1]);
    assert.ok(exists, `${key} is allowed but no longer exists. Remove it from ALLOWED.`);
    assert.ok(reason.length >= 30, `${key} needs a written reason`);
  }
});

test("the tripwire catches each shape it is for, and lets the bounded and demo-only reads through", () => {
  const file = join(convexDir, "example", "probe.ts");
  const scan = (body) => problemsIn(file, [
    'import { v } from "convex/values";',
    'import { query, mutation, internalMutation } from "../_generated/server";',
    'import { accessEnforced } from "../access";',
    body,
  ].join("\n"));
  // The scheduled jobs table.
  assert.equal(scan('export const a = internalMutation({ args: {}, handler: async (ctx) => { await ctx.db.system.query("_scheduled_functions").collect(); } });').length, 1, "the whole table");
  assert.equal(scan('export const a = internalMutation({ args: {}, handler: async (ctx) => { await ctx.db.system.query("_scheduled_functions").withIndex("by_creation_time").collect(); } });').length, 1, "an index with no bound");
  assert.deepEqual(scan('export const a = internalMutation({ args: {}, handler: async (ctx) => { await ctx.db.system.query("_scheduled_functions").withIndex("by_creation_time", (q) => q.gt("_creationTime", Date.now() - 1000)).take(10); } });'), []);
  // A shared table in a public function.
  assert.deepEqual(scan('export const a = query({ args: {}, handler: async (ctx) => (await ctx.db.query("recoveryMemories").collect()).length });'), ["convex/example/probe.ts:a:recoveryMemories: collect() over recoveryMemories with no index in a public function"]);
  assert.equal(scan('export const a = mutation({ args: {}, handler: async (ctx) => await ctx.db.query("pullRequests").withIndex("by_settled").collect() });').length, 1, "an index that picks nothing out");
  assert.deepEqual(scan('export const a = query({ args: { id: v.id("apps") }, handler: async (ctx, { id }) => await ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", id)).collect() });'), []);
  assert.deepEqual(scan('export const a = internalMutation({ args: {}, handler: async (ctx) => await ctx.db.query("apps").collect() });'), [], "internal functions are not public");
  // The demo's own branch.
  assert.deepEqual(scan('export const a = query({ args: {}, handler: async (ctx) => accessEnforced() ? [] : await ctx.db.query("cases").collect() });'), []);
  assert.deepEqual(scan('export const a = query({ args: {}, handler: async (ctx) => { const accounts = accessEnforced(); return accounts ? [] : await ctx.db.query("cases").collect(); } });'), []);
  assert.deepEqual(scan('export const a = query({ args: {}, handler: async (ctx) => { if (accessEnforced()) return []; return await ctx.db.query("cases").collect(); } });'), []);
  assert.equal(scan('export const a = query({ args: {}, handler: async (ctx) => accessEnforced() ? await ctx.db.query("cases").collect() : [] });').length, 1, "the accounts side is checked");
  assert.deepEqual(scan('export const a = mutation({ args: {}, handler: async (ctx) => { requireDevTools(); return await ctx.db.query("cases").collect(); } });'), [], "dev tools are closed with accounts on");
});
