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

export const HANDLERS: Record<Stage, StepHandler> = {
  detect_or_receive,
  gather_context,
  investigate,
  examine_broader_causes,
  plan,
  authorize_and_execute,
  verify,
  learn,
};
