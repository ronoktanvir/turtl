import type { WithoutSystemFields } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, type ActionCtx, type MutationCtx } from "../_generated/server";
import { accessEnforced, MAX_PROJECTS, requireAccount } from "../access";
import { CLOSED_CASE_STATUSES } from "../constants";
import { latestAgreement } from "../consent/permission";
import { eraseRows, eraseSignInMethods, expireSessions, type Progress } from "./erasers";
import { accountErasers, callEntry, caseErasers, namespaces, projectErasers, type Eraser } from "./registry";
import { vVendorService, type VendorTask } from "./schema";
import { runVendorTask, type Outcome } from "./vendors";

// Deleting an account (checklist RC-23, RC-25; convex/account/README.md).
//
// request (public): the signed-in account asks to be deleted. In the same transaction its sessions end (convex/access.ts
// refuses an ended session at once, though the app's token has not expired), its ways to sign in are removed, and its
// AI permission is taken back, so nothing more is sent to a model, Supermemory, Capy or Keiki for it. Its phones are
// removed next (internal.push.devices.removeAccount), then the job starts.
//
// The job (run, an action, driving next, a mutation) goes through these stages, a bounded batch at a time, keeping its
// place in the accountDeletions row, so it can stop anywhere and resume, and doing it twice changes nothing:
//   stop    switch off what still watches and spends for each project: the monitor's journeys, standing permissions,
//           the report form's keys, reports waiting for triage, and open cases (closed, so the runner starts nothing).
//   settle  wait SETTLE_MS, longer than any Convex action runs, so no call that passed the permission check before the
//           stop can still write anything afterwards.
//   erase   first the copies at vendors, while turtl still knows what to ask for (Supermemory namespaces, GitHub
//           installations, Apple tokens); then each project's cases and rows and the project (registry.ts); then the
//           account's own rows, the sign-in records last.
//   waiting a vendor deletion failed: it is retried with growing waits, without holding up the rest.
//   done    the record keeps only a hash of the account id, the times and counts.
// A crashed run is restarted by resumeStalled (convex/crons.ts).

export const NO_ACCOUNTS = "This turtl has no accounts, so there is no account to delete.";

/** Rows deleted or changed by one call of next. Small, because a step attempt or a code map can be large. */
export const BATCH = 64;
/** Convex stops an action after 10 minutes; waiting a little longer means none that started before the stop is left. */
export const SETTLE_MS = 11 * 60_000;
const LEASE_MS = 9 * 60_000;
const RUN_MS = 4 * 60_000;
const RETRY_MS = 5 * 60_000;
/** A running job whose wakeAt is this far in the past has stopped; the cron starts it again. */
const STALL_MS = 15 * 60_000;
/** Waits before retrying a vendor deletion: 1 minute, 5, 30, 2 hours, 6, then once a day. */
const VENDOR_BACKOFF_MS = [1, 5, 30, 120, 360, 1440].map((minutes) => minutes * 60_000);
const VENDOR_BATCH = 20;

const CLOSED: readonly string[] = CLOSED_CASE_STATUSES;
const EMPTY_REMOVED = { projects: 0, cases: 0, rows: 0, files: 0 };

type Record_ = Doc<"accountDeletions">;
type Patch = Partial<WithoutSystemFields<Record_>>;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const vNextStep = v.union(
  v.object({ kind: v.literal("worked") }),
  v.object({
    kind: v.literal("call"),
    scope: v.union(v.literal("project"), v.literal("account")),
    name: v.string(),
    args: v.union(v.object({ appId: v.id("apps") }), v.object({ account: v.string() })),
  }),
  v.object({ kind: v.literal("vendors") }),
  v.object({ kind: v.literal("wait"), until: v.number() }),
  v.object({ kind: v.literal("finished") }),
  v.object({ kind: v.literal("busy") }),
);
type NextStep = Infer<typeof vNextStep>;
const worked: NextStep = { kind: "worked" };

// ---------------------------------------------------------------------------------------------- for the app

/** The signed-in account asks to be deleted. Refuses in the single-owner demo, which has no accounts. */
export const request = mutation({
  args: {},
  returns: v.object({ requestedAt: v.number() }),
  handler: async (ctx) => {
    if (!accessEnforced()) throw new ConvexError(NO_ACCOUNTS);
    const account = await requireAccount(ctx);
    const running = await ctx.db.query("accountDeletions").withIndex("by_account", (q) => q.eq("account", account)).first();
    if (running) return { requestedAt: running.requestedAt };
    const now = Date.now();
    const deletionId = await ctx.db.insert("accountDeletions", {
      account,
      accountHash: await sha256Hex(account),
      status: "running",
      stage: "stop",
      requestedAt: now,
      updatedAt: now,
      wakeAt: now,
      vendors: [],
      removed: EMPTY_REMOVED,
    });
    await stopAccount(ctx, account, now);
    await ctx.scheduler.runAfter(0, internal.push.devices.removeAccount, { account });
    await ctx.scheduler.runAfter(0, internal.account.deletion.run, { deletionId });
    return { requestedAt: now };
  },
});

/** What happens the moment a deletion is accepted: sessions end, nobody can sign in again, the AI permission is taken back. */
async function stopAccount(ctx: MutationCtx, account: string, now: number) {
  const userId = ctx.db.normalizeId("users", account);
  if (userId) {
    await expireSessions(ctx, userId, 100);
    await eraseSignInMethods(ctx, userId, 100);
  }
  const consent = await latestAgreement(ctx, account);
  if (consent?.answer === "allowed" && consent.withdrawnAt === undefined) await ctx.db.patch(consent._id, { withdrawnAt: now });
}

// ---------------------------------------------------------------------------------------------- the job

/** Drives the job: asks next what to do, does what needs an action (a registry call, a vendor), and starts itself
 * again before Convex's time limit. Only one driver works at a time (the lease in the record). */
export const run = internalAction({
  args: { deletionId: v.id("accountDeletions") },
  returns: v.null(),
  handler: async (ctx, { deletionId }) => {
    const driver = crypto.randomUUID();
    const started = Date.now();
    try {
      while (Date.now() - started < RUN_MS) {
        const step: NextStep = await ctx.runMutation(internal.account.deletion.next, { deletionId, driver });
        if (step.kind === "worked") continue;
        if (step.kind === "call") {
          await callEraser(ctx, deletionId, driver, step);
          continue;
        }
        if (step.kind === "vendors") {
          await vendorPass(ctx, deletionId, driver);
          continue;
        }
        if (step.kind === "wait") await ctx.scheduler.runAt(step.until, internal.account.deletion.run, { deletionId });
        return null;
      }
      await ctx.runMutation(internal.account.deletion.release, { deletionId, driver, wakeAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.account.deletion.run, { deletionId });
    } catch (error) {
      // The batch that failed changed nothing; the next run starts from the record. The reason never holds a value.
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
      console.error(`Account deletion ${deletionId} stopped (${reason.slice(0, 200)}); it resumes in ${RETRY_MS / 60_000} minutes.`);
      await ctx.runMutation(internal.account.deletion.release, { deletionId, driver, wakeAt: Date.now() + RETRY_MS, error: reason.slice(0, 300) });
      await ctx.scheduler.runAfter(RETRY_MS, internal.account.deletion.run, { deletionId });
    }
    return null;
  },
});

async function callEraser(ctx: ActionCtx, deletionId: Id<"accountDeletions">, driver: string, step: Extract<NextStep, { kind: "call" }>) {
  const entry = callEntry(step.scope, step.name);
  // An entry the registry no longer has (a later deploy removed it) counts as done.
  const result: { done: boolean } = entry ? await ctx.runMutation(entry.run as never, step.args as never) : { done: true };
  await ctx.runMutation(internal.account.deletion.called, { deletionId, driver, name: step.name, done: result.done });
}

async function vendorPass(ctx: ActionCtx, deletionId: Id<"accountDeletions">, driver: string) {
  const due: { account: string; tasks: { index: number; service: VendorTask["service"]; target?: string }[] } | null = await ctx.runMutation(
    internal.account.deletion.dueVendors,
    { deletionId, driver },
  );
  if (!due) return;
  for (const task of due.tasks) {
    let outcome: Outcome;
    try {
      outcome = await runVendorTask(ctx, due.account, task);
    } catch (error) {
      outcome = { ok: false, note: `The request could not be made (${error instanceof Error ? error.name : "unknown error"}).` };
    }
    await ctx.runMutation(internal.account.deletion.vendorDone, {
      deletionId,
      index: task.index,
      ok: outcome.ok,
      skipped: outcome.ok ? (outcome.skipped ?? false) : false,
      ...(outcome.note !== undefined && { note: outcome.note.slice(0, 300) }),
    });
  }
}

/** Does one bounded batch of the job and says what the driver should do next. */
export const next = internalMutation({
  args: { deletionId: v.id("accountDeletions"), driver: v.string() },
  returns: vNextStep,
  handler: async (ctx, { deletionId, driver }): Promise<NextStep> => {
    const record = await ctx.db.get(deletionId);
    if (!record || record.status === "done" || !record.account) return { kind: "finished" };
    const now = Date.now();
    if (record.lease && record.lease.driver !== driver && record.lease.until > now) return { kind: "busy" };
    const patch: Patch = { lease: { driver, until: now + LEASE_MS }, updatedAt: now, wakeAt: now };
    const step = await advance(ctx, record, record.account, patch, now);
    if (step.kind === "wait") Object.assign(patch, { wakeAt: step.until, lease: undefined });
    await ctx.db.patch(deletionId, patch);
    return step;
  },
});

async function advance(ctx: MutationCtx, record: Record_, account: string, patch: Patch, now: number): Promise<NextStep> {
  switch (record.stage) {
    case "stop": {
      const stopped = await stopBatch(ctx, account, record.stopped ?? { project: 0, cases: 0 }, now);
      patch.stopped = stopped.at;
      if (!stopped.done) return worked;
      const settleUntil = now + SETTLE_MS;
      Object.assign(patch, { stage: "settle", settleUntil });
      return { kind: "wait", until: settleUntil };
    }
    case "settle": {
      if (now < (record.settleUntil ?? 0)) return { kind: "wait", until: record.settleUntil ?? now };
      patch.stage = "erase";
      patch.vendors = record.vendors.length ? record.vendors : await vendorTasks(ctx, account, now);
      return { kind: "vendors" };
    }
    case "erase": {
      // Every vendor deletion is tried once before any row goes.
      if (record.vendors.some((task) => task.state === "pending" && task.tries === 0)) return { kind: "vendors" };
      const step = await eraseBatch(ctx, record, account, patch);
      if (step !== "done") return step;
      patch.stage = "waiting";
      return waitForVendors(record, patch, now);
    }
    case "waiting":
      return waitForVendors(record, patch, now);
    default:
      return { kind: "finished" };
  }
}

// --- stop

async function stopBatch(ctx: MutationCtx, account: string, at: { project: number; cases: number }, now: number): Promise<{ done: boolean; at: { project: number; cases: number } }> {
  let left = BATCH;
  let { project, cases } = at;
  const userId = ctx.db.normalizeId("users", account);
  if (userId) {
    for (const step of [expireSessions, eraseSignInMethods]) {
      const progress = await step(ctx, userId, left);
      left -= progress.removed;
      if (!progress.done) return { done: false, at };
    }
  }
  while (left > 0) {
    const app = await ctx.db.query("apps").withIndex("by_owner", (q) => q.eq("ownerId", account).gt("_creationTime", project)).first();
    if (!app) return { done: true, at: { project, cases } };
    // The monitor checks journeys; a standing permission lets turtl act without asking.
    for (const table of ["journeys", "permissions"] as const) {
      const progress = await eraseRows(ctx, { table, index: "by_app", field: "appId" }, app._id, left);
      left -= progress.removed;
      if (!progress.done) return { done: false, at: { project, cases } };
    }
    // Reports waiting for triage would each ask a model or open a case.
    const waiting = await ctx.db.query("reportTriage").withIndex("by_app_and_status", (q) => q.eq("appId", app._id).eq("status", "pending")).take(left + 1);
    for (const row of waiting.slice(0, left)) await ctx.db.delete(row._id);
    left -= Math.min(waiting.length, left);
    if (waiting.length > 0 && left <= 0) return { done: false, at: { project, cases } };
    // The report form refuses a revoked key.
    for (const key of await ctx.db.query("intakeKeys").withIndex("by_app", (q) => q.eq("appId", app._id)).take(200)) {
      if (key.revokedAt === undefined) {
        await ctx.db.patch(key._id, { revokedAt: now });
        left--;
      }
    }
    // An open case is closed, so the runner starts no new step on it.
    const want = Math.max(left, 1);
    const page = await ctx.db.query("cases").withIndex("by_app", (q) => q.eq("appId", app._id).gt("_creationTime", cases)).take(want);
    for (const row of page) {
      left--;
      cases = row._creationTime;
      if (!CLOSED.includes(row.status)) await ctx.db.patch(row._id, { status: "declined" });
    }
    if (page.length < want) {
      project = app._creationTime;
      cases = 0;
    }
  }
  return { done: false, at: { project, cases } };
}

// --- vendors

async function vendorTasks(ctx: MutationCtx, account: string, now: number): Promise<VendorTask[]> {
  const names = new Set<string>();
  for (const app of await ctx.db.query("apps").withIndex("by_owner", (q) => q.eq("ownerId", account)).take(MAX_PROJECTS)) {
    for (const name of namespaces) names.add(name(app._id));
    for (const network of await ctx.db.query("codeNetworks").withIndex("by_project", (q) => q.eq("projectId", app._id)).take(5)) names.add(network.namespace);
  }
  const task = (service: VendorTask["service"], target?: string): VendorTask => ({ service, ...(target !== undefined && { target }), state: "pending", tries: 0, nextAt: now });
  return [...[...names].sort().map((name) => task("supermemory", name)), task("github"), task("apple")];
}

function waitForVendors(record: Record_, patch: Patch, now: number): NextStep {
  const vendors = patch.vendors ?? record.vendors;
  const pending = vendors.filter((task) => task.state === "pending");
  if (!pending.length) return finish(record, patch, now);
  if (pending.some((task) => task.tries === 0 || task.nextAt <= now)) return { kind: "vendors" };
  return { kind: "wait", until: Math.min(...pending.map((task) => task.nextAt)) };
}

function finish(record: Record_, patch: Patch, now: number): NextStep {
  Object.assign(patch, {
    status: "done",
    stage: "done",
    finishedAt: now,
    account: undefined,
    current: undefined,
    stopped: undefined,
    settleUntil: undefined,
    lease: undefined,
    lastError: undefined,
    // The namespaces are names built from project ids that no longer exist; they go too.
    vendors: (patch.vendors ?? record.vendors).map(({ target: _target, ...task }) => task),
  } satisfies Patch);
  return { kind: "finished" };
}

// --- erase

type Pass = Progress & { call?: string };

async function runErasers(ctx: MutationCtx, list: Eraser[], target: string, budget: number, calls: string[]): Promise<Pass> {
  let removed = 0;
  let files = 0;
  for (const entry of list) {
    if (budget - removed <= 0) return { removed, files, done: false };
    if (entry.kind === "call") {
      if (!calls.includes(entry.name)) return { removed, files, done: false, call: entry.name };
      continue;
    }
    const progress = entry.kind === "rows" ? await eraseRows(ctx, entry, target, budget - removed) : await entry.erase(ctx, target, budget - removed);
    removed += progress.removed;
    files += progress.files;
    if (!progress.done) return { removed, files, done: false };
  }
  return { removed, files, done: true };
}

async function eraseBatch(ctx: MutationCtx, record: Record_, account: string, patch: Patch): Promise<NextStep | "done"> {
  let left = BATCH;
  const removed = { ...record.removed };
  let current = record.current ?? { calls: [] };
  const save = () => Object.assign(patch, { removed, current });
  const tally = (progress: Progress) => {
    left -= progress.removed;
    removed.rows += progress.removed;
    removed.files += progress.files;
  };
  while (left > 0) {
    const app = await ctx.db.query("apps").withIndex("by_owner", (q) => q.eq("ownerId", account)).first();
    if (!app) break;
    if (current.appId !== app._id) current = { appId: app._id, calls: [] };
    const row = await ctx.db.query("cases").withIndex("by_app", (q) => q.eq("appId", app._id)).first();
    if (row) {
      const pass = await runErasers(ctx, caseErasers, row._id, left, []);
      tally(pass);
      if (!pass.done) break;
      await ctx.db.delete(row._id);
      removed.cases++;
      left--;
      continue;
    }
    const pass = await runErasers(ctx, projectErasers, app._id, left, current.calls);
    tally(pass);
    if (pass.call) {
      save();
      return { kind: "call", scope: "project", name: pass.call, args: { appId: app._id } };
    }
    if (!pass.done) break;
    await ctx.db.delete(app._id);
    removed.projects++;
    left--;
    current = { calls: [] };
  }
  if (left <= 0 || (await ctx.db.query("apps").withIndex("by_owner", (q) => q.eq("ownerId", account)).first())) {
    save();
    return worked;
  }
  if (current.appId !== undefined) current = { calls: [] };
  const pass = await runErasers(ctx, accountErasers, account, left, current.calls);
  tally(pass);
  save();
  if (pass.call) return { kind: "call", scope: "account", name: pass.call, args: { account } };
  return pass.done ? "done" : worked;
}

// --- what the driver reports back

export const called = internalMutation({
  args: { deletionId: v.id("accountDeletions"), driver: v.string(), name: v.string(), done: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { deletionId, driver, name, done }) => {
    const record = await ctx.db.get(deletionId);
    if (!record || record.lease?.driver !== driver) return null;
    const current = record.current ?? { calls: [] };
    const now = Date.now();
    await ctx.db.patch(deletionId, {
      updatedAt: now,
      wakeAt: now,
      ...(done && !current.calls.includes(name) && { current: { ...current, calls: [...current.calls, name] } }),
    });
    return null;
  },
});

export const dueVendors = internalMutation({
  args: { deletionId: v.id("accountDeletions"), driver: v.string() },
  returns: v.union(
    v.null(),
    v.object({ account: v.string(), tasks: v.array(v.object({ index: v.number(), service: vVendorService, target: v.optional(v.string()) })) }),
  ),
  handler: async (ctx, { deletionId, driver }) => {
    const record = await ctx.db.get(deletionId);
    if (!record?.account || record.lease?.driver !== driver) return null;
    const now = Date.now();
    const tasks = record.vendors
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => task.state === "pending" && (task.tries === 0 || task.nextAt <= now))
      .slice(0, VENDOR_BATCH)
      .map(({ task, index }) => ({ index, service: task.service, ...(task.target !== undefined && { target: task.target }) }));
    await ctx.db.patch(deletionId, { updatedAt: now, wakeAt: now, lease: { driver, until: now + LEASE_MS } });
    return { account: record.account, tasks };
  },
});

export const vendorDone = internalMutation({
  args: { deletionId: v.id("accountDeletions"), index: v.number(), ok: v.boolean(), skipped: v.boolean(), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { deletionId, index, ok, skipped, note }) => {
    const record = await ctx.db.get(deletionId);
    const task = record?.vendors[index];
    if (!record || !task || task.state !== "pending") return null;
    const now = Date.now();
    const tries = task.tries + 1;
    const next: VendorTask = ok
      ? { ...task, state: skipped ? "skipped" : "done", tries, nextAt: now, ...(note !== undefined && { note }) }
      : { ...task, tries, nextAt: now + VENDOR_BACKOFF_MS[Math.min(tries, VENDOR_BACKOFF_MS.length) - 1], ...(note !== undefined && { note }) };
    if (!ok) console.error(`Account deletion ${deletionId}: ${task.service} did not confirm (try ${tries}); it is tried again later.`);
    await ctx.db.patch(deletionId, { vendors: record.vendors.map((row, at) => (at === index ? next : row)), updatedAt: now, wakeAt: now });
    return null;
  },
});

export const release = internalMutation({
  args: { deletionId: v.id("accountDeletions"), driver: v.string(), wakeAt: v.number(), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { deletionId, driver, wakeAt, error }) => {
    const record = await ctx.db.get(deletionId);
    if (!record || record.status === "done" || (record.lease && record.lease.driver !== driver)) return null;
    await ctx.db.patch(deletionId, { lease: undefined, wakeAt, updatedAt: Date.now(), ...(error !== undefined && { lastError: error }) });
    return null;
  },
});

// ---------------------------------------------------------------------------------------------- for operators

/** Run by convex/crons.ts: starts again any job that should have run long ago (its run crashed or was lost). */
export const resumeStalled = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const stalled = await ctx.db
      .query("accountDeletions")
      .withIndex("by_status_and_wake", (q) => q.eq("status", "running").lt("wakeAt", now - STALL_MS))
      .take(20);
    for (const row of stalled) {
      await ctx.db.patch(row._id, { wakeAt: now });
      await ctx.scheduler.runAfter(0, internal.account.deletion.run, { deletionId: row._id });
    }
    return stalled.length;
  },
});

/** Skips the settle wait and retries vendors now. Only for a local proof, or once you know nothing for the account is
 * still running:  npx convex run account/deletion:hurry '{"account":"<users id>"}' */
export const hurry = internalMutation({
  args: { account: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { account }) => {
    const record = await ctx.db.query("accountDeletions").withIndex("by_account", (q) => q.eq("account", account)).first();
    if (!record || record.status === "done") return false;
    const now = Date.now();
    await ctx.db.patch(record._id, {
      wakeAt: now,
      lease: undefined,
      ...(record.stage === "settle" && { settleUntil: now }),
      vendors: record.vendors.map((task) => (task.state === "pending" ? { ...task, nextAt: now } : task)),
    });
    await ctx.scheduler.runAfter(0, internal.account.deletion.run, { deletionId: record._id });
    return true;
  },
});

/** Was this account deleted, and when: npx convex run account/deletion:lookup '{"account":"<users id>"}'. */
export const lookup = internalQuery({
  args: { account: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      status: v.union(v.literal("running"), v.literal("done")),
      stage: v.string(),
      requestedAt: v.number(),
      finishedAt: v.optional(v.number()),
      removed: v.object({ projects: v.number(), cases: v.number(), rows: v.number(), files: v.number() }),
      vendors: v.array(v.object({ service: vVendorService, state: v.string(), tries: v.number(), note: v.optional(v.string()) })),
      lastError: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { account }) => {
    const accountHash = await sha256Hex(account);
    const record = await ctx.db.query("accountDeletions").withIndex("by_account_hash", (q) => q.eq("accountHash", accountHash)).first();
    if (!record) return null;
    return {
      status: record.status,
      stage: record.stage,
      requestedAt: record.requestedAt,
      ...(record.finishedAt !== undefined && { finishedAt: record.finishedAt }),
      removed: record.removed,
      vendors: record.vendors.map(({ service, state, tries, note }) => ({ service, state, tries, ...(note !== undefined && { note }) })),
      ...(record.lastError !== undefined && { lastError: record.lastError }),
    };
  },
});
