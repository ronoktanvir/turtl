export type AppEnv = "development" | "preview" | "production";

export function resolveAppEnv(name: string | undefined): AppEnv {
  if (!name || name === "development") return "development";
  return name === "preview" ? "preview" : "production";
}

export function usesLiveData(url: string | undefined, source: string | undefined, env: AppEnv = "development"): boolean {
  return env !== "development" || (Boolean(url) && source !== "example");
}

export function allowsDevTools(env: AppEnv, dev: boolean, flag: string | undefined): boolean {
  return env === "development" && (dev || flag === "1");
}

export const appEnv = resolveAppEnv(process.env.EXPO_PUBLIC_APP_ENV);
export const isStoreBuild = appEnv !== "development";
export const isLiveData = usesLiveData(process.env.EXPO_PUBLIC_CONVEX_URL, process.env.EXPO_PUBLIC_DATA_SOURCE, appEnv);
export const devToolsAllowed = allowsDevTools(appEnv, typeof __DEV__ !== "undefined" && __DEV__, process.env.EXPO_PUBLIC_DEV_TOOLS);

/** Dev tools show only when the build allows them and the backend has not said accounts are on, since it then
 * refuses them all. While the backend's mode is still loading, or in the example build, the build decides. */
export function devToolsShown(allowed: boolean, mode: { accounts: boolean } | undefined): boolean {
  return allowed && mode?.accounts !== true;
}
