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
} satisfies Record<string, Criterion>;

export const DONE_MEANS: Criterion[] = [CRITERIA.health, CRITERIA.journey, CRITERIA.device];

export const DEVICE_NOT_COVERED =
  "Not covered: no Revyl run of the booking screen on a device is wired up yet, so this was not checked.";

export const controlBase = () => process.env.PROTECTED_APP_URL?.replace(/\/+$/, "") || null;

export type CallResult =
  | { kind: "response"; status: number; body: unknown; durationMs: number }
  | { kind: "not_sent"; reason: string }
  | { kind: "no_response"; reason: string; durationMs: number };

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
    };
  } finally {
    clearTimeout(timer);
  }
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

export type JourneyOutcome =
  | { ok: true; httpStatus: number; result: JourneyResult }
  | { ok: false; reason: string };

// POST /journey-check: 200 means passed, 503 means failed; both carry the result.
export async function runJourneyCheck(config: { url: string; credentialRef?: string }, app: WatchedApp): Promise<JourneyOutcome> {
  const response = await call(config.url, {
    app,
    method: "POST",
    credentialRef: config.credentialRef,
    timeoutMs: 30_000,
  });
  if (response.kind !== "response") return { ok: false, reason: response.reason };
  const raw = response.body as Partial<JourneyResult> | null;
  if ((response.status !== 200 && response.status !== 503) || !raw || !raw.verdict) {
    return { ok: false, reason: `the booking check returned HTTP ${response.status} with no verdict` };
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

export function describeJourney(result: JourneyResult) {
  if (result.verdict === "passed") {
    return "The booking check passed: a test booking was saved and matched its confirmation.";
  }
  const code = result.error?.code ? ` (${result.error.code})` : "";
  return `The booking check failed at the "${result.failedStep ?? "unknown"}" step${code}, so no booking was saved.`;
}

export function journeyBody(result: JourneyResult) {
  const lines = result.steps.map((s) => `${s.step}: ${s.verdict}. ${s.detail}`);
  if (result.error) lines.push(`Error ${result.error.code}: ${result.error.message}`);
  lines.push(
    `Cleanup ${result.cleanup.ok ? "succeeded" : "failed"} (${result.cleanup.deletedBookings} test booking(s) deleted). Run ${result.runId} on revision ${result.revision}.`,
  );
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
