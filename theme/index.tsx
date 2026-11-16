import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { readMode, writeMode } from "./storage";
import { dark, light, type Tokens } from "./tokens";

export * from "./tokens";
export * from "./design";

export type ThemeMode = "dark" | "light";

type Theme = {
  colors: Tokens;
  scheme: "dark" | "light";
  mode: ThemeMode;
  setMode(mode: ThemeMode): void;
};

const ThemeContext = createContext<Theme>({ colors: dark, scheme: "dark", mode: "dark", setMode: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Dark until the person chooses; their choice is kept across launches and reloads (./storage), read before the
  // first frame so the screen never flashes the other theme. The phone's own light or dark setting is not followed.
  const [mode, setChosen] = useState<ThemeMode>(() => readMode() ?? "dark");
  const setMode = useCallback((next: ThemeMode) => {
    setChosen(next);
    writeMode(next);
  }, []);
  const scheme = mode;
  const value = useMemo(
    () => ({ colors: scheme === "dark" ? dark : light, scheme, mode, setMode }),
    [scheme, mode, setMode],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
