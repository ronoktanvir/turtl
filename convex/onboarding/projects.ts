import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { action, mutation, query, type MutationCtx } from "../_generated/server";
import { accessEnforced, canSeeApp, guardApp, guardAppInAction, requireAccount, visibleApps } from "../access";
import { requireOwnerPasscode } from "../ownerPasscode";
import { repositoryAccess } from "../github/access";
import { mergePullRequest, readPullRequest } from "../prTracking/github";
import { pullRequestOf } from "../prTracking/validators";
import { normalizeFolders, parseGithubUrl, READINESS_ITEMS } from "./detect";
import { latestInspection, preparationFor } from "./records";
import { syncPreparation } from "./prepare";
import { hasWork, stageOf } from "./stage";

const MAX_ANSWERS = 10;

async function appFor(ctx: MutationCtx, projectId: string) {
  const appId = ctx.db.normalizeId("apps", projectId);
  const app = appId && (await ctx.db.get(appId));
  if (!app || app.isSample) throw new ConvexError("That project does not exist.");
  const preparation = await preparationFor(ctx, app._id);
  if (!preparation) throw new ConvexError("That project was not added through onboarding.");
  return { app, preparation };
}

async function startInspection(ctx: MutationCtx, appId: Id<"apps">, repo: string, folders: string[]) {
  const inspectionId = await ctx.db.insert("onboardingInspections", {
    appId,
    repo,
    folders,
    status: "running",
    items: [],
    suggestions: [],
    startedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.onboarding.inspect.run, { inspectionId });
  return inspectionId;
}

function liveUrlOf(input: string | undefined) {
  const text = input?.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConvexError("The live app URL must be a full address, like https://example.com.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConvexError("The live app URL must start with https://.");
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

// The owner adds a project from a GitHub repository URL. turtl creates the app and starts reading the repository.
export const add = mutation({
  args: { repoUrl: v.string(), liveUrl: v.optional(v.string()), folders: v.optional(v.array(v.string())), passcode: v.optional(v.string()) },
  handler: async (ctx, { repoUrl, liveUrl, folders, passcode }) => {
    const account = await requireAccount(ctx);
    await requireOwnerPasscode(ctx, passcode);
    const parsed = parseGithubUrl(repoUrl);
    if (!parsed) throw new ConvexError("Paste the repository's GitHub address, like https://github.com/owner/name.");
    let scope: string[];
    try {
      scope = normalizeFolders([...(parsed.folder ? [parsed.folder] : []), ...(folders ?? [])]);
    } catch (error) {
      throw new ConvexError(error instanceof Error ? error.message : "A folder is not valid.");
    }
    const productionUrl = liveUrlOf(liveUrl);
    // With accounts on, a repository is "already a project" only among the caller's own projects.
    const preparations = accessEnforced()
      ? (await Promise.all((await visibleApps(ctx)).map((owned) => preparationFor(ctx, owned._id)))).flatMap((row) => (row ? [row] : []))
      : await ctx.db.query("onboardingPreparations").collect();
    for (const preparation of preparations) {
      const inspection = await latestInspection(ctx, preparation.appId);
      if (inspection?.repo.toLowerCase() === parsed.repo.toLowerCase() && inspection.folders.join(",") === scope.join(",")) {
        throw new ConvexError(`${parsed.repo}${scope.length ? ` (${scope.join(", ")})` : ""} is already a project.`);
      }
    }
    const repoName = parsed.repo.split("/")[1];
    const appId = await ctx.db.insert("apps", {
      name: scope.length ? `${repoName}/${scope[0]}` : repoName,
      repoUrl: `https://github.com/${parsed.repo}`,
      ...(productionUrl && { productionUrl }),
      ownerId: account,
    });
    await ctx.db.insert("onboardingPreparations", { appId, neverBreak: [] });
    await startInspection(ctx, appId, parsed.repo, scope);
    return { projectId: appId as string };
  },
});

export const inspectAgain = mutation({
  args: { projectId: v.string(), passcode: v.optional(v.string()) },
  handler: async (ctx, { projectId, passcode }) => {
    await guardApp(ctx, projectId, "That project does not exist.");
    await requireOwnerPasscode(ctx, passcode);
    const { app, preparation } = await appFor(ctx, projectId);
    if (preparation.approvedAt !== undefined) throw new ConvexError("The preparation was already approved; turtl keeps the report you approved.");
    const inspection = await latestInspection(ctx, app._id);
    if (!inspection) throw new ConvexError("This project has no inspection.");
    if (inspection.status === "running") throw new ConvexError("turtl is still reading the repository.");
    await startInspection(ctx, app._id, inspection.repo, inspection.folders);
    return null;
  },
});

// What must never break, in the owner's words, and whether the preparation adds a check for each.
export const saveAnswers = mutation({
  args: {
    projectId: v.string(),
    answers: v.array(v.object({ id: v.optional(v.string()), text: v.string(), suggested: v.optional(v.boolean()), why: v.optional(v.string()), addCheck: v.boolean() })),
  },
  handler: async (ctx, { projectId, answers }) => {
    await guardApp(ctx, projectId, "That project does not exist.");
    const { preparation } = await appFor(ctx, projectId);
    if (preparation.approvedAt !== undefined) throw new ConvexError("The preparation was already approved, so the answers it used can't change.");
    const kept = answers.map((answer) => ({ ...answer, text: answer.text.trim() })).filter((answer) => answer.text.length > 0);
    if (kept.length > MAX_ANSWERS) throw new ConvexError(`Keep it to the ${MAX_ANSWERS} most important things.`);
    if (kept.some((answer) => answer.text.length > 300)) throw new ConvexError("Keep each answer under 300 characters.");
    await ctx.db.patch(preparation._id, {
      answeredAt: Date.now(),
      neverBreak: kept.map((answer, index) => ({
        id: answer.id ?? `owner-${Date.now()}-${index}`,
        text: answer.text,
        suggested: answer.suggested ?? false,
        ...(answer.why && { why: answer.why.slice(0, 300) }),
        addCheck: answer.addCheck,
      })),
    });
    return null;
  },
});

// The owner's approval of the report they saw (inspectionId). It asks once: a second approval is refused.
export const approve = mutation({
  args: { projectId: v.string(), inspectionId: v.string(), passcode: v.optional(v.string()) },
  handler: async (ctx, { projectId, inspectionId, passcode }) => {
    await guardApp(ctx, projectId, "That project does not exist.");
    await requireOwnerPasscode(ctx, passcode);
    const { app, preparation } = await appFor(ctx, projectId);
    if (preparation.approvedAt !== undefined) throw new ConvexError("You already approved this preparation.");
    const inspection = await latestInspection(ctx, app._id);
    if (!inspection || inspection.status !== "done" || !inspection.stack || !inspection.ref) throw new ConvexError("turtl has not finished reading the repository.");
    if (inspection._id !== inspectionId) throw new ConvexError("turtl read the repository again after you looked. Look at the new report before approving.");
    if (!inspection.stack.supported) throw new ConvexError(`Automatic preparation is not supported for ${inspection.stack.label} yet.`);
    if (preparation.answeredAt === undefined) throw new ConvexError("Tell turtl what must never break first.");
    if (!hasWork(inspection, preparation)) throw new ConvexError("Nothing is missing, so there is nothing to prepare.");
    await ctx.db.patch(preparation._id, {
      approvedAt: Date.now(),
      inspectionId: inspection._id,
      requestId: `turtl-onboarding:${preparation._id}:${inspection._id}`,
      repo: inspection.repo,
      baseBranch: inspection.defaultBranch ?? "main",
    });
    await ctx.scheduler.runAfter(0, internal.onboarding.prepare.start, { preparationId: preparation._id });
    return null;
  },
});

// Reads the preparation's pull request from GitHub now, rather than waiting for the cron.
export const refresh = action({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }): Promise<null> => {
    await guardAppInAction(ctx, projectId);
    const row: Doc<"onboardingPreparations"> | null = await ctx.runQuery(internal.onboarding.records.forApp, { projectId });
    if (row) await syncPreparation(ctx, row, true);
    return null;
  },
});

type MergeResult = { ok: true } | { ok: false; reason: string };

// The owner's Merge tap: merges only when the pull request is open, its checks pass, GitHub can merge it, and
// its head is still the commit the owner was shown.
export const merge = action({
  args: { projectId: v.string(), headSha: v.string(), passcode: v.optional(v.string()) },
  handler: async (ctx, { projectId, headSha, passcode }): Promise<MergeResult> => {
    await guardAppInAction(ctx, projectId);
    await ctx.runQuery(internal.ownerPasscode.authorize, { passcode });
    const row: Doc<"onboardingPreparations"> | null = await ctx.runQuery(internal.onboarding.records.forApp, { projectId });
    if (!row || row.number === undefined || !row.repo) return { ok: false, reason: "This project has no preparation pull request yet." };
    if (row.settledAt !== undefined) return { ok: false, reason: "turtl is no longer following this pull request." };
    const access = await repositoryAccess(ctx, row.repo, { appId: row.appId });
    if (!access.ok) return { ok: false, reason: `${access.message} Nothing was merged.` };
    const token = access.token;
    if (!token) return { ok: false, reason: "Not configured: turtl needs a GITHUB_TOKEN that can merge in this repository. Nothing was merged." };
    const read = await readPullRequest(token, row.repo, row.number);
    if (!read.ok) {
      return { ok: false, reason: read.status === 401 ? "GitHub rejected turtl's GITHUB_TOKEN, so turtl can't merge. Nothing was merged." : read.message };
    }
    await ctx.runMutation(internal.onboarding.records.applySnapshot, { id: row._id, ...read.body });
    const { snapshot } = read.body;
    if (snapshot.state !== "open") return { ok: false, reason: `Pull request #${row.number} is already ${snapshot.state}.` };
    if (snapshot.headSha !== headSha) return { ok: false, reason: "The pull request changed after you looked at it: new commits arrived. Look at it again before merging." };
    if (snapshot.checks !== "passing") {
      return { ok: false, reason: snapshot.checks === "none" ? "The pull request has no checks yet. turtl merges only once checks pass." : `Checks are ${snapshot.checks}. turtl merges only once they pass.` };
    }
    if (!snapshot.mergeable) return { ok: false, reason: `GitHub can't merge it right now (${snapshot.mergeableState}).` };
    if (!(await ctx.runMutation(internal.onboarding.records.beginMerge, { id: row._id }))) return { ok: false, reason: "The pull request already finished. Nothing was merged." };
    const merged = await mergePullRequest(token, row.repo, row.number, headSha);
    if (!merged.ok || !merged.body.merged) {
      await ctx.runMutation(internal.onboarding.records.clearMergeRequest, { id: row._id });
      return { ok: false, reason: merged.ok ? `GitHub did not merge it: ${merged.body.message}` : `GitHub did not merge it. ${merged.message}` };
    }
    const after = await readPullRequest(token, row.repo, row.number);
    const mergedSnapshot =
      after.ok && after.body.snapshot.state === "merged" ? after.body.snapshot : { ...snapshot, state: "merged" as const, mergeable: false, mergeableState: "merged" };
    await ctx.runMutation(internal.onboarding.records.applySnapshot, { id: row._id, snapshot: mergedSnapshot, mergeCommitSha: merged.body.sha });
    return { ok: true };
  },
});

// Checks the live app again and registers what answers, from the merged commit.
export const checkAgain = mutation({
  args: { projectId: v.string(), passcode: v.optional(v.string()) },
  handler: async (ctx, { projectId, passcode }) => {
    await guardApp(ctx, projectId, "That project does not exist.");
    await requireOwnerPasscode(ctx, passcode);
    const { preparation } = await appFor(ctx, projectId);
    if (preparation.mergedAt === undefined) throw new ConvexError("The preparation pull request has not merged yet.");
    await ctx.db.patch(preparation._id, { registration: { ...(preparation.registration ?? { checks: [] }), status: "checking" } });
    await ctx.scheduler.runAfter(0, internal.onboarding.prepare.register, { preparationId: preparation._id });
    return null;
  },
});

// The Preparation screen's data, in the shape of data/onboarding/types.ts (Onboarding). Null when the project
// was not added through onboarding.
export const forProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    if (!(await canSeeApp(ctx, projectId))) return null;
    const appId = ctx.db.normalizeId("apps", projectId);
    const app = appId && (await ctx.db.get(appId));
    if (!app || app.isSample) return null;
    const preparation = await preparationFor(ctx, app._id);
    if (!preparation) return null;
    const approved = preparation.inspectionId ? await ctx.db.get(preparation.inspectionId) : null;
    const inspection = approved ?? (await latestInspection(ctx, app._id));
    const repo = inspection?.repo ?? app.repoUrl?.replace("https://github.com/", "") ?? "";
    const fileUrl = (path: string, line?: number) => `https://github.com/${repo}/blob/${inspection?.ref ?? "HEAD"}/${path}${line ? `#L${line}` : ""}`;
    const registration = preparation.registration;
    return {
      projectId: app._id as string,
      repo,
      repoUrl: app.repoUrl ?? `https://github.com/${repo}`,
      ...(app.productionUrl && { liveUrl: app.productionUrl }),
      folders: inspection?.folders ?? [],
      stage: stageOf(inspection, preparation),
      ...(inspection && {
        inspection: {
          id: inspection._id as string,
          ...(inspection.ref && { ref: inspection.ref }),
          ...(inspection.stack && { stack: inspection.stack }),
          items: inspection.items.map((item) => ({
            key: item.key,
            label: READINESS_ITEMS.find((entry) => entry.key === item.key)!.label,
            status: item.status,
            note: item.note,
            files: item.files.map((file) => ({ ...file, url: fileUrl(file.path, file.line) })),
          })),
          ...(inspection.summary && { summary: inspection.summary }),
          ...(inspection.judgedBy && { judgedBy: inspection.judgedBy }),
          ...(inspection.fallbackReason && { fallbackReason: inspection.fallbackReason }),
          ...(inspection.readNote && { readNote: inspection.readNote }),
          ...(inspection.error && { error: inspection.error }),
          ...(inspection.finishedAt && { finishedAt: inspection.finishedAt }),
        },
      }),
      neverBreak: preparation.neverBreak,
      answered: preparation.answeredAt !== undefined,
      ...(preparation.approvedAt && { approvedAt: preparation.approvedAt }),
      ...(preparation.number !== undefined && preparation.snapshot && preparation.repo && { pullRequest: pullRequestOf(preparation.repo, preparation.number, preparation.snapshot) }),
      ...((preparation.openError ?? preparation.syncError) && { problem: preparation.openError ?? preparation.syncError }),
      checks: (registration?.checks ?? []).map(({ journeyId, actionCatalogId, ...check }) => ({ ...check, registered: Boolean(journeyId ?? actionCatalogId) })),
      ...(registration?.error && { checksError: registration.error }),
      ...(registration?.checkedAt && { checkedAt: registration.checkedAt }),
    };
  },
});
