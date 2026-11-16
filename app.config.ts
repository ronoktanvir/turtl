import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? "turtl",
  slug: config.slug ?? "turtl",
  plugins: [...(config.plugins ?? []), "expo-secure-store"],
  ...(process.env.TURTL_PREVIEW_ORIGIN
    ? { extra: { ...config.extra, router: { ...config.extra?.router, origin: process.env.TURTL_PREVIEW_ORIGIN } } }
    : {}),
});
