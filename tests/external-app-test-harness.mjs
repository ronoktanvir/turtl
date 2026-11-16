import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { getFunctionName } from "convex/server";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./probes" && context.parentURL?.endsWith("/externalApp/repair.ts")) {
      return { url: "data:text/javascript,export const readRevision=(...args)=>globalThis.externalAppProbeMocks.readRevision(...args);export const startProbe=(...args)=>globalThis.externalAppProbeMocks.startProbe(...args)", shortCircuit: true };
    }
    try { return next(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        try { return next(`${specifier}.ts`, context); }
        catch { return next(`${specifier}.js`, context); }
      }
      throw error;
    }
  },
  load(url, context, next) {
    if (!url.endsWith(".ts")) return next(url, context);
    return { format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText };
  },
});

export const agent = await import("../convex/externalApp/agent.ts");
export const repair = await import("../convex/externalApp/repair.ts");
export const { REQUIRED_CRITERIA } = await import("../convex/externalApp/validators.ts");
export const HEAD = "a".repeat(40);
export const MERGE = "b".repeat(40);
export const BASELINE = "c".repeat(40);
export const CONDITIONS = { fixture: { id: "large-v1", scoreCount: 1_600_000 }, deadlineMs: 2000, viewport: { width: 390, height: 844 } };

export function passingResult() {
  return { verdict: "passed", failedStep: null, error: null, revision: MERGE, environment: "demo", ...structuredClone(CONDITIONS),
    startedAt: 1000, completedAt: 2000,
    steps: [1, 2, 3].map((round) => ({ step: `answer_round_${round}`, verdict: "passed", detail: "Next round shown.",
      request: { method: "POST", path: "/api/answer", status: 200, outcome: "ok", durationMs: 100 } })),
    criteria: REQUIRED_CRITERIA.map((id) => ({ id, status: "passed", detail: `${id} measured.` })),
    cleanup: { ok: true, detail: "Only probe-owned game and score removed." } };
}

export function snapshot() {
  return { title: "Repair answer ranking", url: "https://github.com/example/game/pull/42", headSha: HEAD, state: "merged",
    checks: "passing", checkRuns: [{ name: "gameplay-regression", status: "passed" }], mergeable: false, mergeableState: "merged" };
}

export function fixture() {
  let serial = 0;
  const rows = new Map();
  const put = (table, row) => {
    const id = row._id ?? `${table}-${++serial}`;
    rows.set(id, { ...structuredClone(row), _id: id, _creationTime: row._creationTime ?? ++serial, _table: table });
    return id;
  };
  put("cases", { _id: "case1", appId: "app1", journeyId: "journey1", status: "verifying" });
  put("steps", { _id: "verify1", caseId: "case1", currentAttemptId: "attempt1", purpose: "verify" });
  put("stepAttempts", { _id: "attempt1", caseId: "case1", stepId: "verify1", status: "waiting" });
  put("externalApps", { _id: "external1", appId: "app1", journeyId: "journey1", actionCatalogId: "catalog1", repo: "example/game", baseBranch: "main",
    deploymentUrl: "https://game.example", environment: "demo", revisionPath: "/api/turtl/revision", githubCredentialRef: "EXTERNAL_APP_TEST_GITHUB_TOKEN",
    probe: { workflow: "turtl-probe.yml", viewport: CONDITIONS.viewport, timeoutMinutes: 15 }, regressionCheck: "gameplay-regression",
    protectedPaths: ["tests/", "scripts/probe.ts", ".github/workflows/"], deployTimeoutMinutes: 5 });
  put("actions", { _id: "action1", caseId: "case1", status: "completed", environment: "demo", requestedAt: 100,
    executionPayload: { config: { kind: "capy", repoUrl: "https://github.com/example/game", baseBranch: "main" } } });
  put("pullRequests", { _id: "pull1", caseId: "case1", actionId: "action1", repo: "example/game", baseBranch: "main", number: 42,
    source: "capy", capyThreadId: "thread1", snapshot: snapshot(), mergeCommitSha: MERGE });
  put("probeRuns", { _id: "before1", caseId: "case1", externalAppId: "external1", appId: "app1", purpose: "reproduce", requestedAt: 50,
    outcome: "failed", revisionBefore: BASELINE, revisionAfter: BASELINE, result: { ...passingResult(), verdict: "failed", revision: BASELINE } });
  const scheduled = [];
  const held = [];
  const db = {
    async get(id) { return structuredClone(rows.get(id) ?? null); },
    query(table) {
      const predicates = [];
      let descending = false;
      const query = {
        withIndex(_name, filter) {
          const range = { eq(key, value) { predicates.push((row) => row[key] === value); return range; } };
          filter(range);
          return query;
        },
        order(value) { descending = value === "desc"; return query; },
        async collect() {
          const result = [...rows.values()].filter((row) => row._table === table && predicates.every((predicate) => predicate(row)))
            .sort((a, b) => descending ? b._creationTime - a._creationTime : a._creationTime - b._creationTime);
          return structuredClone(result);
        },
        async first() { return (await query.collect())[0] ?? null; },
        async unique() {
          const result = await query.collect();
          if (result.length > 1) throw new Error("Duplicate fixture query result.");
          return result[0] ?? null;
        },
      };
      return query;
    },
    async insert(table, row) { return put(table, row); },
    async patch(id, fields) { rows.set(id, { ...rows.get(id), ...structuredClone(fields) }); },
  };
  const mutationCtx = { db, scheduler: { async runAfter(delay, reference, args) { scheduled.push({ delay, name: getFunctionName(reference), args }); } } };
  const ctx = {
    ...mutationCtx,
    async runQuery(reference, args) {
      const [module, name] = getFunctionName(reference).split(":");
      return (module === "externalApp/agent" ? agent : repair)[name]._handler(mutationCtx, args);
    },
    async runMutation(reference, args) {
      const [module, name] = getFunctionName(reference).split(":");
      if (module === "externalApp/records" && name === "holdClock") { held.push(args); return; }
      return (module === "externalApp/agent" ? agent : repair)[name]._handler(mutationCtx, args);
    },
  };
  const tableRows = (table) => [...rows.values()].filter((row) => row._table === table);
  const addProof = (fields = {}) => put("repairProofs", { _id: "proof1", caseId: "case1", externalAppId: "external1", actionId: "action1",
    pullRequestId: "pull1", stepAttemptId: "attempt1", candidate: repair.candidateFact(snapshot(), "gameplay-regression", "passed", Date.now()),
    deployment: { status: "waiting", expectedSha: MERGE, environment: "demo", waitingSince: Date.now() }, gameplay: { status: "not_run" }, ...fields });
  const addProbe = (fields = {}) => put("probeRuns", { _id: "after1", caseId: "case1", stepAttemptId: "attempt1", externalAppId: "external1", appId: "app1",
    purpose: "verify", expectedRevision: MERGE, revisionBefore: MERGE, revisionAfter: MERGE, outcome: "passed", completedAt: Date.now(),
    githubRunUrl: "https://github.com/example/game/actions/runs/99", result: passingResult(), ...fields });
  return { ctx, db, rows, put, scheduled, held, tableRows, addProof, addProbe };
}

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function githubResponses({ merged = true, mergeSha = MERGE, conclusion = "success" } = {}) {
  return async (url) => {
    if (url.endsWith("/pulls/42")) return json({ title: "Repair answer ranking", html_url: "https://github.com/example/game/pull/42",
      state: merged ? "closed" : "open", merged, mergeable: false, merge_commit_sha: mergeSha, head: { sha: HEAD } });
    if (url.includes("/check-runs")) return json({ check_runs: [{ name: "gameplay-regression", status: "completed", conclusion, html_url: null }] });
    if (url.includes("/status?")) return json({ statuses: [] });
    throw new Error(`Unexpected mocked URL ${url}`);
  };
}
