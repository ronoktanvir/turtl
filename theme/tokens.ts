import type { Health } from "../data/types";

export const dark = {
  bg: "#0A0A0A",
  surface: "#151515",
  surfaceRaised: "#202020",
  border: "#303030",
  text: "#edf2ef",
  textMuted: "#a0adaf",
  link: "#539bf5",
  statusAffected: "#e5534b",
  statusNeedsYou: "#c69026",
  statusWorking: "#539bf5",
  statusClear: "#81a56f",
  statusNew: "#ed9b48",
  statusReview: "#e3c865",
  brand: "#def1c9",
  brandDeep: "#81a56f",
  onBrand: "#1c2128",
  codeAddBg: "#1b4721",
  codeDelBg: "#5d0f12",
  // The case screen's Overview, Logs and Code tabs, each in its own colour when selected (label, icon and underline).
  tabOverview: "#81a56f",
  tabLogs: "#b392f0",
  tabCode: "#7dd3fc",
};

export type TokenName = keyof typeof dark;
export type Tokens = Record<TokenName, string>;

export const light: Tokens = {
  bg: "#f7f8f4",
  surface: "#ffffff",
  surfaceRaised: "#edf1eb",
  border: "#dce3da",
  text: "#1f2328",
  textMuted: "#656d76",
  link: "#0969da",
  statusAffected: "#cf222e",
  statusNeedsYou: "#9a6700",
  statusWorking: "#0969da",
  statusClear: "#557a45",
  statusNew: "#b85c13",
  statusReview: "#8b730e",
  brand: "#def1c9",
  brandDeep: "#6e9a5c",
  onBrand: "#1c2128",
  codeAddBg: "#dafbe1",
  codeDelBg: "#ffebe9",
  // Darker than the dark theme's, so each reads at 4.5:1 or more against the light background.
  tabOverview: "#557a45",
  tabLogs: "#7c3aed",
  tabCode: "#0369a1",
};

export const healthOrder: Health[] = ["affected", "needs_you", "working", "clear"];

export const healthToken: Record<Health, TokenName> = {
  affected: "statusAffected",
  needs_you: "statusNeedsYou",
  working: "statusWorking",
  clear: "statusClear",
};

export const healthWord: Record<Health, string> = {
  affected: "Users affected",
  needs_you: "Needs you",
  working: "turtl is working",
  clear: "All clear",
};

export function worstHealth(healths: Health[]): Health {
  return healthOrder.find((h) => healths.includes(h)) ?? "clear";
}
