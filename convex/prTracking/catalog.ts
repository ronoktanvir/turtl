import { internalMutation, type MutationCtx } from "../_generated/server";
import { BOOKING_APP_NAME } from "../protectedApp/registry";
import { repoFromUrl } from "./github";

export const CODE_CHANGE_ACTION_TYPE = "open_pull_request";
export const CODE_CHANGE_REPO_URL = "https://github.com/ronoktanvir/turtl";
export const CODE_CHANGE_BASE_BRANCH = "main";

// Adds the booking app's code-change action: Capy writes the change and opens a pull request that only
// the owner's tap merges. Running it again creates nothing new.
export async function registerCodeChangeAction(ctx: MutationCtx) {
  const app = await ctx.db
    .query("apps")
    .filter((q) => q.eq(q.field("name"), BOOKING_APP_NAME))
    .first();
  if (!app) throw new Error(`Register "${BOOKING_APP_NAME}" first.`);
  if (app.repoUrl && repoFromUrl(app.repoUrl)?.toLowerCase() !== repoFromUrl(CODE_CHANGE_REPO_URL)?.toLowerCase()) {
    throw new Error(`The booking app already names a different repository (${app.repoUrl}); nothing was changed.`);
  }
  if (!app.repoUrl) await ctx.db.patch(app._id, { repoUrl: CODE_CHANGE_REPO_URL });
  const existing = await ctx.db
    .query("actionCatalog")
    .withIndex("by_app_and_type", (q) => q.eq("appId", app._id).eq("type", CODE_CHANGE_ACTION_TYPE))
    .first();
  if (existing) return { actionCatalogId: existing._id, created: false };
  const actionCatalogId = await ctx.db.insert("actionCatalog", {
    appId: app._id,
    type: CODE_CHANGE_ACTION_TYPE,
    name: "Change the code in a pull request",
    description:
      "Asks Capy to write the approved change on a new branch of ronoktanvir/turtl and open a pull request against main. Nothing merges until the owner taps Merge with checks passing. Reversible: close the pull request, or revert it after merging.",
    reversible: true,
    config: { kind: "capy", repoUrl: CODE_CHANGE_REPO_URL, baseBranch: CODE_CHANGE_BASE_BRANCH },
    parameterConstraints: [
      { name: "title", type: "string", required: true },
      { name: "change", type: "string", required: true },
    ],
  });
  return { actionCatalogId, created: true };
}

export const register = internalMutation({
  args: {},
  handler: async (ctx) => registerCodeChangeAction(ctx),
});
