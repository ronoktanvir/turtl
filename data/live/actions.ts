import { makeFunctionReference, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { ApprovalMode } from "../types";
import { errorMessage, requireLiveClient } from "./client";

type Approve = typeof api.decisions.approve;
const approve = api.decisions.approve as FunctionReference<"mutation", "public", FunctionArgs<Approve> & { note?: string }, FunctionReturnType<Approve>>;
const decline = makeFunctionReference<"mutation", { proposalId: string; version: number; passcode?: string; note?: string }, unknown>("decisions:decline");
const addRef = makeFunctionReference<"mutation", { projectId: string; statement: string; passcode?: string }, { id: string }>("learning/preferences:add");
const removeRef = makeFunctionReference<"mutation", { preferenceId: string; passcode?: string }, null>("learning/preferences:remove");
const confirmRef = makeFunctionReference<"mutation", { suggestionId: string; statement?: string; passcode?: string }, { id: string }>("learning/preferences:confirm");
const dismissRef = makeFunctionReference<"mutation", { suggestionId: string; passcode?: string }, null>("learning/preferences:dismiss");

export async function approveFix(caseId: string, fixKey: string, passcode?: string, note?: string): Promise<void> {
  try {
    const client = requireLiveClient();
    const current = await client.query(api.fixes.forCase, { caseId });
    if (!current?.proposalId || current.version === null) throw new Error("No proposed fix is available to approve yet.");
    if (!current.fixes.some((fix) => fix.key === fixKey)) throw new Error("This fix is no longer in the proposal. Review the current fixes first.");
    const trimmed = note?.trim();
    await client.mutation(approve, { proposalId: current.proposalId, version: current.version, optionKey: fixKey, ...(passcode !== undefined && { passcode }), ...(trimmed && { note: trimmed }) });
  } catch (error) { throw new Error(errorMessage(error)); }
}

export async function declineFixes(caseId: string, passcode?: string, note?: string): Promise<void> {
  try {
    const client = requireLiveClient();
    const current = await client.query(api.fixes.forCase, { caseId });
    if (!current?.proposalId || current.version === null || current.fixes.length === 0) throw new Error("No proposed fix is available to decline.");
    const trimmed = note?.trim();
    await client.mutation(decline, { proposalId: current.proposalId, version: current.version, ...(passcode !== undefined && { passcode }), ...(trimmed && { note: trimmed }) });
  } catch (error) { throw new Error(errorMessage(error)); }
}

export async function addPreference(projectId: string, statement: string, passcode?: string): Promise<void> {
  try {
    const text = statement.trim();
    if (!text) throw new Error("Write what matters to you before adding it.");
    await requireLiveClient().mutation(addRef, { projectId, statement: text, ...(passcode !== undefined && { passcode }) });
  } catch (error) { throw new Error(errorMessage(error)); }
}

export async function removePreference(preferenceId: string, passcode?: string): Promise<void> {
  try {
    await requireLiveClient().mutation(removeRef, { preferenceId, ...(passcode !== undefined && { passcode }) });
  } catch (error) { throw new Error(errorMessage(error)); }
}

export async function confirmPreference(suggestionId: string, statement?: string, passcode?: string): Promise<void> {
  try {
    const text = statement?.trim();
    await requireLiveClient().mutation(confirmRef, { suggestionId, ...(text && { statement: text }), ...(passcode !== undefined && { passcode }) });
  } catch (error) { throw new Error(errorMessage(error)); }
}

export async function dismissPreference(suggestionId: string, passcode?: string): Promise<void> {
  try {
    await requireLiveClient().mutation(dismissRef, { suggestionId, ...(passcode !== undefined && { passcode }) });
  } catch (error) { throw new Error(errorMessage(error)); }
}

export async function stopEnactment(caseId: string, passcode?: string): Promise<void> {
  try {
    const stop = makeFunctionReference<"mutation", { caseId: Id<"cases">; passcode?: string }, { stopped: true; summary: string } | { stopped: false; reason: string }>("decisions:stop");
    const result = await requireLiveClient().mutation(stop, { caseId: caseId as Id<"cases">, ...(passcode !== undefined && { passcode }) });
    if (!result.stopped) throw new Error(result.reason);
  } catch (error) { throw new Error(errorMessage(error)); }
}

export async function mergePullRequest(caseId: string, headSha: string, passcode?: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const result = await requireLiveClient().action(api.pullRequests.merge, { caseId: caseId as Id<"cases">, headSha, ...(passcode !== undefined && { passcode }) });
    if (result.outcome === "merged") return { ok: true };
    if (result.outcome === "refused") return { ok: false, reason: result.reason };
    if (result.outcome === "not_configured") return { ok: false, reason: `Merging is not configured on the backend: ${result.missing.join(", ")}.` };
    return { ok: false, reason: result.message };
  } catch (error) { return { ok: false, reason: errorMessage(error) }; }
}

export async function setApprovals(projectId: string, mode: ApprovalMode, passcode?: string): Promise<void> {
  try {
    const client = requireLiveClient();
    const settings = await client.query(api.screens.projects.approvalSettings, { projectId });
    if (!settings) throw new Error("This project has no recovery permission settings.");
    if (mode === "auto") {
      if (settings.active) return;
      if (!settings.canEnable || !settings.memoryId) throw new Error(settings.reason);
      await client.mutation(api.permissions.grant, { memoryId: settings.memoryId, ...(passcode !== undefined && { passcode }) });
      return;
    }
    for (const permissionId of settings.permissionIds) await client.mutation(api.permissions.revoke, { permissionId, ...(passcode !== undefined && { passcode }) });
  } catch (error) { throw new Error(errorMessage(error)); }
}

export async function setStarred(_caseId: string, _starred: boolean): Promise<void> {
  throw new Error("Stars are not stored by this backend yet. Nothing was changed.");
}
