import type {
  ApprovalMode,
  CaseDetail,
  CaseStatus,
  CaseSummary,
  CaseType,
  ChatMessage,
  ChatScope,
  CodeNetwork,
  Enactment,
  FixOption,
  Health,
  PlanStep,
  Preferences,
  Project,
  StructuralFinding,
} from "../types";
import {
  afterShots,
  caseReplies,
  caseSeeds,
  headChangesOnce,
  learnedFor,
  networks,
  planFor,
  projectSeeds,
  proposals,
  pullRequestFor,
  type ProjectSeed,
  type StepSeed,
} from "./content";
import * as prefs from "./preferences";
import { changeClockState, estimatedStepDuration, playbackDuration, readExecutionClock, type ExecutionClock } from "./timing";

const HEALTH_ORDER: Health[] = ["affected", "needs_you", "working", "clear"];
const OPEN: CaseStatus[] = ["new", "investigating", "needs_approval", "enacting", "ready_to_merge"];
const WAITING: CaseStatus[] = ["needs_approval", "ready_to_merge"];

let version = 0;
const listeners = new Set<() => void>();
const projects = new Map<string, ProjectSeed>(projectSeeds.map((p) => [p.id, p]));
const cases = new Map<string, CaseDetail>(caseSeeds.map((c) => [c.id, c]));
const seedHealth = new Map<string, Health>(caseSeeds.map((c) => [c.id, c.health]));
const plans = new Map<string, StepSeed[]>();
const answered = new Set<string>();
const headChanged = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const clocks = new Map<string, ExecutionClock>();
const chats = new Map<string, ChatMessage[]>();
const busy = new Set<string>();
let messageCount = 0;

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getVersion() {
  return version;
}

function commit() {
  version += 1;
  listeners.forEach((listener) => listener());
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function summaryOf(c: CaseDetail): CaseSummary {
  return {
    id: c.id,
    projectId: c.projectId,
    type: c.type,
    number: c.number,
    title: c.title,
    category: c.category,
    status: c.status,
    health: c.health,
    happenedAt: c.happenedAt,
    reportCount: c.reportCount,
    starred: c.starred,
  };
}

function projectOf(seed: ProjectSeed): Project {
  const open = [...cases.values()].filter((c) => c.projectId === seed.id && OPEN.includes(c.status));
  return {
    ...seed,
    health: HEALTH_ORDER.find((h) => open.some((c) => c.health === h)) ?? "clear",
    bugCount: open.filter((c) => c.type === "fix").length,
    featureCount: open.filter((c) => c.type === "feature").length,
    needsApprovalCount: open.filter((c) => WAITING.includes(c.status)).length,
  };
}

export function listProjects(): Project[] {
  return [...projects.values()]
    .map(projectOf)
    .sort((a, b) => HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health));
}

export function addProjectSeed(seed: ProjectSeed) {
  projects.set(seed.id, seed);
  commit();
}

export function getProject(projectId: string): Project | null {
  const seed = projects.get(projectId);
  return seed ? projectOf(seed) : null;
}

export function listCases(projectId: string, type: CaseType): CaseSummary[] {
  const open = [...cases.values()].filter(
    (c) => c.projectId === projectId && c.type === type && OPEN.includes(c.status),
  );
  const sorted =
    type === "fix"
      ? open.sort(
          (a, b) =>
            Number(WAITING.includes(b.status)) - Number(WAITING.includes(a.status)) ||
            Number(b.health === "affected") - Number(a.health === "affected") ||
            b.happenedAt - a.happenedAt,
        )
      : open.sort((a, b) => (b.reportCount ?? 0) - (a.reportCount ?? 0) || b.happenedAt - a.happenedAt);
  return sorted.map(summaryOf);
}

export function getCase(caseId: string): CaseDetail | null {
  return cases.get(caseId) ?? null;
}

export function getNetwork(projectId: string): CodeNetwork | null {
  return networks[projectId] ?? null;
}

function patch(caseId: string, change: (c: CaseDetail) => CaseDetail) {
  const current = cases.get(caseId);
  if (current) cases.set(caseId, change(current));
}

function patchEnactment(caseId: string, change: (e: Enactment) => Enactment) {
  patch(caseId, (c) => (c.enactment ? { ...c, enactment: change(c.enactment) } : c));
}

function withStep(e: Enactment, index: number, step: Partial<PlanStep>): Enactment {
  return { ...e, steps: e.steps.map((s, i) => (i === index ? { ...s, ...step } : s)) };
}

export function enactmentNow(caseId: string): number {
  const clock = clocks.get(caseId);
  return clock ? readExecutionClock(clock, Date.now()) : Date.now();
}

function runClock(caseId: string, running: boolean) {
  const now = Date.now();
  const clock = clocks.get(caseId) ?? { realAt: now, logicalAt: now, running: false };
  clocks.set(caseId, changeClockState(clock, running, now));
}

function schedule(caseId: string, ms: number) {
  clearTimeout(timers.get(caseId));
  timers.set(
    caseId,
    setTimeout(() => advance(caseId), ms),
  );
}

function during(c: CaseDetail, health: Health): Health {
  return c.health === "affected" ? "affected" : health;
}

function advance(caseId: string) {
  const c = cases.get(caseId);
  const e = c?.enactment;
  const plan = plans.get(caseId);
  if (!c || !e || !plan || (e.state !== "running" && e.state !== "merged")) return;
  const fix = c.fixes.find((f) => f.key === e.fixKey);
  const running = e.steps.findIndex((s) => s.status === "running");

  if (running === -1) {
    const next = e.steps.findIndex((s) => s.status === "pending");
    if (next === -1) {
      runClock(caseId, false);
      patch(caseId, (c) => ({
        ...c,
        status: "resolved",
        health: "clear",
        learned: fix ? learnedFor(fix) : undefined,
        screenshots: [...c.screenshots, ...afterShots(c.id).filter((shot) => !c.screenshots.some((existing) => existing.id === shot.id))],
        enactment: { ...e, state: "done" },
      }));
      return commit();
    }
    if (plan[next].effect === "merge_gate" && e.state !== "merged") {
      runClock(caseId, false);
      patch(caseId, (c) => ({
        ...c,
        status: "ready_to_merge",
        health: during(c, "needs_you"),
        enactment: { ...e, state: "waiting_for_merge" },
      }));
      return commit();
    }
    const duration = estimatedStepDuration(plan[next].key);
    patchEnactment(caseId, (e) => withStep(e, next, { status: "running", startedAt: enactmentNow(caseId), estimatedDurationMs: duration }));
    commit();
    return schedule(caseId, playbackDuration(duration));
  }

  const seed = plan[running];
  const pr = e.pullRequest;
  if (seed.effect === "checks" && pr && pr.checkRuns.some((r) => r.status === "pending")) {
    const checkRuns = pr.checkRuns.map((r) => ({ ...r, status: "passed" as const }));
    const passed = checkRuns.every((r) => r.status === "passed");
    patchEnactment(caseId, (e) => ({
      ...e,
      pullRequest: { ...pr, checkRuns, checks: passed ? "passing" : "pending", mergeable: passed },
    }));
  }
  if (seed.question && !answered.has(caseId)) {
    runClock(caseId, false);
    patch(caseId, (c) => ({
      ...c,
      status: "needs_approval",
      health: during(c, "needs_you"),
      enactment: {
        ...withStep(e, running, {
          status: "failed",
          finishedAt: enactmentNow(caseId),
          summary: "Stopped here: turtl needs your decision.",
        }),
        state: "needs_you",
        question: seed.question,
      },
    }));
    return commit();
  }
  patchEnactment(caseId, (e) => ({
    ...withStep(e, running, { status: "done", finishedAt: enactmentNow(caseId), summary: seed.summary }),
    pullRequest: seed.effect === "open_pr" && fix ? pullRequestFor(c, fix) : e.pullRequest,
  }));
  commit();
  schedule(caseId, 500);
}

export async function approveFix(caseId: string, fixKey: string, note?: string): Promise<void> {
  const c = cases.get(caseId);
  if (!c) return;
  if (note?.trim()) prefs.suggest(c.projectId, note, "decision_note");
  const enactment = c.enactment;
  const answer = enactment?.question?.fixes.find((f) => f.key === fixKey);
  if (enactment && answer) {
    runClock(caseId, true);
    answered.add(caseId);
    const stopped = enactment.steps.findIndex((s) => s.status === "failed");
    patch(caseId, (c) => ({
      ...c,
      status: "enacting",
      health: during(c, "working"),
      enactment: {
        ...withStep(enactment, stopped, { status: "done", summary: "You chose: " + answer.title + "." }),
        state: "running",
        question: undefined,
      },
    }));
    commit();
    return schedule(caseId, 700);
  }
  const fix = c.fixes.find((f) => f.key === fixKey);
  if (!fix) return;
  const plan = planFor(fix);
  const now = Date.now();
  clocks.set(caseId, { realAt: now, logicalAt: now, running: true });
  plans.set(caseId, plan);
  answered.delete(caseId);
  patch(caseId, (c) => ({
    ...c,
    status: "enacting",
    health: during(c, "working"),
    learned: undefined,
    enactment: {
      fixKey,
      state: "running",
      steps: plan.map((s) => ({ key: s.key, title: s.title, detail: s.detail, status: "pending", estimatedDurationMs: estimatedStepDuration(s.key) })),
    },
  }));
  commit();
  schedule(caseId, 700);
}

export async function declineFixes(caseId: string, note?: string): Promise<void> {
  const c = cases.get(caseId);
  if (!c) throw new Error("This case could not be found.");
  if (c.enactment && c.enactment.state !== "stopped") throw new Error("A fix is already underway. Stop it before declining.");
  if (c.status === "declined" || c.status === "resolved" || c.status === "unresolved") throw new Error("This case is already closed.");
  if (note?.trim()) prefs.suggest(c.projectId, note, "decision_note");
  clearTimeout(timers.get(caseId));
  patch(caseId, (c) => ({ ...c, status: "declined", health: "clear" }));
  commit();
}

export function getPreferences(projectId: string): Preferences | null {
  return projects.has(projectId) ? prefs.list(projectId) : null;
}

function preferenceChange(projectId: string, change: () => unknown): Promise<void> {
  if (!projects.has(projectId)) return Promise.reject(new Error("This project could not be found."));
  try {
    change();
  } catch (error) {
    return Promise.reject(error);
  }
  commit();
  return Promise.resolve();
}

export const addPreference = (projectId: string, statement: string) => preferenceChange(projectId, () => prefs.add(projectId, statement));
export const removePreference = (projectId: string, preferenceId: string) => preferenceChange(projectId, () => prefs.remove(projectId, preferenceId));
export const confirmPreference = (projectId: string, suggestionId: string, statement?: string) => preferenceChange(projectId, () => prefs.confirm(projectId, suggestionId, statement));
export const dismissPreference = (projectId: string, suggestionId: string) => preferenceChange(projectId, () => prefs.dismiss(projectId, suggestionId));

export async function stopEnactment(caseId: string): Promise<void> {
  const e = cases.get(caseId)?.enactment;
  if (!e || e.state === "done" || e.state === "merged" || e.state === "stopped") return;
  clearTimeout(timers.get(caseId));
  runClock(caseId, false);
  patch(caseId, (c) => ({
    ...c,
    status: "needs_approval",
    health: seedHealth.get(caseId) === "affected" ? "affected" : "needs_you",
    enactment: {
      ...e,
      state: "stopped",
      question: undefined,
      steps: e.steps.map((s) =>
        s.status === "running" ? { ...s, status: "skipped", finishedAt: enactmentNow(caseId), summary: "Stopped by you before it finished." } : s,
      ),
      pullRequest: e.pullRequest && { ...e.pullRequest, state: "closed", mergeable: false },
    },
  }));
  commit();
}

export async function mergePullRequest(
  caseId: string,
  headSha: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const c = cases.get(caseId);
  const e = c?.enactment;
  const pr = e?.pullRequest;
  if (!c || !e || !pr) return { ok: false, reason: "There is no pull request to merge yet." };
  if (pr.state !== "open") {
    return { ok: false, reason: pr.state === "merged" ? "This pull request is already merged." : "This pull request was closed." };
  }
  if (e.state !== "waiting_for_merge" || !pr.mergeable) return { ok: false, reason: "The checks have not passed yet." };
  if (headChangesOnce.includes(e.fixKey) && !headChanged.has(caseId)) {
    runClock(caseId, true);
    headChanged.add(caseId);
    const newHead = "c41d7e2";
    patch(caseId, (c) => ({
      ...c,
      status: "enacting",
      health: during(c, "working"),
      enactment: {
        ...e,
        state: "running",
        steps: e.steps.map((s) =>
          s.key === "checks" ? { ...s, status: "running", startedAt: enactmentNow(caseId), finishedAt: undefined, summary: "A new commit arrived, so the checks are running again." } : s,
        ),
        pullRequest: {
          ...pr,
          headSha: newHead,
          checks: "pending",
          mergeable: false,
          checkRuns: pr.checkRuns.map((r) => ({ ...r, status: "pending" })),
        },
      },
    }));
    commit();
    schedule(caseId, playbackDuration(estimatedStepDuration("checks")));
    return {
      ok: false,
      reason:
        "Not merged. turtl added a commit (" + newHead + ") after the version you were looking at (" + headSha + "). The checks are running again; merge once they pass.",
    };
  }
  if (headSha !== pr.headSha) {
    return { ok: false, reason: "Not merged. The pull request changed after you looked. Check it again, then merge." };
  }
  runClock(caseId, true);
  patch(caseId, (c) => ({
    ...c,
    status: "enacting",
    health: during(c, "working"),
    enactment: { ...e, state: "merged", pullRequest: { ...pr, state: "merged", mergeable: false } },
  }));
  commit();
  schedule(caseId, 400);
  return { ok: true };
}

export async function setApprovals(projectId: string, mode: ApprovalMode): Promise<void> {
  const seed = projects.get(projectId);
  if (!seed) return;
  projects.set(projectId, { ...seed, approvals: mode });
  commit();
}

export async function setStarred(caseId: string, starred: boolean): Promise<void> {
  patch(caseId, (c) => ({ ...c, starred }));
  commit();
}

export function listStructuralFindings(projectId: string): StructuralFinding[] {
  return [...cases.values()]
    .flatMap((c) => (c.projectId === projectId && c.structural ? [c.structural] : []))
    .sort((a, b) => b.foundAt - a.foundAt);
}

function patchCheck(findingId: string, change: Partial<NonNullable<StructuralFinding["check"]>>) {
  const owner = [...cases.values()].find((c) => c.structural?.id === findingId);
  const finding = owner?.structural;
  if (!owner || !finding?.check) return;
  patch(owner.id, (c) => ({ ...c, structural: { ...finding, check: { ...finding.check!, ...change } } }));
  commit();
}

export async function approvePreventionCheck(findingId: string): Promise<void> {
  const check = [...cases.values()].find((c) => c.structural?.id === findingId)?.structural?.check;
  if (!check) throw new Error("This finding offers no check the monitor can run.");
  if (check.status !== "offered") throw new Error(`This check was already approved (${check.status.replace("_", " ")}).`);
  patchCheck(findingId, { status: "running" });
  setTimeout(() => patchCheck(findingId, {
    status: "registered",
    lastResult: { verdict: "passed", at: Date.now(), summary: "Its first run passed: an answer was saved and the next round loaded while ranking was slowed." },
  }), 1500);
}

export function chatKey(scope: ChatScope): string {
  if (scope.kind === "case") return "case:" + scope.caseId;
  if (scope.kind === "project") return "project:" + scope.projectId;
  if (scope.kind === "cluster") return "cluster:" + scope.projectId + ":" + scope.clusterId;
  return "node:" + scope.projectId + ":" + scope.nodeId;
}

function message(role: ChatMessage["role"], text: string, proposedFix?: FixOption, proposedPreference?: ChatMessage["proposedPreference"]): ChatMessage {
  messageCount += 1;
  return { id: "m" + messageCount, role, text, at: Date.now(), proposedFix, proposedPreference };
}

function withPreferenceStatus(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => (m.proposedPreference ? { ...m, proposedPreference: { ...m.proposedPreference, status: prefs.status(m.proposedPreference.id) } } : m));
}

export function chatMessages(scope: ChatScope): ChatMessage[] {
  const key = chatKey(scope);
  const existing = chats.get(key);
  if (existing) return withPreferenceStatus(existing);
  const opening =
    scope.kind === "case"
      ? [message("turtl", "Ask me anything about this case. I can also look for another fix if none of these feel right.")]
      : [];
  chats.set(key, opening);
  return opening;
}

export function chatBusy(scope: ChatScope): boolean {
  return busy.has(chatKey(scope));
}

function say(key: string, next: ChatMessage) {
  chats.set(key, [...(chats.get(key) ?? []), next]);
}

function propose(caseId: string): ChatMessage {
  const c = cases.get(caseId);
  const proposal = proposals[caseId];
  if (!c || !proposal || c.fixes.length >= 4 || c.fixes.some((f) => f.key === proposal.fix.key)) {
    return message(
      "turtl",
      "Those are all the fixes I would stand behind right now. If something new shows up in the logs I will add it here.",
    );
  }
  patch(caseId, (c) => ({
    ...c,
    fixes: [...c.fixes, proposal.fix],
    code: proposal.code ? [...c.code, proposal.code] : c.code,
  }));
  return message("turtl", proposal.text, proposal.fix);
}

function networkReply(scope: Exclude<ChatScope, { kind: "case" }>, turn: number): string {
  const network = networks[scope.projectId];
  if (!network) return "I have not mapped this project's code yet.";
  const label = (id: string) => network.nodes.find((n) => n.id === id)?.label ?? id;
  if (scope.kind === "node") {
    const node = network.nodes.find((n) => n.id === scope.nodeId);
    if (!node) return "I can't find that part of the code any more.";
    const uses = network.edges.filter((e) => e.from === node.id).map((e) => label(e.to));
    const usedBy = network.edges.filter((e) => e.to === node.id).map((e) => label(e.from));
    const replies = [
      node.summary + (node.path ? " It lives in " + node.path + "." : ""),
      (uses.length ? node.label + " relies on " + uses.join(", ") + ". " : node.label + " does not rely on anything else. ") +
        (usedBy.length ? "It is used by " + usedBy.join(", ") + "." : "Nothing else depends on it."),
      usedBy.length
        ? "If " + node.label + " stopped working, " + usedBy.join(" and ") + " would feel it first."
        : "If " + node.label + " stopped working, the rest of the app would carry on.",
    ];
    return replies[turn % replies.length];
  }
  if (scope.kind === "cluster") {
    const cluster = network.clusters.find((k) => k.id === scope.clusterId);
    if (!cluster) return "I can't find that part of the code any more.";
    const members = network.nodes.filter((n) => n.clusterId === cluster.id);
    const ids = new Set(members.map((n) => n.id));
    const outside = [
      ...new Set(
        network.edges
          .filter((e) => ids.has(e.from) !== ids.has(e.to))
          .map((e) => label(ids.has(e.from) ? e.to : e.from)),
      ),
    ];
    const replies = [
      cluster.summary + " It has " + members.length + " parts: " + members.map((n) => n.label).join(", ") + ".",
      outside.length
        ? cluster.name + " talks to " + outside.join(", ") + " outside its own area."
        : cluster.name + " keeps to itself.",
      cluster.health && cluster.health !== "clear"
        ? "This is where today's problem sits, so changes here deserve a careful check."
        : "Nothing is wrong here right now.",
    ];
    return replies[turn % replies.length];
  }
  const replies = [
    "This app has " +
      network.clusters.length +
      " areas: " +
      network.clusters.map((k) => k.name).join(", ") +
      ". Tap one to see what happens inside it.",
    "The parts that reach outside the app are " +
      network.nodes
        .filter((n) => n.kind === "external")
        .map((n) => n.label)
        .join(", ") +
      ". Those are the ones that can fail without any change on your side.",
    "The busiest part is " +
      [...network.nodes].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))[0].label +
      ". Most customer journeys pass through it.",
  ];
  return replies[turn % replies.length];
}

export async function sendChat(scope: ChatScope, text: string): Promise<void> {
  const trimmed = text.trim();
  const key = chatKey(scope);
  if (!trimmed || busy.has(key)) return;
  const asked = chatMessages(scope).filter((m) => m.role === "owner").length;
  say(key, message("owner", trimmed));
  busy.add(key);
  commit();
  await wait(900);
  const projectId = scope.kind === "case" ? cases.get(scope.caseId)?.projectId : undefined;
  const heard = projectId && prefs.statesWish(trimmed) ? prefs.suggest(projectId, trimmed, "chat") : null;
  if (heard) {
    say(key, message("turtl", "I can remember that for this project. It shapes which fix I recommend, and it never approves anything on its own.", undefined, { id: heard.id, statement: heard.statement, status: "pending" }));
  } else if (scope.kind === "case") {
    const replies = caseReplies[scope.caseId] ?? caseReplies.default;
    const wantsFix = asked === 1 || /another|other|else|different|new fix|option/i.test(trimmed);
    const alreadyProposed = cases.get(scope.caseId)?.fixes.some((f) => f.proposedInChat);
    say(key, wantsFix && !alreadyProposed ? propose(scope.caseId) : message("turtl", replies[asked % replies.length]));
  } else {
    say(key, message("turtl", networkReply(scope, asked)));
  }
  busy.delete(key);
  commit();
}

export async function requestNewFix(caseId: string): Promise<void> {
  const scope: ChatScope = { kind: "case", caseId };
  const key = chatKey(scope);
  if (busy.has(key)) return;
  chatMessages(scope);
  say(key, message("owner", "Is there another way to fix this?"));
  busy.add(key);
  commit();
  await wait(1100);
  say(key, propose(caseId));
  busy.delete(key);
  commit();
}

for (const item of caseSeeds) {
  const enactment = item.enactment;
  if (!enactment) continue;
  const fix = item.fixes.find((option) => option.key === enactment.fixKey);
  if (!fix) continue;
  const plan = planFor(fix);
  plans.set(item.id, plan);
  const steps = enactment.steps.map((step) => ({ ...step, estimatedDurationMs: step.estimatedDurationMs ?? estimatedStepDuration(step.key) }));
  cases.set(item.id, { ...item, enactment: { ...enactment, steps } });
  runClock(item.id, enactment.state === "running" || enactment.state === "merged");
  if (enactment.state === "running" || enactment.state === "merged") {
    const running = steps.find((step) => step.status === "running");
    const elapsed = running?.startedAt ? Math.max(0, enactmentNow(item.id) - running.startedAt) : 0;
    schedule(item.id, running ? playbackDuration(Math.max(0, running.estimatedDurationMs - elapsed)) : 500);
  }
}
