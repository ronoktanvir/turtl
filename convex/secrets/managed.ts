import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { seal, type SealingKey } from "./seal";
import { contextOf } from "./store";

// A control token turtl makes itself, for an app it runs: a practice app (convex/practice). It is kept exactly like a
// token an owner enters (sealed, write-only, opened only in the action that sends it, deleted with the project), and the
// owner can neither replace nor remove it (store.ts and project.ts refuse), because the practice app answers only to it.

/** Seals the token and stores it as the project's control token. Only an action has the randomness sealing needs. */
export async function storeManagedControlToken(
  ctx: Pick<ActionCtx, "runMutation">,
  { account, appId, token, key }: { account: string; appId: Id<"apps">; token: string; key: SealingKey },
): Promise<{ setAt: number }> {
  const box = await seal(token, contextOf("control_token", appId), key);
  return await ctx.runMutation(internal.secrets.store.put, { kind: "control_token", account, appId, managed: true, ...box });
}
