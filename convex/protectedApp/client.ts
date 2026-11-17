import type { Criterion, Revision } from "../constants";

declare const process: { env: Record<string, string | undefined> };

// The booking app's HTTP control contract (handoffs/protected-app-contract.md), read from turtl's side.
// Never read the staging switch here: `configuration` in a journey-check response is dropped below.

export const CREDENTIAL_REF = "PROTECTED_APP_CONTROL_SECRET";
// The only settings turtl will send to a watched app as its bearer token. A check's or an action's
// `credentialRef` is data: it is stored on a row and can come from a project's turtl.json. It must never choose
// which of this deployment's secrets leaves, so any other name is refused before a request is made.
// With accounts on, this one name means "the project's own control token" (convex/secrets) and never the
// deployment's variable of that name.
export const SENDABLE_CREDENTIAL_REFS: readonly string[] = [CREDENTIAL_REF];
export const ENVIRONMENT = "protected-app";
export const CHECK_VERSION = "journey-check-v1";
export const CRITERIA_VERSION = "booking-recovery-criteria-v1";
export const REQUEST_TIMEOUT_MS = 10_000;

export const CRITERIA = {
  health: {
    id: "health_responds",
    description: "The booking app's server answers its health check.",
  },
  journey: {
    id: "booking_journey_passes",
    description:
      "The server booking check passes: a test booking is saved and matches its confirmation.",
  },
  device: {
    id: "booking_screen_on_device",
    description: "A customer can book on the booking screen on a real device (a Revyl run).",
  },
  recommendationsOff: {
    id: "recommendations_off",
    description: "The booking app reports recommendations turned off.",
  },
  // Only a practice app (convex/practice) has a backup store.
  backupStoreOn: {
    id: "backup_store_on",
    description: "The booking app reports new bookings going to its backup store.",
  },
} satisfies Record<string, Criterion>;

export const DONE_MEANS: Criterion[] = [CRITERIA.health, CRITERIA.journey, CRITERIA.device];
/** A practice app (convex/practice) has no booking screen, so a device run is not part of what done means there. */
export const PRACTICE_DONE_MEANS: Criterion[] = [CRITERIA.health, CRITERIA.journey];

export const DEVICE_NOT_COVERED =
  "turtl does not check the booking screen on a real phone yet, so this part was not checked.";

export const controlBase = () => process.env.PROTECTED_APP_URL?.replace(/\/+$/, "") || null;

export type CallResult =
  | { kind: "response"; status: number; body: unknown; durationMs: number }
  | { kind: "not_sent"; reason: string }
  | { kind: "no_response"; reason: string; durationMs: number; timedOut: boolean };

export type TokenRead = { ok: true; token: string } | { ok: false; reason: string };

/**
 * The project a request is for, which decides where it may go and which token it carries. Every caller passes one:
 * build it with watchedApp (convex/protectedApp/watched.ts), which hands back DEMO_APP in the single-owner demo and,
 * with accounts on, the project's own rules: its live origin only, its own token only, no redirect followed.
 */
export interface WatchedApp {
  /** Why turtl will not send a request to this address for this project, as a fragment, or null when it may. */
  refuse(url: string): string | null;
  /** The bearer token behind credentialRef (already one of SENDABLE_CREDENTIAL_REFS), read in the action that sends it. */
  token(credentialRef: string): Promise<TokenRead>;
  /** False: a redirect is answered as it is, never followed, so a token never travels to another address. */
  followRedirects: boolean;
}

/**
 * The single-owner demo's one app, as before projects had tokens: any address, and the deployment's variable named by
 * credentialRef. Used only with accounts off (watchedApp) and by the demo's dev tools, which are closed with accounts on.
 */
export const DEMO_APP: WatchedApp = {
  refuse: () => null,
  token: async (credentialRef) => {
    const secret = process.env[credentialRef];
    return secret ? { ok: true, token: secret } : { ok: false, reason: `${credentialRef} is not set on this deployment` };
  },
  followRedirects: true,
};

export type CallOptions = {
  app: WatchedApp;
  method?: "GET" | "POST";
  body?: unknown;
  credentialRef?: string;
  timeoutMs?: number;
};

const isRedirect = (response: Response) => response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);

// One HTTP call for one project. The bearer token is read for that project and never returned.
export async function call(url: string, options: CallOptions = { app: DEMO_APP }): Promise<CallResult> {
  const { app = DEMO_APP, method = "GET", body, credentialRef, timeoutMs = REQUEST_TIMEOUT_MS } = options;
  const refused = app.refuse(url);
  if (refused) return { kind: "not_sent", reason: refused };
  const headers: Record<string, string> = {};
  if (credentialRef) {
    if (!SENDABLE_CREDENTIAL_REFS.includes(credentialRef)) {
      return { kind: "not_sent", reason: `turtl does not send the setting named ${credentialRef} to a watched app` };
    }
    const read = await app.token(credentialRef);
    if (!read.ok) return { kind: "not_sent", reason: read.reason };
    headers.Authorization = `Bearer ${read.token}`;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      ...(!app.followRedirects && { redirect: "manual" as const }),
    });
    if (!app.followRedirects && isRedirect(response)) {
      return { kind: "response", status: response.status || 302, body: null, durationMs: Date.now() - started };
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { kind: "response", status: response.status, body: parsed, durationMs: Date.now() - started };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      kind: "no_response",
      reason: timedOut
        ? `no response within ${timeoutMs / 1000} s`
        : `the request failed (${error instanceof Error ? error.name : "unknown error"})`,
      durationMs: Date.now() - started,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** turtl's own site, asked with no token: it refuses no address, sends nothing secret and follows no redirect. */
const OWN_SITE: WatchedApp = {
  refuse: () => null,
  token: async () => ({ ok: false, reason: "turtl sends no token to its own site" }),
  followRedirects: false,
};

/**
 * Whether turtl's own requests are getting out: one request to turtl's own site address (CONVEX_SITE_URL). No reply,
 * or a reply of 5xx or 429 (turtl's own site in trouble, or turned away), says no; any other reply, a 404 included,
 * says yes. True when no site address is set. Asked only before a not-answering case would open
 * (convex/protectedApp/notAnswering.ts), never on every round. A best-effort guard: whether such a request leaves
 * Convex's own network on a hosted deployment has not been examined.
 */
export async function turtlReachable(): Promise<boolean> {
  const site = process.env.CONVEX_SITE_URL?.replace(/\/+$/, "");
  if (!site) return true;
  const reply = await call(`${site}/`, { app: OWN_SITE, timeoutMs: REQUEST_TIMEOUT_MS });
  return reply.kind === "response" && reply.status < 500 && reply.status !== 429;
}

export const describeFailure = (result: CallResult) =>
  result.kind !== "response"
    ? result.reason
    : result.status >= 300 && result.status < 400
      ? `a redirect (HTTP ${result.status}), which turtl does not follow`
      : `HTTP ${result.status}`;

export type JourneyStep = { step: string; verdict: "passed" | "failed" | "skipped"; detail: string };

export type JourneyResult = {
  runId: string;
  verdict: "passed" | "failed";
  failedStep: string | null;
  error: { code: string; message: string; step?: string; provider?: string; retryable?: boolean } | null;
  steps: JourneyStep[];
  cleanup: { ok: boolean; deletedBookings: number };
  revision: string;
  environment: string;
  startedAt: number;
  completedAt: number;
};

/**
 * A check with no result says which of three things happened (convex/protectedApp/notAnswering.ts counts only the last
 * two, and only from the monitor's own rounds):
 * - not_sent: turtl refused to send it (an address rule, a credential rule, a missing token). The app was not asked.
 * - no_response: the request went out and nothing came back (timedOut: within the time limit; else the connection failed).
 * - no_result: a reply came back without a check result (anything but a 200 or 503 that carries a verdict).
 * `reason` is the same fragment as before, for the evidence and step summaries that quote it.
 */
export type JourneyOutcome =
  | { ok: true; httpStatus: number; result: JourneyResult }
  | { ok: false; kind: "not_sent"; reason: string }
  | { ok: false; kind: "no_response"; timedOut: boolean; reason: string }
  | { ok: false; kind: "no_result"; status: number; reason: string };

// POST /journey-check: 200 means passed, 503 means failed; both carry the result.
export async function runJourneyCheck(config: { url: string; credentialRef?: string }, app: WatchedApp): Promise<JourneyOutcome> {
  const response = await call(config.url, {
    app,
    method: "POST",
    credentialRef: config.credentialRef,
    timeoutMs: 30_000,
  });
  if (response.kind === "not_sent") return { ok: false, kind: "not_sent", reason: response.reason };
  if (response.kind === "no_response") return { ok: false, kind: "no_response", timedOut: response.timedOut === true, reason: response.reason };
  const raw = response.body as Partial<JourneyResult> | null;
  if ((response.status !== 200 && response.status !== 503) || !raw || !raw.verdict) {
    return { ok: false, kind: "no_result", status: response.status, reason: `the booking check returned HTTP ${response.status} with no verdict` };
  }
  return {
    ok: true,
    httpStatus: response.status,
    result: {
      runId: String(raw.runId),
      verdict: raw.verdict,
      failedStep: raw.failedStep ?? null,
      error: raw.error ?? null,
      steps: raw.steps ?? [],
      cleanup: raw.cleanup ?? { ok: false, deletedBookings: 0 },
      revision: String(raw.revision),
      environment: String(raw.environment),
      startedAt: Number(raw.startedAt),
      completedAt: Number(raw.completedAt),
    },
  };
}

/** The two probes a project's turtl.json can list beside its journey checks (convex/constants.ts, vProbe). */
export type Probe = "health" | "readiness";

/**
 * What a probe got. A probe is a GET with no body, and it is read the same way when a project's checks are registered
 * (convex/onboarding/prepare.ts) and each time the monitor sends it (convex/monitor.ts):
 * - passed: a 200. For a health check the server answers; for a readiness check the app says it can serve customers.
 * - not_ready: a readiness check only, a 503 with a JSON body: the app saying it is not ready to serve customers.
 * - no_result: any other reply (its HTTP status). 500 or above is quiet, like no response; below 500 it is one turtl
 *   cannot read (convex/protectedApp/notAnswering.ts, W1).
 * - no_response and not_sent: as for a journey check.
 * A probe never carries a verdict, so nothing here opens an ordinary case.
 */
export type ProbeOutcome =
  | { kind: "passed"; durationMs: number }
  | { kind: "not_ready"; reason: string }
  | { kind: "not_sent"; reason: string }
  | { kind: "no_response"; timedOut: boolean; reason: string }
  | { kind: "no_result"; status: number; reason: string };

export function readProbe(probe: Probe, response: CallResult): ProbeOutcome {
  if (response.kind === "not_sent") return { kind: "not_sent", reason: response.reason };
  if (response.kind === "no_response") return { kind: "no_response", timedOut: response.timedOut === true, reason: response.reason };
  if (response.status === 200) return { kind: "passed", durationMs: response.durationMs };
  if (probe === "readiness" && response.status === 503 && typeof response.body === "object" && response.body !== null) {
    return { kind: "not_ready", reason: "the app said it is not ready to serve customers (HTTP 503)" };
  }
  return { kind: "no_result", status: response.status, reason: `the ${probe} check returned ${describeFailure(response)}` };
}

// GET the health or readiness endpoint, with the project's token only when the check names it.
export async function runProbe(config: { url: string; credentialRef?: string; probe: Probe }, app: WatchedApp): Promise<ProbeOutcome> {
  return readProbe(config.probe, await call(config.url, { app, credentialRef: config.credentialRef }));
}

// The owner reads these two on the case. The error code is kept as a fact (journey.errorCode, gather_context), the
// revision on the evidence row, and the run id is the app's own record of its test booking, so none is written here.
export function describeJourney(result: JourneyResult) {
  if (result.verdict === "passed") {
    return "The booking check passed: a test booking was saved and matched its confirmation.";
  }
  return result.failedStep
    ? `The booking check failed at the "${result.failedStep.replace(/_/g, " ")}" step, so no booking was saved.`
    : "The booking check failed, so no booking was saved.";
}

export function journeyBody(result: JourneyResult) {
  const lines = result.steps.map((s) => `${s.step}: ${s.verdict}. ${s.detail}`);
  if (result.error) lines.push(`Error: ${result.error.message}`);
  const deleted = result.cleanup.deletedBookings;
  lines.push(`Cleanup ${result.cleanup.ok ? "succeeded" : "failed"} (${deleted} test ${deleted === 1 ? "booking" : "bookings"} deleted).`);
  return lines.join("\n");
}

export type ErrorsBody = {
  window: { since: number; until: number; truncated: boolean };
  counts: { totalBookings: number; failedBookings: number; successfulBookings: number; errorRate: number };
  errors: { code: string; step: string; timestamp: number }[];
};

export function topErrorCode(body: ErrorsBody) {
  const tally = new Map<string, number>();
  for (const error of body.errors ?? []) tally.set(error.code, (tally.get(error.code) ?? 0) + 1);
  let top = "none";
  let most = 0;
  for (const [code, count] of tally) {
    if (count > most) {
      top = code;
      most = count;
    }
  }
  return top;
}

export async function readErrors(base: string, app: WatchedApp) {
  const response = await call(`${base}/errors`, { app, credentialRef: CREDENTIAL_REF });
  if (response.kind !== "response" || response.status !== 200) {
    return { ok: false as const, reason: describeFailure(response) };
  }
  return { ok: true as const, body: response.body as ErrorsBody };
}

export async function readRevision(base: string, app: WatchedApp) {
  const response = await call(`${base}/revision`, { app });
  if (response.kind !== "response" || response.status !== 200) return null;
  const revision = (response.body as { revision?: unknown } | null)?.revision;
  return typeof revision === "string" ? revision : null;
}

// What exactly was tested: the booking app's commit when it reports one, and always the deployment it answered from.
export function revisionOf(revision: string | null, base: string): Revision {
  const deploymentId = new URL(base).host;
  if (revision && /^[0-9a-f]{7,40}$/i.test(revision)) return { commitSha: revision, deploymentId };
  return revision ? { buildId: revision, deploymentId } : { deploymentId };
}
