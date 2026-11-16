import type { PullRequest } from "../types";
import type { DetectedStack, LiveCheck, NeverBreak, Onboarding, ReadinessItem, ReadinessKey } from "./types";

const minute = 60_000;
const day = 86_400_000;

export const readinessLabels: Record<ReadinessKey, string> = {
  error_logs: "Structured error logs",
  health_check: "Health check",
  readiness_check: "Readiness check",
  journey_checks: "Checks for important journeys",
  feature_flags: "Feature flags",
  recovery_hooks: "Recovery hooks",
  test_fixtures: "Test accounts and fixtures",
};

const expoConvex = (evidence: string[]): DetectedStack => ({ id: "expo-convex", label: "Expo with a Convex backend", supported: true, evidence });

const file = (repo: string, sha: string, path: string, line?: number) => ({ path, line, url: "https://github.com/" + repo + "/blob/" + sha + "/" + path + (line ? "#L" + line : "") });

function item(key: ReadinessKey, status: ReadinessItem["status"], note: string, files: ReadinessItem["files"] = []): ReadinessItem {
  return { key, label: readinessLabels[key], status, note, files };
}

const guardianRepo = "ronoktanvir/guardian";
const guardianRef = "9f41c07";
const guardianFile = (path: string, line?: number) => file(guardianRepo, guardianRef, path, line);
const guardianLive = "https://guardian-scoring.vercel.app";

const orcaRepo = "ronoktanvir/orca";
const orcaRef = "2c7e5ad";
const orcaFile = (path: string, line?: number) => file(orcaRepo, orcaRef, path, line);

const neverBreakSeeds: Record<string, NeverBreak[]> = {
  guardian: [
    { id: "guardian-scored", text: "A customer's transaction is scored", suggested: true, why: "convex/scoring.ts scores every incoming transaction; if it stops, payments go unchecked.", addCheck: true },
    { id: "guardian-alerts", text: "Flagged transactions show an alert", suggested: true, why: "app/alerts.tsx lists the alerts written by convex/alerts.ts.", addCheck: false },
    { id: "guardian-explain", text: "Merchants can see why a payment was flagged", suggested: false, addCheck: false },
  ],
  orca: [
    { id: "orca-task", text: "A team finishes a task and reports its result", suggested: true, why: "convex/teams.ts runs every task through runTeam; if it stops, nothing finishes.", addCheck: true },
    { id: "orca-start", text: "The owner can start a new task", suggested: true, why: "app/new-task.tsx is the only way to start work.", addCheck: true },
    { id: "orca-costs", text: "Every run records what it cost", suggested: true, why: "convex/billing.ts writes a cost row after each run.", addCheck: false },
  ],
};

export function onboardingSeeds(now: number): Onboarding[] {
  const checkedAt = now - 2 * day + 95 * minute;
  return [
    {
      projectId: "guardian",
      repo: guardianRepo,
      repoUrl: "https://github.com/" + guardianRepo,
      liveUrl: guardianLive,
      folders: [],
      stage: "registered",
      inspection: {
        id: "guardian-inspection-1",
        ref: guardianRef,
        stack: expoConvex(["package.json depends on expo and convex", "convex/schema.ts defines the tables"]),
        items: [
          item("error_logs", "found", "Errors are written as JSON with a request id and the transaction id.", [guardianFile("convex/lib/log.ts", 12), guardianFile("convex/scoring.ts", 88)]),
          item("health_check", "found", "GET /health answers from the Convex HTTP router.", [guardianFile("convex/http.ts", 21)]),
          item("readiness_check", "found", "GET /ready checks the scoring model and the database before it says yes.", [guardianFile("convex/http.ts", 34)]),
          item("journey_checks", "missing", "Nothing walks a transaction from submission to a score."),
          item("feature_flags", "found", "Flags live in a table and are read through flags.isOn.", [guardianFile("convex/flags.ts", 7), guardianFile("convex/schema.ts", 54)]),
          item("recovery_hooks", "unknown", "setScoringMode can switch to rules-only scoring, but nothing outside the app can call it safely.", [guardianFile("convex/scoring.ts", 140)]),
          item("test_fixtures", "found", "A seeded test merchant and card fixtures.", [guardianFile("convex/seed.ts", 9), guardianFile("tests/fixtures/transactions.json")]),
        ],
        summary: "Guardian already logs well and answers health checks. It needed a check for the scoring journey and a safe way to switch scoring to rules only.",
        judgedBy: "model",
        finishedAt: now - 2 * day,
      },
      neverBreak: neverBreakSeeds.guardian,
      answered: true,
      approvedAt: now - 2 * day + 20 * minute,
      pullRequest: {
        repo: guardianRepo,
        number: 12,
        title: "Prepare Guardian for turtl: scoring journey check and recovery hook",
        url: "https://github.com/" + guardianRepo + "/pull/12",
        headSha: "b81c2e4",
        state: "merged",
        checks: "passing",
        checkRuns: [{ name: "Typecheck", status: "passed" }, { name: "Tests", status: "passed" }, { name: "Transaction scoring journey", status: "passed" }],
        mergeable: false,
      },
      checks: [
        { kind: "health", name: "Health check", url: guardianLive + "/health", state: "works", detail: "Answered 200 in 84 ms.", registered: false, checkedAt },
        { kind: "journey", name: "A customer's transaction is scored", url: guardianLive + "/turtl/journeys/transaction-scored", state: "works", detail: "A test transaction was scored in 1.2 s.", registered: true, checkedAt },
        { kind: "flag", name: "rules_only_scoring", url: guardianLive + "/turtl/flags/rules_only_scoring", state: "works", detail: "Read the flag: off.", registered: true, checkedAt },
        { kind: "recovery_hook", name: "Switch scoring to rules only", url: guardianLive + "/turtl/recovery/rules-only", state: "works", detail: "Answered a dry run without changing anything.", registered: true, checkedAt },
      ],
      checkedAt,
    },
    {
      projectId: "orca",
      repo: orcaRepo,
      repoUrl: "https://github.com/" + orcaRepo,
      liveUrl: "https://orca-teams.vercel.app",
      folders: [],
      stage: "asking",
      inspection: {
        id: "orca-inspection-1",
        ref: orcaRef,
        stack: expoConvex(["package.json depends on expo and convex", "app/_layout.tsx uses Expo Router"]),
        items: [
          item("error_logs", "found", "Agent runs are logged with a run id. Tool errors are logged as plain text.", [orcaFile("convex/agents/log.ts", 18)]),
          item("health_check", "missing", "No endpoint says whether the app is up."),
          item("readiness_check", "missing", "Nothing checks that the model provider and the database answer before work starts."),
          item("journey_checks", "missing", "No check runs a task through a team from start to finish."),
          item("feature_flags", "unknown", "convex/config.ts holds settings that might work as flags. turtl could not tell whether they change while the app runs.", [orcaFile("convex/config.ts", 5)]),
          item("recovery_hooks", "missing", "There is no way to pause the agent teams from outside the app."),
          item("test_fixtures", "found", "A seeded test team with two agents.", [orcaFile("convex/seed.ts", 4)]),
        ],
        summary: "Orca logs its runs, but nothing outside the app can tell whether it is working.",
        judgedBy: "model",
        finishedAt: now - 12 * minute,
      },
      neverBreak: neverBreakSeeds.orca,
      answered: false,
      checks: [],
    },
  ];
}

export function offlineInspection(projectId: string, count: number, now: number): NonNullable<Onboarding["inspection"]> {
  return {
    id: projectId + "-inspection-" + count,
    items: (Object.keys(readinessLabels) as ReadinessKey[]).map((key) => item(key, "unknown", "Not read yet.")),
    readNote: "This copy of turtl works offline, so it has not read the repository. Every item stays unknown until it does.",
    finishedAt: now,
  };
}

export function preparationPullRequest(o: Onboarding): PullRequest {
  const number = 31;
  return {
    repo: o.repo,
    number,
    title: "Prepare " + o.repo.split("/")[1] + " for turtl",
    url: o.repoUrl + "/pull/" + number,
    headSha: "4e9b0d1",
    state: "open",
    checks: "pending",
    checkRuns: [{ name: "Typecheck", status: "pending" }, { name: "Tests", status: "pending" }, { name: "Journey checks", status: "pending" }],
    mergeable: false,
  };
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function liveChecksFor(o: Onboarding, now: number): LiveCheck[] {
  const base = (o.liveUrl ?? "").replace(/\/$/, "");
  const check = (kind: LiveCheck["kind"], name: string, path: string, detail: string, registered: boolean): LiveCheck => ({ kind, name, url: base + path, state: "works", detail, registered, checkedAt: now });
  return [
    check("health", "Health check", "/health", "Answered 200 in 92 ms.", false),
    check("readiness", "Readiness check", "/ready", "The database and the model provider answered.", false),
    ...o.neverBreak.filter((n) => n.addCheck).map((n) => check("journey", n.text, "/turtl/journeys/" + slug(n.text), "The journey completed with the test account.", true)),
    check("recovery_hook", "Pause new work", "/turtl/recovery/pause", "Answered a dry run without changing anything.", true),
  ];
}
