import { useAction, useMutation } from "convex/react";
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
  | "liveClear"
  | "bookingRegister"
  | "bookingCheck"
  | "bookingStage"
  | "bookingClearStage"
  | "bookingStageStore"
  | "bookingClearStore";

type Proposal = { _id: Id<"proposals">; version: number; optionKey: string };

export function useDevActions() {
  const create = useMutation(api.dev.createSampleCases);
  const advance = useMutation(api.dev.advance);
  const autoRun = useMutation(api.dev.autoRun);
  const reset = useMutation(api.dev.resetSamples);
  const liveStart = useMutation(api.dev.startLiveRun);
  const liveApprove = useMutation(api.dev.approveLiveRun);
  const liveDecline = useMutation(api.dev.declineLiveRun);
  const liveClear = useMutation(api.dev.clearLiveRuns);
  const bookingRegister = useMutation(api.dev.registerBooking);
  const bookingCheck = useAction(api.dev.checkNow);
  const stageOutage = useAction(api.dev.stageOutage);
  const stageStoreFailure = useAction(api.dev.stageStoreFailure);
  const approve = useMutation(api.decisions.approve);
  const decline = useMutation(api.decisions.decline);
  const [error, setError] = useState<string | null>(null);

  const attempt = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dev action failed");
    }
  };

  const run = (action: Action, caseId?: Id<"cases">) =>
    attempt(async () => {
      if (action === "create") await create({});
      else if (action === "reset") await reset({});
      else if (action === "autoRun") await autoRun({});
      else if (action === "liveStart") await liveStart({});
      else if (action === "liveClear") await liveClear({});
      else if (action === "liveApprove" && caseId)
        await liveApprove({ caseId });
      else if (action === "liveDecline" && caseId)
        await liveDecline({ caseId });
      else if (action === "advance" && caseId) await advance({ caseId });
      else if (action === "bookingRegister") await bookingRegister({});
      else if (action === "bookingCheck") await bookingCheck({});
      else if (action === "bookingStage") await stageOutage({ on: true });
      else if (action === "bookingClearStage") await stageOutage({ on: false });
      else if (action === "bookingStageStore")
        await stageStoreFailure({ on: true });
      else if (action === "bookingClearStore")
        await stageStoreFailure({ on: false });
    });

  const decide = (decision: "approve" | "decline", proposal: Proposal) =>
    attempt(async () => {
      if (decision === "approve") {
        await approve({
          proposalId: proposal._id,
          version: proposal.version,
          optionKey: proposal.optionKey,
        });
      } else {
        await decline({ proposalId: proposal._id, version: proposal.version });
      }
    });

  return { run, decide, error };
}
