import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { Revision } from "../constants";
import { call, CREDENTIAL_REF, describeFailure, ENVIRONMENT, revisionOf, topErrorCode, type WatchedApp } from "../protectedApp/client";
import type { HandlerInput, StepHandler } from "../runner/contract";
import { evidenceRow, loadJourneyContext, type Facts } from "../runner/handlers/journey";
import { validateErrors, validateFlags, validateHealth, validateRevisionResponse, validateSnapshot, type Collector, type EvidenceSnapshot, type ObservedWindow } from "./snapshots";

type ReadResult = {
  facts: Facts;
  missing: string[];
  revision: Revision;
  rows: ReturnType<typeof evidenceRow>[];
  readCount: number;
  window?: ObservedWindow;
};

async function readSource<T extends { environment?: string; revision?: string }>(
  app: WatchedApp,
  base: string,
  path: string,
  validate: (body: unknown) => T,
  authenticated = false,
) {
  const response = await call(`${base}${path}`, authenticated ? { app, credentialRef: CREDENTIAL_REF } : { app });
  const observedAt = Date.now();
  if (response.kind !== "response" || response.status !== 200) {
    return { ok: false as const, reason: describeFailure(response), observedAt, environment: ENVIRONMENT, revision: revisionOf(null, base) };
  }
  try {
    const value = validate(response.body);
    return { ok: true as const, value, observedAt, environment: value.environment ?? ENVIRONMENT, revision: revisionOf(value.revision ?? null, base) };
  } catch (error) {
    return { ok: false as const, reason: `invalid response: ${error instanceof Error ? error.message : "invalid source shape"}`, observedAt, environment: ENVIRONMENT, revision: revisionOf(null, base) };
  }
}

export async function readAppState(input: HandlerInput, base: string, app: WatchedApp): Promise<ReadResult> {
  const [health, flags, revision] = await Promise.all([
    readSource(app, base, "/health", validateHealth),
    readSource(app, base, "/flags", validateFlags, true),
    readSource(app, base, "/revision", validateRevisionResponse),
  ]);
  const facts: Facts = {};
  const missing: string[] = [];
  if (health.ok) facts["health.ok"] = health.value.ok;
  else missing.push(`health (${health.reason})`);
  if (flags.ok) facts["flags.recommendationsEnabled"] = flags.value.recommendationsEnabled;
  else missing.push(`the recommendations flag (${flags.reason})`);
  if (revision.ok) facts["app.revision"] = revision.value.revision;
  else missing.push(`the app's revision (${revision.reason})`);
  const observations = [
    { read: health, kind: "health", sourceRef: "GET /health", title: health.ok ? `The booking app reports health ok is ${health.value.ok}.` : `Could not read health: ${health.reason}.` },
    { read: flags, kind: "flags", sourceRef: "GET /flags", title: flags.ok ? `Recommendations are turned ${flags.value.recommendationsEnabled ? "on" : "off"}.` : `Could not read the recommendations flag: ${flags.reason}.` },
    { read: revision, kind: "revision", sourceRef: "GET /revision", title: revision.ok ? `The booking app reports revision ${revision.value.revision}.` : `Could not read the app's revision: ${revision.reason}.` },
  ];
  return {
    facts,
    missing,
    revision: revision.revision,
    rows: observations.map(({ read, kind, sourceRef, title }) => ({
      ...evidenceRow(input, read.revision, { kind, sourceRef, title, ...(kind === "health" && { body: "A health response does not prove that customer booking works." }) }),
      observedAt: read.observedAt,
      environment: read.environment,
    })),
    readCount: [health, flags, revision].filter((read) => read.ok).length,
  };
}

export async function readErrorWindow(input: HandlerInput, base: string, app: WatchedApp): Promise<ReadResult> {
  const errors = await readSource(app, base, "/errors", validateErrors, true);
  const facts: Facts = {};
  if (errors.ok) {
    facts["errors.totalBookings"] = errors.value.counts.totalBookings;
    facts["errors.failedBookings"] = errors.value.counts.failedBookings;
    facts["errors.errorRate"] = errors.value.counts.errorRate;
    facts["errors.topCode"] = topErrorCode(errors.value);
  }
  const title = errors.ok
    ? `${errors.value.counts.failedBookings} of ${errors.value.counts.totalBookings} customer booking attempts failed in the observed window.`
    : `Could not read failed bookings: ${errors.reason}.`;
  return {
    facts,
    missing: errors.ok ? [] : [`failed bookings (${errors.reason})`],
    revision: errors.revision,
    rows: [{
      ...evidenceRow(input, errors.revision, {
        kind: "errors",
        sourceRef: "GET /errors",
        title,
        ...(errors.ok && { body: `Window ${errors.value.window.since}–${errors.value.window.until}. Error rate ${Math.round(errors.value.counts.errorRate * 100)}%. Most common sampled error: ${facts["errors.topCode"]}.${errors.value.window.truncated ? " The window's booking sample was capped." : ""}` }),
      }),
      observedAt: errors.observedAt,
      environment: errors.environment,
    }],
    readCount: errors.ok ? 1 : 0,
    ...(errors.ok && { window: errors.value.window }),
  };
}

async function collect(ctx: ActionCtx, input: HandlerInput, collector: Collector) {
  if (input.step.key !== collector || input.step.purpose !== collector || input.step.kind !== "function") {
    return { status: "failed" as const, error: "Evidence collector has the wrong step key, purpose or kind." };
  }
  const loaded = await loadJourneyContext(ctx, input);
  if (!loaded.ok) return { status: "failed" as const, error: loaded.reason };
  const { base, watched } = loaded.context;
  const result = collector === "collect_app_state" ? await readAppState(input, base, watched) : await readErrorWindow(input, base, watched);
  const ids: Id<"evidence">[] = await ctx.runMutation(internal.protectedApp.records.addEvidence, { rows: result.rows });
  if (result.missing.length) {
    return { status: "failed" as const, error: `Could not collect required evidence: ${result.missing.join("; ")}.` };
  }
  const output: EvidenceSnapshot = {
    version: 1,
    collector,
    caseId: input.case._id,
    stepId: input.step._id,
    attemptId: input.attempt._id,
    facts: result.facts,
    missing: [],
    revision: result.revision,
    evidence: result.rows.map((row, i) => ({ id: ids[i], kind: row.kind, sourceRef: row.sourceRef!, observedAt: row.observedAt, environment: row.environment, revision: row.revision })),
    ...(result.window && { window: result.window }),
  };
  validateSnapshot(output, collector);
  return {
    status: "done" as const,
    summary: collector === "collect_app_state" ? "Collected health, recommendations flag and app revision." : "Collected the customer booking error window.",
    handoff: { note: "The read-only collector snapshot is in this attempt's output.", refs: output.evidence.map(({ id, kind }) => ({ kind: "evidence", id, label: kind })) },
    output,
  };
}

export const appStateHandler: StepHandler = { timeoutMs: 45_000, run: (ctx, input) => collect(ctx, input, "collect_app_state") };
export const errorWindowHandler: StepHandler = { timeoutMs: 45_000, run: (ctx, input) => collect(ctx, input, "collect_error_window") };
