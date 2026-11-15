import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type Action =
  | "create"
  | "advance"
  | "autoRun"
  | "reset"
  | "liveStart"
  | "liveApprove"
  | "liveDecline"
  | "liveClear";

export function useDevActions() {
  const create = useMutation(api.dev.createSampleCases);
  const advance = useMutation(api.dev.advance);
  const autoRun = useMutation(api.dev.autoRun);
  const reset = useMutation(api.dev.resetSamples);
  const liveStart = useMutation(api.dev.startLiveRun);
  const liveApprove = useMutation(api.dev.approveLiveRun);
  const liveDecline = useMutation(api.dev.declineLiveRun);
  const liveClear = useMutation(api.dev.clearLiveRuns);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: Action, caseId?: Id<"cases">) => {
    setError(null);
    try {
      if (action === "create") await create({});
      else if (action === "reset") await reset({});
      else if (action === "autoRun") await autoRun({});
      else if (action === "liveStart") await liveStart({});
      else if (action === "liveClear") await liveClear({});
      else if (action === "liveApprove" && caseId) await liveApprove({ caseId });
      else if (action === "liveDecline" && caseId) await liveDecline({ caseId });
      else if (action === "advance" && caseId) await advance({ caseId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dev action failed");
    }
  };

  return { run, error };
}
