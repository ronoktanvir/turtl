import type { FunctionReference, FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import { errorMessage, liveClient, requireLiveClient } from "../live/client";
import type { AiConsentData, AiPermission, AiSpend } from "./types";

// Watches without reporting to the app's error bar: a backend that has no permission functions yet (an older
// deployment) answers with an error, and the app then simply shows nothing, as before.
function useQuietQuery<Query extends FunctionReference<"query">>(query: Query): FunctionReturnType<Query> | null | undefined {
  const [data, setData] = useState<FunctionReturnType<Query> | null | undefined>(undefined);
  useEffect(() => {
    if (!liveClient) {
      setData(null);
      return;
    }
    const watch = liveClient.watchQuery(query, {});
    const read = () => {
      try {
        setData(watch.localQueryResult());
      } catch {
        setData(null);
      }
    };
    const unsubscribe = watch.onUpdate(read);
    read();
    return unsubscribe;
  }, [query]);
  return data;
}

async function readable(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    throw new Error(errorMessage(error));
  }
}

export const live: AiConsentData = {
  useAiPermission: () => useQuietQuery(api.consent.permission.status) as AiPermission | null | undefined,
  useAiSpend: () => useQuietQuery(api.spend.status.mine) as AiSpend | null | undefined,
  allowAi: (listVersion) => readable(() => requireLiveClient().mutation(api.consent.permission.allow, { listVersion })),
  declineAi: (listVersion) => readable(() => requireLiveClient().mutation(api.consent.permission.decline, { listVersion })),
  withdrawAi: () => readable(() => requireLiveClient().mutation(api.consent.permission.withdraw, {})),
};
