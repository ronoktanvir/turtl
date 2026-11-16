import { serviceName, serviceOfHost, type Outbound } from "./services";

// The one place a request to an AI service leaves the backend, and the plain words a failed one turns into.
// Vendor helpers never call fetch themselves: gate.ts hands them sendTo(service) only after the owner's permission
// has been checked (tests/consent-gate.test.mjs fails if a bare fetch appears in them).

/** Thrown when the gate said no. Its message is a full sentence an owner can read. */
export class Refused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`);
    this.name = "Refused";
    this.reason = reason;
  }
}

/** A failed call to a vendor, in plain words. It never carries the vendor's own text, which can echo what was sent. */
export class VendorError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "VendorError";
    this.status = status;
  }
}

// An error type is a short code such as "invalid_request_error" or "rate_limit_exceeded". Anything else is dropped.
const ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_.-]{0,59}$/;

/** The vendor's error type from a failed response's body, and nothing else from it. */
export async function errorTypeOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { type?: unknown; code?: unknown } | unknown; type?: unknown; code?: unknown };
    const error = body && typeof body.error === "object" ? (body.error as { type?: unknown; code?: unknown }) : undefined;
    const type = [error?.type, error?.code, body?.type, body?.code].find((value) => typeof value === "string" && ERROR_TYPE.test(value));
    return type as string | undefined;
  } catch {
    return undefined;
  }
}

/** Logs a failed vendor call with its status and error type only, and returns the plain error to throw or store. */
export async function vendorFailure(vendor: string, response: Response): Promise<VendorError> {
  const type = await errorTypeOf(response);
  console.error(`${vendor} request failed: status ${response.status}${type ? `, ${type}` : ""}`);
  return new VendorError(`${vendor} answered with an error (status ${response.status})`, response.status);
}

/**
 * The plain words for any error thrown while asking a vendor and reading its answer: the gate's reason and our own
 * vendor errors as they are, anything else reduced to its kind, never its text.
 */
export function plainFailure(vendor: string, error: unknown): string {
  if (error instanceof Refused) return error.reason;
  if (error instanceof VendorError) return error.message;
  const status = typeof (error as { statusCode?: unknown })?.statusCode === "number" ? (error as { statusCode: number }).statusCode : undefined;
  if (status) return `${vendor} answered with an error (status ${status})`;
  return error instanceof SyntaxError ? `${vendor}'s answer could not be read` : `${vendor}'s answer could not be used`;
}

const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/**
 * The fetch for one service. A request addressed to another gated service's host is refused, so a permission for one
 * service can never carry data to another. Hosts no gated service names (a stand-in server, a custom Keiki address)
 * pass. Only gate.ts calls this, after the permission check.
 */
export function sendTo(service: Outbound): typeof fetch {
  return (input, init) => {
    const owner = serviceOfHost(urlOf(input).hostname);
    if (owner && owner !== service) {
      return Promise.reject(new Error(`A request for ${serviceName(service)} was addressed to ${serviceName(owner)}, so it was not sent.`));
    }
    return fetch(input, init);
  };
}
