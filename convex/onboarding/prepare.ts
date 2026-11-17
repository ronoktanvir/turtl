import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { accessEnforced, demoHoldsAccountsInAction } from "../access";
import { gateFor } from "../consent/gate";
import { repositoryAccess } from "../github/access";
import { findPullRequestNumber, startCapyThread } from "../prTracking/capy";
import { capyConfigFor, codingAgentFor } from "../prTracking/codingAgent";
import { FOLLOW_CLAIMS } from "../prTracking/follow";
import { readPullRequest } from "../prTracking/github";
import { call, describeFailure, readProbe, runJourneyCheck, type Probe, type WatchedApp } from "../protectedApp/client";
import { watchedApp } from "../protectedApp/watched";
import { MANIFEST_CHECK_VERSION, manifestPath, parseManifest, type Item, type ManifestCheck, type ManifestSwitch } from "./detect";
import { preparationBrief } from "./brief";
import { headCommit, readRaw } from "./github";

type PreparationContext = { preparation: Doc<"onboardingPreparations">; app: Doc<"apps">; inspection: Doc<"onboardingInspections"> | null };

const OPENING_GRACE_MS = 2 * 60_000;
const UNAUTHENTICATED_SYNC_MS = 5 * 60_000;
export const CHECK_VERSION = MANIFEST_CHECK_VERSION;
/** The single-owner demo with no coding agent of its own set up on the backend. */
const DEMO_NO_CODING_AGENT = "This turtl backend has no coding agent set up, so turtl could not write the preparation. Nothing was sent.";

// Asks Capy to write the preparation and open one pull request. The request id is fixed per preparation and
// inspection, so a retry returns the same Capy thread instead of starting a second one.
export const start = internalAction({
  args: { preparationId: v.id("onboardingPreparations") },
  handler: async (ctx, { preparationId }): Promise<{ outcome: "missing" | "already_started" } | { outcome: "failed"; error: string } | { outcome: "started"; threadId: string }> => {
    const context: PreparationContext | null = await ctx.runQuery(internal.onboarding.records.forPreparation, { preparationId });
    if (!context) return { outcome: "missing" as const };
    const { preparation, app, inspection } = context;
    if (preparation.capyThreadId || preparation.settledAt !== undefined) return { outcome: "already_started" as const };
    const fail = async (error: string) => {
      await ctx.runMutation(internal.onboarding.records.failOpening, { id: preparationId, error });
      return { outcome: "failed" as const, error };
    };
    if (!inspection || inspection.status !== "done" || !inspection.stack || !inspection.ref || !preparation.requestId || !preparation.repo) {
      return fail("The approved readiness report is not complete, so nothing was sent to Capy.");
    }
    // With accounts on, nothing starts unless the owner's own coding agent and GitHub connection both cover it. Each
    // refusal hands the approval back with the reason, so the owner can fix it and approve again.
    const refuse = async (reason: string) => {
      const error = `turtl did not start the preparation: ${reason} Nothing was sent to the coding agent.`;
      await ctx.runMutation(internal.onboarding.records.refuseStart, { id: preparationId, reason: error });
      return { outcome: "failed" as const, error };
    };
    const capy = await codingAgentFor(ctx, { appId: app._id }, preparation.repo);
    if (!capy.ok) return accessEnforced() && capy.reason ? refuse(capy.reason) : fail(DEMO_NO_CODING_AGENT);
    const { title, message } = preparationBrief({
      appName: app.name,
      repo: preparation.repo,
      baseBranch: preparation.baseBranch ?? inspection.defaultBranch ?? "main",
      folders: inspection.folders,
      ...(app.productionUrl && { liveUrl: app.productionUrl }),
      ref: inspection.ref,
      stack: inspection.stack,
      items: inspection.items as Item[],
      hasManifest: inspection.hasManifest ?? false,
      neverBreak: preparation.neverBreak,
      accounts: accessEnforced(),
    });
    const started = await startCapyThread(gateFor(ctx, { appId: app._id }), capy, { repo: preparation.repo, requestId: preparation.requestId, title: title.slice(0, 120), message });
    if (!started.ok) return fail(`Could not ask Capy to write the preparation: ${started.message}`);
    await ctx.runMutation(internal.onboarding.records.recordThread, { id: preparationId, capyThreadId: started.body.threadId, brief: message });
    return { outcome: "started" as const, threadId: started.body.threadId };
  },
});

// GitHub read with the token, or without it when there is none or GitHub rejects it (public repositories).
async function readPull(repo: string, number: number, token: string | undefined) {
  const read = await readPullRequest(token ?? "", repo, number);
  if (!read.ok && read.status === 401 && token) return { read: await readPullRequest("", repo, number), authenticated: false };
  return { read, authenticated: Boolean(token) };
}

export async function syncPreparation(ctx: ActionCtx, row: Doc<"onboardingPreparations">, force: boolean): Promise<string> {
  if (row.settledAt !== undefined || !row.repo) return "settled";
  let number = row.number;
  if (number === undefined) {
    if (!row.capyThreadId) return "not_started";
    const capy = await capyConfigFor(ctx, { appId: row.appId });
    if (!capy.ok) return "not_configured";
    const found = await findPullRequestNumber(gateFor(ctx, { appId: row.appId }), capy, row.capyThreadId, row.repo, row.capyCursor);
    if (!found.ok) {
      await ctx.runMutation(internal.onboarding.records.recordSyncError, { id: row._id, error: found.message });
      return "failed";
    }
    if (found.body.cursor && found.body.cursor !== row.capyCursor) {
      await ctx.runMutation(internal.onboarding.records.setCapyCursor, { id: row._id, cursor: found.body.cursor });
    }
    if (found.body.number === undefined) {
      if (found.body.stopped && Date.now() - (row.requestedAt ?? 0) > OPENING_GRACE_MS) {
        await ctx.runMutation(internal.onboarding.records.failOpening, {
          id: row._id,
          error: `Capy stopped (${found.body.status}) without opening a pull request in ${row.repo}.`,
        });
        return "failed";
      }
      return "opening";
    }
    number = found.body.number;
    await ctx.runMutation(internal.onboarding.records.setNumber, { id: row._id, number });
  }
  const access = await repositoryAccess(ctx, row.repo, { appId: row.appId });
  if (!access.ok) {
    await ctx.runMutation(internal.onboarding.records.recordSyncError, { id: row._id, error: access.message });
    return "failed";
  }
  if (row.number !== undefined && !force && !access.token && row.syncedAt !== undefined && Date.now() - row.syncedAt < UNAUTHENTICATED_SYNC_MS) {
    return "waiting";
  }
  const { read } = await readPull(row.repo, number, access.token);
  if (!read.ok) {
    await ctx.runMutation(internal.onboarding.records.recordSyncError, { id: row._id, error: read.message });
    return "failed";
  }
  await ctx.runMutation(internal.onboarding.records.applySnapshot, { id: row._id, ...read.body });
  return read.body.snapshot.state;
}

// Every minute: preparations whose pull request is being opened or is still open. Without a working GitHub
// token an open pull request is read every five minutes, to stay inside GitHub's limit for anonymous reads.
// Each preparation whose next read has come gets its own action, claimed a batch at a time (convex/prTracking/
// follow.ts), so no account's preparations hold up another's, and a newer one is never left behind older ones.
export const refreshActive = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    // The single-owner demo on a deployment that holds accounts follows nothing (convex/access.ts).
    if (await demoHoldsAccountsInAction(ctx)) return 0;
    let started = 0;
    for (let claims = 0; claims < FOLLOW_CLAIMS; claims++) {
      const { ids, more }: { ids: Id<"onboardingPreparations">[]; more: boolean } = await ctx.runMutation(internal.onboarding.records.claimDue, {});
      started += ids.length;
      if (!more) break;
    }
    return started;
  },
});

// One preparation's read, which then says when the next one is due.
export const syncDue = internalAction({
  args: { id: v.id("onboardingPreparations") },
  handler: async (ctx, { id }): Promise<string> => {
    try {
      const row: Doc<"onboardingPreparations"> | null = await ctx.runQuery(internal.onboarding.records.get, { id });
      return row ? await syncPreparation(ctx, row, false) : "missing";
    } finally {
      await ctx.runMutation(internal.onboarding.records.followNext, { id });
    }
  },
});

type Check = {
  result: {
    kind: "health" | "readiness" | "journey" | "flag" | "recovery_hook";
    name: string;
    url: string;
    state: "works" | "failing" | "no_response";
    detail: string;
    checkedAt: number;
  };
  journey?: { name: string; description: string; check: { kind: "http"; config: { url: string; method: "GET" | "POST"; expectedStatus: number; credentialRef?: string } }; checkVersion: string; probe?: Probe };
  action?: {
    type: string;
    name: string;
    description: string;
    config: { kind: "http"; url: string; method: "POST"; credentialRef?: string };
    parameterConstraints: { name: string; type: "string" | "boolean"; required: boolean; allowedValues?: (string | boolean)[] }[];
  };
  passedAt?: number;
};

/** At most this many of the manifest's endpoints are called at once, so a long list stays inside an action's time. */
const CONCURRENT_PROBES = 6;

// Calls each endpoint the manifest names on the live app now, for this project (app): with accounts on only on its own
// live address and with its own control token. Only what answers is registered: health and readiness and journey
// checks as journeys, flags and recovery hooks as catalog actions. Results keep the manifest's order. A health or
// readiness endpoint is registered as a GET check that says which probe it is, read here exactly as the monitor reads
// it each round after (convex/protectedApp/client.ts, readProbe).
export async function checkLive(base: string, manifest: ReturnType<typeof parseManifest> & { ok: true }, ref: string, app: WatchedApp): Promise<Check[]> {
  const { credentialRef } = manifest.manifest;
  const checkVersion = `${CHECK_VERSION}:${ref.slice(0, 12)}`;
  const url = (entry: ManifestCheck) => `${base}${entry.path}`;
  const credential = (entry: ManifestCheck) => (entry.authenticated ? credentialRef : undefined);
  const probe = async (kind: Probe, entry: ManifestCheck): Promise<Check> => {
    const checkedAt = Date.now();
    const response = await call(url(entry), { app, credentialRef: credential(entry) });
    const answered = response.kind === "response";
    const got = readProbe(kind, response);
    const ok = got.kind === "passed";
    const notReady = got.kind === "not_ready";
    return {
      result: {
        kind,
        name: entry.name,
        url: url(entry),
        state: ok ? "works" : notReady ? "failing" : "no_response",
        detail: ok
          ? `Answered 200 in ${got.durationMs} ms.`
          : notReady
            ? "Answered that the app is not ready to serve customers now."
            : `Not registered: ${answered ? `answered ${describeFailure(response)} instead of 200` : describeFailure(response)}.`,
        checkedAt,
      },
      ...((ok || notReady) && {
        journey: {
          name: entry.name,
          description: entry.description ?? (kind === "health" ? "The server answers its health check." : "The app says it can serve customers now."),
          check: { kind: "http", config: { url: url(entry), method: "GET", expectedStatus: 200, ...(credential(entry) && { credentialRef: credential(entry) }) } },
          checkVersion,
          probe: kind,
        },
      }),
      ...(ok && { passedAt: checkedAt }),
    };
  };
  const journey = async (entry: ManifestCheck): Promise<Check> => {
    const checkedAt = Date.now();
    const outcome = await runJourneyCheck({ url: url(entry), ...(credential(entry) && { credentialRef: credential(entry) }) }, app);
    const passed = outcome.ok && outcome.result.verdict === "passed";
    return {
      result: {
        kind: "journey",
        name: entry.name,
        url: url(entry),
        state: !outcome.ok ? "no_response" : passed ? "works" : "failing",
        detail: !outcome.ok
          ? `Not registered: ${outcome.reason}.`
          : passed
            ? `The check passed all ${outcome.result.steps.length} steps.`
            : `The check failed at "${outcome.result.failedStep ?? "unknown"}"${outcome.result.error?.code ? ` (${outcome.result.error.code})` : ""}.`,
        checkedAt,
      },
      ...(outcome.ok && {
        journey: {
          name: entry.name,
          description: entry.description ?? entry.name,
          check: { kind: "http", config: { url: url(entry), method: "POST", expectedStatus: 200, ...(credential(entry) && { credentialRef: credential(entry) }) } },
          checkVersion,
        },
      }),
      ...(passed && { passedAt: checkedAt }),
    };
  };
  const toggle = async (entry: ManifestSwitch, kind: "flag" | "recovery_hook"): Promise<Check> => {
    const checkedAt = Date.now();
    const response = await call(url(entry), { app, credentialRef: credential(entry) });
    const value = response.kind === "response" ? (response.body as Record<string, unknown> | null)?.[entry.field] : undefined;
    const ok = response.kind === "response" && response.status === 200 && typeof value === "boolean";
    return {
      result: {
        kind,
        name: entry.name,
        url: url(entry),
        state: ok ? "works" : response.kind === "response" ? "failing" : "no_response",
        detail: ok
          ? `It answers, and it is ${value ? "on" : "off"} now. turtl switches it only after your approval.`
          : `Not registered: ${response.kind === "response" ? `${describeFailure(response)}${response.status === 200 ? ` without a boolean ${entry.field}` : ""}` : describeFailure(response)}.`,
        checkedAt,
      },
      ...(ok && {
        action: {
          type: kind === "flag" ? "set_feature_flag" : "recovery_switch",
          name: entry.name,
          description: `${entry.description ?? entry.name} Sets ${entry.field} through POST ${entry.path}. Reversible: set it back.`,
          config: { kind: "http", url: url(entry), method: "POST", ...(credential(entry) && { credentialRef: credential(entry) }) },
          parameterConstraints: [
            { name: "flag", type: "string", required: true, allowedValues: [entry.field] },
            { name: "value", type: "boolean", required: true },
          ],
        },
      }),
    };
  };
  const { health, readiness, journeys, flags, recoveryHooks } = manifest.manifest;
  const probes: (() => Promise<Check>)[] = [
    ...(health ? [() => probe("health", health)] : []),
    ...(readiness ? [() => probe("readiness", readiness)] : []),
    ...journeys.map((entry) => () => journey(entry)),
    ...flags.map((entry) => () => toggle(entry, "flag")),
    ...recoveryHooks.map((entry) => () => toggle(entry, "recovery_hook")),
  ];
  const checks: Check[] = [];
  for (let start = 0; start < probes.length; start += CONCURRENT_PROBES) {
    checks.push(...(await Promise.all(probes.slice(start, start + CONCURRENT_PROBES).map((run) => run()))));
  }
  return checks;
}

// Reads turtl.json and registers what answers on the live app; a check the file no longer lists is retired
// (records.ts, register). Right after the merge it reads the file at the merge commit. `latest`, the owner's Check
// again, reads it as it is now, at the head of the branch the preparation merged into: that is how a check the owner
// took out of the file, or added to it, reaches turtl. If that commit cannot be read, nothing is checked and nothing
// changes: it never falls back to an older commit, whose list would bring retired checks back. If the branch itself is
// gone (renamed or deleted since), it reads the repository's default branch. `startedAt` says which request this run
// answers: one that ends after a newer request was started writes nothing, so a slow run cannot put an older list back
// (records.ts, current). `ref` lets an operator check a commit from the CLI, and such a run always writes.
export const register = internalAction({
  args: { preparationId: v.id("onboardingPreparations"), ref: v.optional(v.string()), latest: v.optional(v.boolean()), startedAt: v.optional(v.number()) },
  handler: async (ctx, { preparationId, ref: requested, latest, startedAt }): Promise<{ outcome: "missing" } | { outcome: "failed"; error: string } | { outcome: "registered"; checks: string[] }> => {
    const context: PreparationContext | null = await ctx.runQuery(internal.onboarding.records.forPreparation, { preparationId });
    if (!context) return { outcome: "missing" as const };
    const { preparation, app, inspection } = context;
    let ref = requested ?? preparation.mergeCommitSha ?? preparation.registration?.ref;
    const fail = async (error: string) => {
      await ctx.runMutation(internal.onboarding.records.failRegistration, { id: preparationId, error, ...(ref && { ref }), ...(startedAt !== undefined && { startedAt }) });
      return { outcome: "failed" as const, error };
    };
    const unknownCommit = "turtl does not know the merged commit yet, so it could not read what the pull request added.";
    // Check again needs no merge commit: it reads the branch's head below.
    if (!preparation.repo || (!ref && !latest)) return fail(unknownCommit);
    if (!app.productionUrl) return fail("No live app URL was given when the project was added, so turtl could not check anything on the live app.");
    const path = manifestPath(inspection?.folders ?? []);
    const access = await repositoryAccess(ctx, preparation.repo, { appId: preparation.appId });
    if (!access.ok) return fail(`${access.message} Nothing was registered.`);
    if (latest && !requested) {
      const branch = preparation.baseBranch ?? inspection?.defaultBranch ?? "main";
      const head = await headCommit(preparation.repo, branch, access.token);
      if (!head.ok) {
        return fail(head.gone
          ? `turtl could not find the branch ${branch} in ${preparation.repo}, or the repository's default branch, so it checked nothing and changed nothing. Check that the repository is still connected to turtl.`
          : `turtl could not read the latest commit on ${branch} in ${preparation.repo}, so it checked nothing and changed nothing. Try again in a few minutes.`);
      }
      ref = head.sha;
    }
    if (!ref) return fail(unknownCommit);
    const text = await readRaw(preparation.repo, ref, path, access.token);
    if (text === null) return fail(`turtl could not read ${path} at ${ref.slice(0, 12)}, so nothing was registered.`);
    const manifest = parseManifest(text);
    if (!manifest.ok) return fail(`${manifest.reason} Nothing was registered.`);
    const checks = await checkLive(app.productionUrl.replace(/\/+$/, ""), manifest, ref, await watchedApp(ctx, { appId: app._id }));
    if (checks.length === 0) return fail(`${path} lists no endpoint, so nothing was checked or registered.`);
    await ctx.runMutation(internal.onboarding.records.register, { id: preparationId, ref, checks, ...(manifest.note && { note: manifest.note }), ...(startedAt !== undefined && { startedAt }) });
    return { outcome: "registered" as const, checks: checks.map((check) => `${check.result.kind} ${check.result.name}: ${check.result.state}`) };
  },
});
