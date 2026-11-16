import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import { errorMessage, liveClient, requireLiveClient } from "../live/client";
import type { PushBackend, PushStatus } from "./types";

async function readable<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw new Error(errorMessage(error)); }
}

// Watches the status without the app-wide error banner: a backend without convex/push answers null, and the
// notifications row stays hidden instead of showing an error on every screen.
function useStatus(token: string | undefined, ready: boolean): PushStatus | null | undefined {
  const key = ready ? token ?? "" : null;
  const [result, setResult] = useState<{ key: string | null; status: PushStatus | null | undefined }>({ key, status: undefined });
  useEffect(() => {
    if (key === null || !liveClient) return;
    const watch = liveClient.watchQuery(api.push.devices.status, key ? { token: key } : {});
    const read = () => {
      try { setResult({ key, status: watch.localQueryResult() }); } catch { setResult({ key, status: null }); }
    };
    const unsubscribe = watch.onUpdate(read);
    read();
    return unsubscribe;
  }, [key]);
  return result.key === key ? result.status : undefined;
}

export const liveBackend: PushBackend = {
  useStatus,
  register: async (token, platform) => { await readable(() => requireLiveClient().mutation(api.push.devices.register, { token, platform })); },
  refresh: async (token, platform, previousToken) => {
    await readable(() => requireLiveClient().mutation(api.push.devices.refresh, { token, platform, ...(previousToken ? { previousToken } : {}) }));
  },
  remove: async (token) => { await readable(() => requireLiveClient().mutation(api.push.devices.remove, { token })); },
};
