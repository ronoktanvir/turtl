import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { SecretKind } from "./schema";
import { open, sealingKey } from "./seal";

// Opens one secret inside the action that is about to send it. Nothing else decrypts, and what this returns is never
// stored, logged or handed to a client.

export type Opened =
  | { ok: true; value: string }
  /** missing: nothing is stored. unreadable: sealed with another key, or altered. no_key: SECRETS_ENCRYPTION_KEY is not set. */
  | { ok: false; why: "missing" | "unreadable" | "no_key" };

export type SecretScope = { appId: string } | { caseId: string } | { account: string };

export async function openSecret(ctx: Pick<ActionCtx, "runQuery">, kind: SecretKind, scope: SecretScope): Promise<Opened> {
  const row: { sealed: string; keyId: string; context: string } | null = await ctx.runQuery(internal.secrets.store.sealedFor, { kind, scope });
  if (!row) return { ok: false, why: "missing" };
  const key = await sealingKey();
  if (!key) return { ok: false, why: "no_key" };
  if (key.keyId !== row.keyId) return { ok: false, why: "unreadable" };
  const value = await open(row.sealed, row.context, key);
  return value === null ? { ok: false, why: "unreadable" } : { ok: true, value };
}
