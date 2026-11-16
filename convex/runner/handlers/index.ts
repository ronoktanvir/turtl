import type { Stage } from "../../constants";
import type { StepHandler } from "../contract";
import { handler as authorize_and_execute } from "./authorize_and_execute";
import { handler as detect_or_receive } from "./detect_or_receive";
import { handler as examine_broader_causes } from "./examine_broader_causes";
import { handler as gather_context } from "./gather_context";
import { handler as investigate } from "./investigate";
import { handler as learn } from "./learn";
import { handler as plan } from "./plan";
import { handler as verify } from "./verify";
import { internal } from "../../_generated/api";
import { runExternal } from "../../externalApp/handlers";

const BOOKING_HANDLERS: Record<Stage, StepHandler> = {
  detect_or_receive,
  gather_context,
  investigate,
  examine_broader_causes,
  plan,
  authorize_and_execute,
  verify,
  learn,
};

export const HANDLERS = Object.fromEntries(Object.entries(BOOKING_HANDLERS).map(([stage, handler]) => [stage, {
  timeoutMs: handler.timeoutMs,
  run: async (ctx, input) => {
    const app = await ctx.runQuery(internal.externalApp.records.forApp, { appId: input.case.appId });
    if (app) {
      const result = await runExternal(ctx, input, app);
      if (result) return result;
    }
    return handler.run(ctx, input);
  },
} satisfies StepHandler])) as Record<Stage, StepHandler>;
