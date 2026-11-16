import type { ConfigContext, ExpoConfig } from "expo/config";
import { storeBuildProblems } from "./release/build-env";

export default ({ config }: ConfigContext): ExpoConfig => {
  const problems = storeBuildProblems(process.env);
  if (problems.length) throw new Error(`turtl cannot be built with this environment (see release/README.md):\n- ${problems.join("\n- ")}`);
  return {
    ...config,
    name: config.name ?? "turtl",
    slug: config.slug ?? "turtl",
    plugins: [
      ...(config.plugins ?? []),
      ["expo-secure-store", { faceIDPermission: false }],
      ["expo-audio", { microphonePermission: "turtl listens when you tap Talk, so you can ask about a case out loud. Recordings are transcribed and not kept.", enableBackgroundPlayback: false }],
    ],
    ...(process.env.TURTL_PREVIEW_ORIGIN
      ? { extra: { ...config.extra, router: { ...config.extra?.router, origin: process.env.TURTL_PREVIEW_ORIGIN } } }
      : {}),
  };
};
