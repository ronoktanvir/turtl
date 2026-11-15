import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type Action = "create" | "advance" | "autoRun" | "reset";

export function useDevActions() {
  const create = useMutation(api.dev.createSampleCases);
  const advance = useMutation(api.dev.advance);
  const autoRun = useMutation(api.dev.autoRun);
  const reset = useMutation(api.dev.resetSamples);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: Action, caseId?: Id<"cases">) => {
    setError(null);
    try {
      if (action === "create") await create({});
      else if (action === "reset") await reset({});
      else if (action === "autoRun") await autoRun({});
      else if (caseId) await advance({ caseId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dev action failed");
    }
  };

  return { run, error };
}
