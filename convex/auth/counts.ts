import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

// The running counts behind the limits per email domain and on the day's emails (authCounts, convex/auth/schema.ts).
// One row per name, key and UTC window; a key is a hash of a domain, or "" for the whole deployment.

export type CountName = Doc<"authCounts">["name"];
export const DEPLOYMENT = "";

export const hourWindow = (at: number) => new Date(at).toISOString().slice(0, 13);
export const dayWindow = (at: number) => new Date(at).toISOString().slice(0, 10);

/** What a count is filed under for a domain: a hash of it, never the domain. */
export async function domainKey(domain: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("turtl-email-domain:" + domain));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const rowOf = (ctx: Pick<QueryCtx, "db">, name: CountName, key: string, window: string) =>
  ctx.db.query("authCounts").withIndex("by_name_key_and_window", (q) => q.eq("name", name).eq("key", key).eq("window", window)).unique();

export async function countOf(ctx: Pick<QueryCtx, "db">, name: CountName, key: string, window: string): Promise<number> {
  return (await rowOf(ctx, name, key, window))?.value ?? 0;
}

export async function bump(ctx: Pick<MutationCtx, "db">, name: CountName, key: string, window: string): Promise<void> {
  const row = await rowOf(ctx, name, key, window);
  if (row) await ctx.db.patch(row._id, { value: row.value + 1 });
  else await ctx.db.insert("authCounts", { name, key, window, value: 1 });
}

/** Takes one back, as for an email that could not be sent. */
export async function unbump(ctx: Pick<MutationCtx, "db">, name: CountName, key: string, window: string): Promise<void> {
  const row = await rowOf(ctx, name, key, window);
  if (row && row.value > 1) await ctx.db.patch(row._id, { value: row.value - 1 });
  else if (row) await ctx.db.delete(row._id);
}

/** Deletes counts of days before today, a batch at a time (the hourly sweep in convex/auth/codes.ts). */
export async function pruneCounts(ctx: Pick<MutationCtx, "db">, now: number, batch: number): Promise<number> {
  const old = await ctx.db.query("authCounts").withIndex("by_window", (q) => q.lt("window", dayWindow(now))).take(batch);
  for (const row of old) await ctx.db.delete(row._id);
  return old.length;
}
