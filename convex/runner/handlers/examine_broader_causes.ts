import { examineBroaderCauses, STEP_TIMEOUT_MS } from "../../structural/examine";
import type { StepHandler } from "../contract";

// Examines broader causes only when the case has related history; see convex/structural/README.md.
export const handler: StepHandler = {
  timeoutMs: STEP_TIMEOUT_MS,
  run: examineBroaderCauses,
};
