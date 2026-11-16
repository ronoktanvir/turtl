import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { capyConfig, findPullRequestNumber, startCapyThread } from "../prTracking/capy";
import { githubToken, readPullRequest } from "../prTracking/github";
import { call, describeFailure, runJourneyCheck } from "../protectedApp/client";
import { manifestPath, parseManifest, type Item, type ManifestCheck, type ManifestSwitch } from "./detect";
import { preparationBrief } from "./brief";
import { readRaw } from "./github";

type PreparationContext = { preparation: Doc<"onboardingPreparations">; app: Doc<"apps">; inspection: Doc<"onboardingInspections"> | null };

const OPENING_GRACE_MS = 2 * 60_000;
const UNAUTHENTICATED_SYNC_MS = 5 * 60_000;
export const CHECK_VERSION = "onboarding-manifest-v1";

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
    const capy = capyConfig();
    if (!capy.ok) return fail(`Not configured: set ${capy.missing.join(" and ")} on turtl's deployment so Capy can write the preparation. Nothing was sent.`);
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
    });
    const started = await startCapyThread(capy, { repo: preparation.repo, requestId: preparation.requestId, title: title.slice(0, 120), message });
    if (!started.ok) return fail(`Could not ask Capy to write the preparation: ${started.message}`);
    await ctx.runMutation(internal.onboarding.records.recordThread, { id: preparationId, capyThreadId: started.body.threadId, brief: message });
    return { outcome: "started" as const, threadId: started.body.threadId };
  },
});

// GitHub read with the token, or without it when there is none or GitHub rejects it (public repositories).
async function readPull(repo: string, number: number) {
  const token = githubToken();
  const read = await readPullRequest(token ?? "", repo, number);
  if (!read.ok && read.status === 401 && token) return { read: await readPullRequest("", repo, number), authenticated: false };
  return { read, authenticated: Boolean(token) };
}

export async function syncPreparation(ctx: ActionCtx, row: Doc<"onboardingPreparations">, force: boolean): Promise<string> {
  if (row.settledAt !== undefined || !row.repo) return "settled";
  let number = row.number;
  if (number === undefined) {
    if (!row.capyThreadId) return "not_started";
    const capy = capyConfig();
    if (!capy.ok) return "not_configured";
    const found = await findPullRequestNumber(capy, row.capyThreadId, row.repo, row.capyCursor);
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
  } else if (!force && !githubToken() && row.syncedAt !== undefined && Date.now() - row.syncedAt < UNAUTHENTICATED_SYNC_MS) {
    return "waiting";
  }
  const { read } = await readPull(row.repo, number);
  if (!read.ok) {
    await ctx.runMutation(internal.onboarding.records.recordSyncError, { id: row._id, error: read.message });
    return "failed";
  }
  await ctx.runMutation(internal.onboarding.records.applySnapshot, { id: row._id, ...read.body });
  return read.body.snapshot.state;
}

// Every minute: preparations whose pull request is being opened or is still open. Without a working GitHub
// token an open pull request is read every five minutes, to stay inside GitHub's limit for anonymous reads.
export const refreshActive = internalAction({
  args: {},
  handler: async (ctx) => {
    const rows: Doc<"onboardingPreparations">[] = await ctx.runQuery(internal.onboarding.records.active, {});
    const outcomes: string[] = [];
    for (const row of rows) outcomes.push(await syncPreparation(ctx, row, false));
    return outcomes;
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
  journey?: { name: string; description: string; check: { kind: "http"; config: { url: string; method: "GET" | "POST"; expectedStatus: number; credentialRef?: string } }; checkVersion: string };
  action?: {
    type: string;
    name: string;
    description: string;
    config: { kind: "http"; url: string; method: "POST"; credentialRef?: string };
    parameterConstraints: { name: string; type: "string" | "boolean"; required: boolean; allowedValues?: (string | boolean)[] }[];
  };
  passedAt?: number;
};

// Calls each endpoint the manifest names on the live app now. Only what answers is registered: health and
// readiness and journey checks as journeys, flags and recovery hooks as catalog actions.
export async function checkLive(base: string, manifest: ReturnType<typeof parseManifest> & { ok: true }, ref: string): Promise<Check[]> {
  const { credentialRef } = manifest.manifest;
  const checkVersion = `${CHECK_VERSION}:${ref.slice(0, 12)}`;
  const url = (entry: ManifestCheck) => `${base}${entry.path}`;
  const credential = (entry: ManifestCheck) => (entry.authenticated ? credentialRef : undefined);
  const checks: Check[] = [];
  const probe = async (kind: "health" | "readiness", entry: ManifestCheck) => {
    const checkedAt = Date.now();
    const response = await call(url(entry), { credentialRef: credential(entry) });
    const answered = response.kind === "response";
    const ok = answered && response.status === 200;
    const notReady = kind === "readiness" && answered && response.status === 503 && typeof response.body === "object" && response.body !== null;
    checks.push({
      result: {
        kind,
        name: entry.name,
        url: url(entry),
        state: ok ? "works" : notReady ? "failing" : "no_response",
        detail: ok
          ? `Answered 200 in ${response.durationMs} ms.`
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
        },
      }),
      ...(ok && { passedAt: checkedAt }),
    });
  };
  if (manifest.manifest.health) await probe("health", manifest.manifest.health);
  if (manifest.manifest.readiness) await probe("readiness", manifest.manifest.readiness);
  for (const entry of manifest.manifest.journeys) {
    const checkedAt = Date.now();
    const outcome = await runJourneyCheck({ url: url(entry), ...(credential(entry) && { credentialRef: credential(entry) }) });
    const passed = outcome.ok && outcome.result.verdict === "passed";
    checks.push({
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
    });
  }
  const switches: [ManifestSwitch, "flag" | "recovery_hook"][] = [
    ...manifest.manifest.flags.map((entry) => [entry, "flag"] as [ManifestSwitch, "flag"]),
    ...manifest.manifest.recoveryHooks.map((entry) => [entry, "recovery_hook"] as [ManifestSwitch, "recovery_hook"]),
  ];
  for (const [entry, kind] of switches) {
    const checkedAt = Date.now();
    const response = await call(url(entry), { credentialRef: credential(entry) });
    const value = response.kind === "response" ? (response.body as Record<string, unknown> | null)?.[entry.field] : undefined;
    const ok = response.kind === "response" && response.status === 200 && typeof value === "boolean";
    checks.push({
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
    });
  }
  return checks;
}

// After the merge: reads turtl.json at the merge commit and registers what answers on the live app. `ref`
// lets an operator check a commit from the CLI; the product passes the merge commit.
export const register = internalAction({
  args: { preparationId: v.id("onboardingPreparations"), ref: v.optional(v.string()) },
  handler: async (ctx, { preparationId, ref: requested }): Promise<{ outcome: "missing" } | { outcome: "failed"; error: string } | { outcome: "registered"; checks: string[] }> => {
    const context: PreparationContext | null = await ctx.runQuery(internal.onboarding.records.forPreparation, { preparationId });
    if (!context) return { outcome: "missing" as const };
    const { preparation, app, inspection } = context;
    const ref = requested ?? preparation.mergeCommitSha ?? preparation.registration?.ref;
    const fail = async (error: string) => {
      await ctx.runMutation(internal.onboarding.records.failRegistration, { id: preparationId, error, ...(ref && { ref }) });
      return { outcome: "failed" as const, error };
    };
    if (!ref || !preparation.repo) return fail("turtl does not know the merged commit yet, so it could not read what the pull request added.");
    if (!app.productionUrl) return fail("No live app URL was given when the project was added, so turtl could not check anything on the live app.");
    const path = manifestPath(inspection?.folders ?? []);
    const text = await readRaw(preparation.repo, ref, path, githubToken());
    if (text === null) return fail(`turtl could not read ${path} at ${ref.slice(0, 12)}, so nothing was registered.`);
    const manifest = parseManifest(text);
    if (!manifest.ok) return fail(`${manifest.reason} Nothing was registered.`);
    const checks = await checkLive(app.productionUrl.replace(/\/+$/, ""), manifest, ref);
    if (checks.length === 0) return fail(`${path} lists no endpoint, so nothing was checked or registered.`);
    await ctx.runMutation(internal.onboarding.records.register, { id: preparationId, ref, checks });
    return { outcome: "registered" as const, checks: checks.map((check) => `${check.result.kind} ${check.result.name}: ${check.result.state}`) };
  },
});
