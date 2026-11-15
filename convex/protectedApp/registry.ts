import { internalMutation, type MutationCtx } from "../_generated/server";
import { SOLO_OWNER } from "../decisions";
import { CHECK_VERSION, CREDENTIAL_REF, controlBase } from "./client";

export const BOOKING_APP_NAME = "Still booking demo";
export const BOOKING_JOURNEY_NAME = "Book an appointment";
export const FLAG_ACTION_TYPE = "set_feature_flag";

// Registers the booking app, its booking journey, and its one catalog action. Running it again creates nothing new.
export async function registerBookingApp(ctx: MutationCtx) {
  const base = controlBase();
  if (!base) {
    throw new Error("PROTECTED_APP_URL is not set on this deployment, so the booking app cannot be registered.");
  }
  const existingApp = await ctx.db
    .query("apps")
    .filter((q) => q.eq(q.field("name"), BOOKING_APP_NAME))
    .first();
  const appId =
    existingApp?._id ??
    (await ctx.db.insert("apps", {
      name: BOOKING_APP_NAME,
      productionUrl: base,
      ownerId: SOLO_OWNER.identity,
    }));

  const existingJourney = (
    await ctx.db
      .query("journeys")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .collect()
  ).find((j) => j.name === BOOKING_JOURNEY_NAME);
  const journeyId =
    existingJourney?._id ??
    (await ctx.db.insert("journeys", {
      appId,
      name: BOOKING_JOURNEY_NAME,
      description:
        "A customer picks a service and a time and gets a confirmation backed by a saved booking. Checked on the server with POST /journey-check; the booking screen itself is not exercised.",
      check: {
        kind: "http",
        config: {
          url: `${base}/journey-check`,
          method: "POST",
          expectedStatus: 200,
          credentialRef: CREDENTIAL_REF,
        },
      },
      checkVersion: CHECK_VERSION,
    }));

  const existingEntry = await ctx.db
    .query("actionCatalog")
    .withIndex("by_app_and_type", (q) => q.eq("appId", appId).eq("type", FLAG_ACTION_TYPE))
    .first();
  const actionCatalogId =
    existingEntry?._id ??
    (await ctx.db.insert("actionCatalog", {
      appId,
      type: FLAG_ACTION_TYPE,
      name: "Turn off recommendations",
      description:
        "Sets the booking app's recommendationsEnabled flag to false, so booking stops waiting for suggested services. Reversible: set it back to true.",
      reversible: true,
      config: { kind: "http", url: `${base}/flags`, method: "POST", credentialRef: CREDENTIAL_REF },
      parameterConstraints: [
        { name: "flag", type: "string", required: true, allowedValues: ["recommendationsEnabled"] },
        { name: "value", type: "boolean", required: true, allowedValues: [false] },
      ],
    }));

  return {
    appId,
    journeyId,
    actionCatalogId,
    created: { app: !existingApp, journey: !existingJourney, catalogEntry: !existingEntry },
  };
}

export const register = internalMutation({
  args: {},
  handler: async (ctx) => registerBookingApp(ctx),
});
