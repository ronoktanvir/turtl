import { makeFunctionReference } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { ApprovalMode } from "../types";
import { errorMessage, requireLiveClient } from "./client";

export async function approveFix(caseId: string, fixKey: string): Promise<void> {
  try {
    const client = requireLiveClient();
    const current = await client.query(api.fixes.forCase, { caseId });
    if (!current?.proposalId || current.version === null) throw new Error("No proposed fix is available to approve yet.");
    if (!current.fixes.some((fix) => fix.key === fixKey)) throw new Error("This fix is no longer in the proposal. Review the current fixes first.");
    await client.mutation(api.decisions.approve, { proposalId: current.proposalId, version: current.version, optionKey: fixKey });
  } catch (error) { throw new Error(errorMessage(error)); }
}

export async function stopEnactment(caseId: string): Promise<void> {
  try {
    const stop = makeFunctionReference<"mutation", { caseId: Id<"cases"> }, { stopped: true; summary: string } | { stopped: false; reason: string }>("decisions:stop");
    const result = await requireLiveClient().mutation(stop, { caseId: caseId as Id<"cases"> });
    if (!result.stopped) throw new Error(result.reason);
  } catch (error) { throw new Error(errorMessage(error)); }
}

export async function mergePullRequest(caseId: string, headSha: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const result = await requireLiveClient().action(api.pullRequests.merge, { caseId: caseId as Id<"cases">, headSha });
    if (result.outcome === "merged") return { ok: true };
    if (result.outcome === "refused") return { ok: false, reason: result.reason };
    if (result.outcome === "not_configured") return { ok: false, reason: `Merging is not configured on the backend: ${result.missing.join(", ")}.` };
    return { ok: false, reason: result.message };
  } catch (error) { return { ok: false, reason: errorMessage(error) }; }
}

export async function setApprovals(projectId: string, mode: ApprovalMode): Promise<void> {
  try {
    const client = requireLiveClient();
    const settings = await client.query(api.screens.projects.approvalSettings, { projectId });
    if (!settings) throw new Error("This project has no recovery permission settings.");
    if (mode === "auto") {
      if (settings.active) return;
      if (!settings.canEnable || !settings.memoryId) throw new Error(settings.reason);
      await client.mutation(api.permissions.grant, { memoryId: settings.memoryId });
      return;
    }
    for (const permissionId of settings.permissionIds) await client.mutation(api.permissions.revoke, { permissionId });
  } catch (error) { throw new Error(errorMessage(error)); }
}

export async function setStarred(_caseId: string, _starred: boolean): Promise<void> {
  throw new Error("Stars are not stored by this backend yet. Nothing was changed.");
}
