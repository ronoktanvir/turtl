import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { dark, light, type Tokens } from "./tokens";

export * from "./tokens";
export * from "./design";

export type ThemeMode = "system" | "dark" | "light";

type Theme = {
  colors: Tokens;
  scheme: "dark" | "light";
  mode: ThemeMode;
  setMode(mode: ThemeMode): void;
};

const ThemeContext = createContext<Theme>({ colors: dark, scheme: "dark", mode: "dark", setMode: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [mode, setMode] = useState<ThemeMode>("dark");
  const scheme = mode === "system" ? (system === "light" ? "light" : "dark") : mode;
  const value = useMemo(
    () => ({ colors: scheme === "dark" ? dark : light, scheme, mode, setMode }),
    [scheme, mode],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
