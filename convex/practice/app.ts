import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { catalog } from "../bookingDemo/catalog";
import { JOURNEY_SCENARIOS } from "../bookingDemo/journeyCore";
import { recommend } from "../bookingDemo/provider";
import { ENVIRONMENT } from "../protectedApp/client";
import { PRACTICE_REVISION, type Switches } from "./rules";

// The practice app itself: what its routes (convex/practice/http.ts) run. Internal only. It shares the booking demo's
// catalog, its simulated recommendations provider and its scenario, never its tables or its switches: every row here
// belongs to one practice project, found by that project's id.

const vSwitchName = v.union(v.literal("recommendationsEnabled"), v.literal("backupStoreEnabled"));
const vScenario = v.literal("slow_recommendations");

const switchesOf = (row: Doc<"practiceApps">): Switches => ({
  recommendationsEnabled: row.recommendationsEnabled,
  providerTimeout: row.providerTimeout,
  bookingStoreFailure: row.bookingStoreFailure,
  backupStoreEnabled: row.backupStoreEnabled,
});

const rowFor = (ctx: Pick<QueryCtx, "db">, appId: Id<"apps">) =>
  ctx.db.query("practiceApps").withIndex("by_app", (q) => q.eq("appId", appId)).first();

// The project a request's path names, and the hash its token must match. Null for any id that is not a practice app.
export const route = internalQuery({
  args: { appId: v.string() },
  returns: v.union(v.null(), v.object({ appId: v.id("apps"), tokenHash: v.string() })),
  handler: async (ctx, { appId }) => {
    const id = ctx.db.normalizeId("apps", appId);
    const row = id ? await rowFor(ctx, id) : null;
    return row ? { appId: row.appId, tokenHash: row.tokenHash } : null;
  },
});

export const switches = internalQuery({
  args: { appId: v.id("apps") },
  returns: v.union(v.null(), v.object({ recommendationsEnabled: v.boolean(), providerTimeout: v.boolean(), bookingStoreFailure: v.boolean(), backupStoreEnabled: v.boolean(), updatedAt: v.number() })),
  handler: async (ctx, { appId }) => {
    const row = await rowFor(ctx, appId);
    return row ? { ...switchesOf(row), updatedAt: row.updatedAt } : null;
  },
});

// A switch the practice app's catalog actions flip (POST /flags, POST /backup-store). The failures themselves have no
// route: only the owner breaks their practice app, from turtl (convex/practice/projects.ts).
export const setSwitch = internalMutation({
  args: { appId: v.id("apps"), name: vSwitchName, value: v.boolean() },
  returns: v.union(v.null(), v.object({ value: v.boolean(), updatedAt: v.number() })),
  handler: async (ctx, { appId, name, value }) => {
    const row = await rowFor(ctx, appId);
    if (!row) return null;
    const updatedAt = Date.now();
    await ctx.db.patch(row._id, { [name]: value, updatedAt });
    return { value, updatedAt };
  },
});

export const saveBooking = internalMutation({
  args: { appId: v.id("apps"), fixtureRunId: v.string(), serviceId: v.string(), date: v.string(), time: v.string(), store: v.union(v.literal("main"), v.literal("backup")) },
  returns: v.id("practiceBookings"),
  handler: async (ctx, args) => await ctx.db.insert("practiceBookings", { ...args, createdAt: Date.now() }),
});

export const readBooking = internalQuery({
  args: { bookingId: v.id("practiceBookings") },
  handler: async (ctx, { bookingId }) => await ctx.db.get(bookingId),
});

/** More test bookings than one check ever makes; it bounds the cleanup. */
const CLEANUP_BATCH = 20;

export const cleanup = internalMutation({
  args: { appId: v.id("apps"), fixtureRunId: v.string() },
  returns: v.number(),
  handler: async (ctx, { appId, fixtureRunId }) => {
    const rows = await ctx.db.query("practiceBookings").withIndex("by_app_and_fixture", (q) => q.eq("appId", appId).eq("fixtureRunId", fixtureRunId)).take(CLEANUP_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});

type Step = { step: string; verdict: "passed" | "failed" | "skipped"; detail: string };
type Failure = { code: string; message: string; step: string; provider?: string; retryable: boolean };
/** The booking demo's journey-check answer (convex/protectedApp/client.ts reads it), without its staging switches. */
export type PracticeJourney = {
  runId: string;
  verdict: "passed" | "failed";
  failedStep: string | null;
  error: Failure | null;
  steps: Step[];
  cleanup: { ok: boolean; deletedBookings: number };
  revision: string;
  environment: string;
  startedAt: number;
  completedAt: number;
  scenario?: "slow_recommendations";
};

// One test booking through the practice app's own booking path, then cleanup: the booking demo's journey check
// (convex/bookingDemo/checks.ts), with this project's switches and rows. With the scenario, the provider is slowed for
// this one run in memory; nothing is written to the switches.
export const journey = internalAction({
  args: { appId: v.id("apps"), scenario: v.optional(vScenario) },
  handler: async (ctx, { appId, scenario }): Promise<PracticeJourney | null> => {
    const startedAt = Date.now();
    const runId = crypto.randomUUID();
    const live: (Switches & { updatedAt: number }) | null = await ctx.runQuery(internal.practice.app.switches, { appId });
    if (!live) return null;
    const config: Switches = scenario ? { ...live, providerTimeout: JOURNEY_SCENARIOS[scenario].apply(live).providerTimeout } : live;
    const storeDown = config.bookingStoreFailure && !config.backupStoreEnabled;
    const steps: Step[] = [];
    let failedStep: string | null = null;
    let error: Failure | null = null;
    let deletedBookings = 0;
    try {
      const fixture = catalog();
      steps.push({ step: "load_catalog", verdict: "passed", detail: "Selected the first service and time from the practice app's catalog." });
      if (config.recommendationsEnabled && !storeDown) {
        try {
          await recommend(config.providerTimeout);
        } catch {
          error = { code: "RECOMMENDATIONS_TIMEOUT", message: "The recommendation provider timed out. Your booking was not saved.", step: "recommendations", provider: "simulated-recommendations", retryable: true };
        }
      }
      if (!error && storeDown) {
        error = { code: "BOOKING_STORE_UNAVAILABLE", message: "The booking store is unavailable. Your booking was not saved.", step: "submit_booking", retryable: true };
      }
      if (error) {
        failedStep = error.step;
        if (failedStep === "recommendations") {
          steps.push({ step: "recommendations", verdict: "failed", detail: scenario ? `${JOURNEY_SCENARIOS[scenario].detail} ${error.message}` : error.message });
          steps.push({ step: "submit_booking", verdict: "skipped", detail: "Waiting for recommendations blocked the booking write." });
        } else {
          steps.push({ step: "recommendations", verdict: "skipped", detail: "The booking store is down, so the provider was not called." });
          steps.push({ step: "submit_booking", verdict: "failed", detail: error.message });
        }
        steps.push({ step: "verify_persisted", verdict: "skipped", detail: "No confirmation to verify." });
      } else {
        const store = config.bookingStoreFailure ? ("backup" as const) : ("main" as const);
        steps.push({ step: "recommendations", verdict: config.recommendationsEnabled ? "passed" : "skipped", detail: config.recommendationsEnabled ? "Simulated provider responded." : `Recommendations are off: provider bypassed.${scenario ? " The scenario's slow provider was never called." : ""}` });
        const booking = { appId, fixtureRunId: runId, serviceId: fixture.services[0].id, date: fixture.date, time: fixture.slots[0], store };
        const bookingId: Id<"practiceBookings"> = await ctx.runMutation(internal.practice.app.saveBooking, booking);
        steps.push({ step: "submit_booking", verdict: "passed", detail: store === "backup" ? "The booking was saved to the backup store and confirmed." : "The booking was saved and confirmed." });
        const saved: Doc<"practiceBookings"> | null = await ctx.runQuery(internal.practice.app.readBooking, { bookingId });
        const matches = saved?.appId === appId && saved.fixtureRunId === runId && saved.serviceId === booking.serviceId && saved.date === booking.date && saved.time === booking.time;
        steps.push({ step: "verify_persisted", verdict: matches ? "passed" : "failed", detail: matches ? "Confirmed the matching booking in the database." : "The stored booking did not match the confirmation." });
        if (!matches) failedStep = "verify_persisted";
      }
    } catch {
      failedStep = "submit_booking";
      error = { code: "JOURNEY_INTERNAL_ERROR", message: "The booking journey could not complete.", step: "submit_booking", retryable: true };
      steps.push({ step: failedStep, verdict: "failed", detail: error.message });
    } finally {
      try {
        deletedBookings = await ctx.runMutation(internal.practice.app.cleanup, { appId, fixtureRunId: runId });
        steps.push({ step: "cleanup", verdict: "passed", detail: `Deleted ${deletedBookings} test booking${deletedBookings === 1 ? "" : "s"}.` });
      } catch {
        failedStep = "cleanup";
        error = { code: "CLEANUP_FAILED", message: "Test booking cleanup failed; this run is not a pass.", step: "cleanup", retryable: true };
        steps.push({ step: "cleanup", verdict: "failed", detail: error.message });
      }
    }
    return {
      runId,
      verdict: failedStep ? ("failed" as const) : ("passed" as const),
      failedStep,
      error,
      steps,
      cleanup: { ok: !steps.some((s) => s.step === "cleanup" && s.verdict === "failed"), deletedBookings },
      revision: PRACTICE_REVISION,
      environment: ENVIRONMENT,
      startedAt,
      completedAt: Date.now(),
      ...(scenario && { scenario }),
    };
  },
});
