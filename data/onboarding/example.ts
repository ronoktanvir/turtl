import { useMemo, useSyncExternalStore } from "react";
import { addProjectSeed, listProjects } from "../example/store";
import { liveChecksFor, offlineInspection, onboardingSeeds, preparationPullRequest } from "./content";
import type { NeverBreakAnswer, NewProject, Onboarding, OnboardingStage } from "./types";

export const exampleTiming = { inspect: 2500, open: 2500, checks: 4000, register: 2500, recheck: 1500 };

let version = 0;
let count = 0;
const listeners = new Set<() => void>();
const onboardings = new Map<string, Onboarding>(onboardingSeeds(Date.now()).map((o) => [o.projectId, o]));
const offline = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const editable: OnboardingStage[] = ["asking", "ready", "nothing_to_add"];
const inspectable: OnboardingStage[] = ["inspection_failed", "unsupported", "asking", "ready", "nothing_to_add", "opening_failed", "closed"];

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getVersion() {
  return version;
}

function commit() {
  version += 1;
  listeners.forEach((listener) => listener());
}

function current(projectId: string): Onboarding {
  const o = onboardings.get(projectId);
  if (!o) throw new Error("turtl has not read this project's repository yet.");
  return o;
}

function patch(projectId: string, change: Partial<Onboarding>) {
  onboardings.set(projectId, { ...current(projectId), ...change });
  commit();
}

function later(projectId: string, ms: number, step: () => void) {
  clearTimeout(timers.get(projectId));
  timers.set(projectId, setTimeout(() => { timers.delete(projectId); step(); }, ms));
}

function inspect(projectId: string) {
  later(projectId, exampleTiming.inspect, () => {
    count += 1;
    const o = current(projectId);
    const seed = onboardingSeeds(Date.now()).find((s) => s.projectId === projectId)?.inspection;
    const inspection = offline.has(projectId) || !seed ? offlineInspection(projectId, count, Date.now()) : { ...seed, id: projectId + "-inspection-r" + count, finishedAt: Date.now() };
    patch(projectId, { stage: "asking", inspection, answered: false, neverBreak: o.neverBreak });
  });
}

export function useOnboarding(projectId: string): Onboarding | null | undefined {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  return useMemo(() => onboardings.get(projectId) ?? null, [v, projectId]);
}

export async function addProject(input: NewProject): Promise<{ projectId: string }> {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(input.repoUrl.trim());
  if (!match) throw new Error("Paste the repository's GitHub address, like https://github.com/owner/name.");
  const liveUrl = input.liveUrl?.trim() || undefined;
  if (liveUrl && !/^https?:\/\/[^\s/]+\.[^\s]+$/.test(liveUrl)) throw new Error("The live app URL should be a full address, like https://app.example.com.");
  const folders = (input.folders ?? []).map((f) => f.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
  const repo = match[1] + "/" + match[2];
  const repoUrl = "https://github.com/" + repo;
  const sameFolders = (other: string[]) => [...other].sort().join(",") === [...folders].sort().join(",");
  if ([...onboardings.values()].some((o) => o.repo.toLowerCase() === repo.toLowerCase() && sameFolders(o.folders))) {
    throw new Error(repo + (folders.length ? " (" + folders.join(", ") + ")" : "") + " is already a project in turtl.");
  }
  const name = folders.length ? folders[0].split("/").pop()! : match[2];
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  const taken = new Set([...listProjects().map((p) => p.id), ...onboardings.keys()]);
  let projectId = base;
  for (let n = 2; taken.has(projectId); n += 1) projectId = base + "-" + n;
  addProjectSeed({ id: projectId, name, repoUrl, productionUrl: liveUrl, approvals: "you" });
  offline.add(projectId);
  onboardings.set(projectId, { projectId, repo, repoUrl, liveUrl, folders, stage: "inspecting", neverBreak: [], answered: false, checks: [] });
  commit();
  inspect(projectId);
  return { projectId };
}

export async function saveNeverBreak(projectId: string, answers: NeverBreakAnswer[]): Promise<void> {
  const o = current(projectId);
  if (!editable.includes(o.stage)) throw new Error("The preparation is already approved, so these answers can't change now.");
  const neverBreak = answers.filter((a) => a.text.trim()).map((a) => {
    count += 1;
    return { id: a.id ?? projectId + "-never-" + count, text: a.text.trim(), suggested: a.suggested ?? false, why: a.why, addCheck: a.addCheck };
  });
  const needed = (o.inspection?.items ?? []).some((i) => i.status !== "found") || neverBreak.some((n) => n.addCheck);
  patch(projectId, { neverBreak, answered: true, stage: needed ? "ready" : "nothing_to_add" });
}

export async function approvePreparation(projectId: string, inspectionId: string): Promise<void> {
  const o = current(projectId);
  if (o.stage !== "ready") throw new Error("There is nothing waiting for your approval.");
  if (o.inspection?.id !== inspectionId) throw new Error("turtl read the repository again since you looked. Review the new report first.");
  patch(projectId, { stage: "opening", approvedAt: Date.now(), problem: undefined });
  later(projectId, exampleTiming.open, () => {
    if (offline.has(projectId)) {
      patch(projectId, { stage: "opening_failed", problem: "This copy of turtl works offline, so Capy could not open the pull request. Nothing changed in your repository." });
      return;
    }
    patch(projectId, { stage: "pr_open", pullRequest: preparationPullRequest(current(projectId)) });
    later(projectId, exampleTiming.checks, () => {
      const pr = current(projectId).pullRequest;
      if (!pr || pr.state !== "open") return;
      patch(projectId, { pullRequest: { ...pr, checks: "passing", mergeable: true, checkRuns: pr.checkRuns.map((r) => ({ ...r, status: "passed" as const })) } });
    });
  });
}

export async function mergePreparation(projectId: string, headSha: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const o = onboardings.get(projectId);
  const pr = o?.pullRequest;
  if (!o || !pr) return { ok: false, reason: "There is no pull request to merge yet." };
  if (pr.state !== "open") return { ok: false, reason: pr.state === "merged" ? "This pull request is already merged." : "This pull request was closed." };
  if (pr.checks !== "passing" || !pr.mergeable) return { ok: false, reason: "The checks have not passed yet." };
  if (headSha !== pr.headSha) return { ok: false, reason: "Not merged. The pull request changed after you looked. Check it again, then merge." };
  patch(projectId, { stage: "registering", pullRequest: { ...pr, state: "merged", mergeable: false }, checks: [], checksError: undefined });
  register(projectId, exampleTiming.register);
  return { ok: true };
}

function register(projectId: string, ms: number) {
  later(projectId, ms, () => {
    const o = current(projectId);
    const now = Date.now();
    if (!o.liveUrl) {
      patch(projectId, { stage: "registered", checks: [], checkedAt: now, checksError: "turtl has no live app address for this project, so it could not check the new endpoints." });
      return;
    }
    patch(projectId, { stage: "registered", checks: liveChecksFor(o, now), checkedAt: now, checksError: undefined });
  });
}

export async function refreshPreparation(projectId: string): Promise<void> {
  current(projectId);
  commit();
}

export async function inspectAgain(projectId: string): Promise<void> {
  const o = current(projectId);
  if (!inspectable.includes(o.stage)) throw new Error("turtl reads the repository again only before a preparation is approved, or after it closed.");
  patch(projectId, { stage: "inspecting", pullRequest: undefined, problem: undefined, approvedAt: undefined });
  inspect(projectId);
}

export async function checkLiveAgain(projectId: string): Promise<void> {
  const o = current(projectId);
  if (o.stage !== "registered") throw new Error("turtl checks the live app after the pull request is merged.");
  patch(projectId, { stage: "registering" });
  register(projectId, exampleTiming.recheck);
}
