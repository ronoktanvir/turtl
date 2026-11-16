import { ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { isLiveData } from "../source";

const url = process.env.EXPO_PUBLIC_CONVEX_URL;
// Sign-in refusals (a wrong password, say) arrive in plain words and are shown on the screen, so they skip the
// console error the client would otherwise print for them. Everything else logs as before.
const signInRefusal = /^\[CONVEX A\(auth:signIn\)\][\s\S]*ConvexError/;
const logger = {
  logVerbose: () => {},
  log: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => {
    if (typeof args[0] !== "string" || !signInRefusal.test(args[0])) console.error(...args);
  },
};
// The example build (EXPO_PUBLIC_DATA_SOURCE=example, the public web demo) reads nothing from a backend, so it opens no
// connection, even when a backend address is set: otherwise every visitor's console fills with connection errors.
export const liveClient = url && isLiveData ? new ConvexReactClient(url, { unsavedChangesWarning: false, logger }) : null;

const states = new Map<string, { error?: string; loading: boolean }>();
const listeners = new Set<() => void>();
let snapshot: { errors: string[]; loading: boolean } = { errors: [], loading: false };

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "data" in error && typeof error.data === "string") return error.data;
  const text = error instanceof Error ? error.message : String(error);
  if (/Could not find (public )?function|Function .*not found|not a function/i.test(text)) {
    return "This backend has not been updated for this control yet. No example data was substituted.";
  }
  return text.replace(/\[CONVEX[^\]]*\]\s*/g, "").replace(/\[Request ID:[^\]]*\]\s*/g, "").replace(/Server Error\s*/g, "").replace(/Uncaught (Error|ConvexError):\s*/g, "").split(/\n\s+at |\n\s+Called by client/)[0].trim() || "The backend could not complete this request. Try again.";
}

function updateStatus(key: string, state?: { error?: string; loading: boolean }) {
  if (state) states.set(key, state);
  else states.delete(key);
  snapshot = {
    errors: [...new Set([...states.values()].flatMap((s) => s.error ? [s.error] : []))],
    loading: [...states.values()].some((s) => s.loading),
  };
  listeners.forEach((listener) => listener());
}

export function useDataStatus() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => snapshot,
    () => snapshot,
  );
}

export function useLiveQuery<Query extends FunctionReference<"query">>(query: Query, args: FunctionArgs<Query> | "skip"): FunctionReturnType<Query> | undefined {
  const name = getFunctionName(query);
  const key = JSON.stringify([name, args]);
  const stableArgs = useMemo(() => args, [key]);
  const [result, setResult] = useState<{ key: string; data: FunctionReturnType<Query> | undefined }>({ key, data: undefined });
  useEffect(() => {
    if (!isLiveData || !liveClient || stableArgs === "skip") return;
    const statusKey = `${key}:${Math.random()}`;
    const watch = liveClient.watchQuery(query, stableArgs);
    const read = () => {
      try {
        const data = watch.localQueryResult();
        setResult({ key, data });
        updateStatus(statusKey, { loading: data === undefined });
      } catch (error) {
        setResult({ key, data: undefined });
        updateStatus(statusKey, { loading: false, error: `${name}: ${errorMessage(error)}` });
      }
    };
    const unsubscribe = watch.onUpdate(read);
    read();
    const timer = setTimeout(() => {
      if (states.get(statusKey)?.loading) updateStatus(statusKey, { loading: false, error: "The backend is taking longer than expected. Check your connection; this view will update when it reconnects." });
    }, 15000);
    return () => { clearTimeout(timer); unsubscribe(); updateStatus(statusKey); };
  }, [key]);
  return stableArgs === "skip" || result.key !== key ? undefined : result.data;
}

export function requireLiveClient() {
  if (!liveClient) throw new Error("The backend URL is not configured.");
  return liveClient;
}
