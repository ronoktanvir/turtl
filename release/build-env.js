const DEMO_DEPLOYMENT = "patient-kudu-956";

function resolveAppEnv(name) {
  if (!name || name === "development") return "development";
  return name === "preview" ? "preview" : "production";
}

function storeBuildProblems(env) {
  const named = env.EXPO_PUBLIC_APP_ENV;
  const appEnv = resolveAppEnv(named);
  const profile = env.EAS_BUILD_PROFILE;
  const problems = [];
  if ((profile === "preview" || profile === "production") && named !== profile) {
    problems.push(`The EAS "${profile}" profile must build with EXPO_PUBLIC_APP_ENV=${profile}; it is ${named ? `"${named}"` : "not set"}.`);
  }
  if (appEnv === "development") return problems;
  if (named !== appEnv) {
    problems.push(`EXPO_PUBLIC_APP_ENV is "${named}". Use development, preview, or production; any other name is locked down like production.`);
  }
  const url = env.EXPO_PUBLIC_CONVEX_URL;
  if (!url) {
    if (profile) problems.push(`EXPO_PUBLIC_CONVEX_URL is not set, so this ${appEnv} build would have no backend. Set it in the EAS "${appEnv}" environment.`);
  } else if (!URL.canParse(url) || new URL(url).protocol !== "https:") {
    problems.push("EXPO_PUBLIC_CONVEX_URL must be an https address.");
  } else if (appEnv === "production" && url.includes(DEMO_DEPLOYMENT)) {
    problems.push(`EXPO_PUBLIC_CONVEX_URL points at the demo backend (${DEMO_DEPLOYMENT}). A production build needs the production backend.`);
  }
  if (env.EXPO_PUBLIC_DATA_SOURCE === "example") {
    problems.push(`EXPO_PUBLIC_DATA_SOURCE=example is set. A ${appEnv} build never shows example data; remove it from this environment.`);
  }
  if (env.EXPO_PUBLIC_DEV_TOOLS === "1") {
    problems.push(`EXPO_PUBLIC_DEV_TOOLS=1 is set. A ${appEnv} build never shows the dev tools; remove it from this environment.`);
  }
  return problems;
}

module.exports = { DEMO_DEPLOYMENT, resolveAppEnv, storeBuildProblems };
