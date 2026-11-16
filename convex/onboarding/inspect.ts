import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { DEFAULT_MODEL, respond } from "../codeNetwork/openai";
import { MASK, redactFiles, redactText } from "../codeNetwork/redact";
import { gateFor } from "../consent/gate";
import { plainFailure } from "../consent/outbound";
import { repositoryAccess } from "../github/access";
import {
  confirmItems,
  detectStack,
  manifestPath,
  READINESS_ITEMS,
  ruleItems,
  scanSignals,
  scopeFiles,
  type Hit,
  type Item,
  type ItemKey,
  type RepoFile,
  type Stack,
} from "./detect";
import { readRepository } from "./github";

declare const process: { env: Record<string, string | undefined> };

export const PROMPT_VERSION = "onboarding-inspect-v1";
const EXCERPT_CHARS = 6000;
const EXCERPT_BUDGET = 150_000;
const MAX_LISTED_PATHS = 400;

const DEFINITIONS: Record<ItemKey, string> = {
  error_logs: "When something fails, the app records a structured error (a stable error code, not just free text) with an identifier that ties it to one request, run or attempt, so turtl can count failures and find a specific one.",
  health_check: "An HTTP endpoint that answers quickly when the server is up, such as GET /health.",
  readiness_check: "An HTTP endpoint that says whether the app can actually serve customers right now, checking its own dependencies (database, providers), separate from the health check.",
  journey_checks: "Automated checks that walk through the important customer journeys end to end (for example a server endpoint that makes and verifies a test booking, or end-to-end tests).",
  feature_flags: "Switches that turn a part of the app on or off without a deploy.",
  recovery_hooks: "Endpoints, protected by a secret, that let an operator restore service without a deploy, for example turning a failing optional feature off.",
  test_fixtures: "Test accounts or fixture data that checks can use without touching real customers, and that are cleaned up or excluded from real counts.",
};

const INSTRUCTIONS = [
  "You inspect a software repository for turtl, an on-call app for a solo owner who cannot read code. turtl will watch and recover this app.",
  "For each readiness item, decide found, missing or unknown for THIS app (only the files listed, which are the app's files).",
  "found: the excerpts show it exists for this app. Cite the file paths and line numbers (as numbered in the excerpts) that show it. Never cite a file that is not listed.",
  "missing: you saw enough of the relevant code (for example all of the app's server routes) to be confident it does not exist.",
  "unknown: the excerpts do not let you tell. Prefer unknown over guessing.",
  "Pattern matches are leads found by a text search; many are false positives. Judge them; do not trust them.",
  "Each note is one or two plain sentences an owner who cannot read code understands, saying what exists or what is missing. No code words like mutation, handler or schema.",
  "Then suggest 2 to 5 things a customer depends on that must never break, as plain statements the owner can agree with, such as 'A customer can book an appointment and gets a confirmation.' Base each only on behaviour the code shows, with a short why.",
  "Finally write a two-sentence summary of how ready the app is for turtl to watch and recover it.",
].join(" ");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "suggestions", "summary"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "status", "note", "files"],
        properties: {
          key: { type: "string", enum: READINESS_ITEMS.map((item) => item.key) },
          status: { type: "string", enum: ["found", "missing", "unknown"] },
          note: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "line"],
              properties: { path: { type: "string" }, line: { type: "integer" } },
            },
          },
        },
      },
    },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "why"],
        properties: { text: { type: "string" }, why: { type: "string" } },
      },
    },
    summary: { type: "string" },
  },
};

function numbered(content: string): string {
  return content
    .slice(0, EXCERPT_CHARS)
    .split("\n")
    .map((line, index) => `${index + 1}| ${line}`)
    .join("\n");
}

export function inspectionInput(input: {
  repo: string;
  sha: string;
  folders: string[];
  stack: Stack;
  scoped: RepoFile[];
  hits: Record<ItemKey, Hit[]>;
}): string {
  // Secrets never reach the model: secret files are left out of the excerpts and secrets are masked in the rest,
  // including in the pattern matches' lines (convex/codeNetwork/redact.ts).
  const { repo, sha, folders, stack } = input;
  const scoped = redactFiles(input.scoped).files;
  const hits = Object.fromEntries(
    Object.entries(input.hits).map(([key, list]) => [key, list.map((hit) => ({ ...hit, text: redactText(hit.text).text }))]),
  ) as Record<ItemKey, Hit[]>;
  const score = new Map<string, number>();
  for (const list of Object.values(hits)) for (const hit of list) score.set(hit.path, (score.get(hit.path) ?? 0) + 1);
  const important = (path: string) => /(^|\/)(package\.json|app\.json|http\.[jt]s|schema\.[jt]s|README\.md)$|(^|\/)app\/api\//.test(path);
  const ordered = [...scoped].sort(
    (a, b) => (score.get(b.path) ?? 0) + (important(b.path) ? 2 : 0) - ((score.get(a.path) ?? 0) + (important(a.path) ? 2 : 0)),
  );
  const excerpts: string[] = [];
  let used = 0;
  for (const file of ordered) {
    const block = `### ${file.path} (${file.content.split("\n").length} lines)\n${numbered(file.content)}`;
    if (used + block.length > EXCERPT_BUDGET) continue;
    excerpts.push(block);
    used += block.length;
  }
  return [
    `Repository: ${repo} at commit ${sha}.`,
    folders.length ? `The app lives in: ${folders.join(", ")} (plus files elsewhere that import from them).` : "The app is the whole repository.",
    `Stack turtl detected: ${stack.label}. Evidence: ${stack.evidence.join("; ") || "none"}.`,
    "",
    "## Readiness items",
    ...READINESS_ITEMS.map((item) => `- ${item.key} (${item.label}): ${DEFINITIONS[item.key]}`),
    "",
    `## The app's files (${input.scoped.length})`,
    ...input.scoped.slice(0, MAX_LISTED_PATHS).map((file) => `- ${file.path}`),
    "",
    "## Pattern matches (leads, not findings)",
    ...READINESS_ITEMS.map((item) =>
      [`### ${item.key}`, ...(hits[item.key].length ? hits[item.key].map((hit) => `- ${hit.path}:${hit.line}: ${hit.text}`) : ["- none"])].join("\n"),
    ),
    "",
    `## Excerpts (${excerpts.length} of ${input.scoped.length} files; each cut at ${EXCERPT_CHARS} characters, lines numbered; secrets show as ${MASK})`,
    ...excerpts,
  ].join("\n");
}

type InspectResult =
  | { outcome: "missing" }
  | { outcome: "failed"; reason: string }
  | { outcome: "done"; stack: string; judgedBy: "model" | "rules"; files: number };

// Reads the repository, runs the plain detectors, and asks one model to judge each readiness item. Without a
// model answer it stores the pattern matches as leads and says that no model judged them.
export const run = internalAction({
  args: { inspectionId: v.id("onboardingInspections") },
  handler: async (ctx, { inspectionId }): Promise<InspectResult> => {
    const context: { inspection: Doc<"onboardingInspections">; appId: Id<"apps"> } | null = await ctx.runQuery(
      internal.onboarding.records.inspectionContext,
      { inspectionId },
    );
    if (!context) return { outcome: "missing" as const };
    const { inspection, appId } = context;
    const access = await repositoryAccess(ctx, inspection.repo, { appId });
    const read = access.ok ? await readRepository(inspection.repo, access.token) : { ok: false as const, reason: access.message };
    if (!read.ok) {
      await ctx.runMutation(internal.onboarding.records.failInspection, { inspectionId, error: read.reason });
      return { outcome: "failed" as const, reason: read.reason };
    }
    const scoped = scopeFiles(read.files, inspection.folders);
    if (scoped.length === 0) {
      const error = inspection.folders.length
        ? `turtl found no files it can read under ${inspection.folders.join(", ")} in ${inspection.repo}.`
        : `turtl found no files it can read in ${inspection.repo}.`;
      await ctx.runMutation(internal.onboarding.records.failInspection, { inspectionId, error });
      return { outcome: "failed" as const, reason: error };
    }
    const stack = detectStack(scoped);
    const hits = scanSignals(scoped);
    const hasManifest = scoped.some((file) => file.path === manifestPath(inspection.folders));
    const readNote = [read.note, read.truncated ? `The repository is large, so turtl read its first ${read.files.length} readable files.` : undefined]
      .filter(Boolean)
      .join(" ");

    let items: Item[];
    let suggestions: { text: string; why: string }[] = [];
    let summary: string | undefined;
    let judgedBy: "model" | "rules" = "model";
    let fallbackReason: string | undefined;
    let agentRunId: Id<"agentRuns"> | undefined;
    const gate = gateFor(ctx, { appId });
    const refused = process.env.OPENAI_API_KEY ? await gate.blocked("openai") : null;
    if (!process.env.OPENAI_API_KEY) {
      judgedBy = "rules";
      fallbackReason = "No model answered, because this turtl backend has no AI model set up. These results are text-search leads only, so nothing is called missing; you can still prepare the app, and reading it again once a model is set up gives a fuller report.";
      items = ruleItems(hits);
    } else if (refused) {
      judgedBy = "rules";
      fallbackReason = `No model answered: ${refused}. These results are text-search leads only.`;
      items = ruleItems(hits);
    } else {
      agentRunId = await ctx.runMutation(internal.onboarding.records.startAgentRun, {
        appId,
        modelId: process.env.OPENAI_MODEL || DEFAULT_MODEL,
        promptVersion: PROMPT_VERSION,
        framework: stack.label,
        repositoryArea: inspection.folders.length ? inspection.folders.join(", ") : "whole repository",
      });
      const started = Date.now();
      try {
        const { text } = await respond(gate, {
          instructions: INSTRUCTIONS,
          input: inspectionInput({ repo: inspection.repo, sha: read.sha, folders: inspection.folders, stack, scoped, hits }),
          maxOutputTokens: 12_000,
          format: { type: "json_schema", name: "readiness_report", strict: true, schema: SCHEMA },
        });
        const parsed = JSON.parse(text) as { items: Item[]; suggestions: { text: string; why: string }[]; summary: string };
        items = confirmItems(
          parsed.items.map((item) => ({ ...item, files: item.files.map((file) => ({ path: file.path, ...((file.line ?? 0) > 0 && { line: file.line }) })) })),
          scoped,
        );
        suggestions = parsed.suggestions
          .filter((suggestion) => suggestion.text.trim())
          .slice(0, 5)
          .map((suggestion) => ({ text: suggestion.text.trim().slice(0, 200), why: suggestion.why.trim().slice(0, 300) }));
        summary = parsed.summary.trim().slice(0, 600);
        await ctx.runMutation(internal.onboarding.records.finishAgentRun, { agentRunId, status: "completed", durationMs: Date.now() - started });
      } catch (error) {
        // Plain words only: a vendor's own error text can echo the code that was sent.
        const message = plainFailure("OpenAI", error);
        await ctx.runMutation(internal.onboarding.records.finishAgentRun, { agentRunId, status: "failed", durationMs: Date.now() - started, error: message });
        judgedBy = "rules";
        fallbackReason = `No model answered (${message}). These results are text-search leads only.`;
        items = ruleItems(hits);
      }
    }
    await ctx.runMutation(internal.onboarding.records.finishInspection, {
      inspectionId,
      ref: read.sha,
      defaultBranch: read.defaultBranch,
      stack,
      items,
      suggestions,
      hasManifest,
      filesRead: scoped.length,
      judgedBy,
      ...(summary && { summary }),
      ...(fallbackReason && { fallbackReason }),
      ...(readNote && { readNote }),
      ...(agentRunId && { agentRunId }),
    });
    return { outcome: "done" as const, stack: stack.label, judgedBy, files: scoped.length };
  },
});
