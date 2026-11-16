import React from "react";
import { createRoot } from "react-dom/client";
import { View } from "react-native";
import { WorkflowGraph } from "../../components/execution/WorkflowGraph";
import { ThemeProvider, useTheme } from "../../theme";
import { mapWorkflow } from "../../data/live/workflowMapping";
import { recordedWorkflow } from "./workflow-recorded";

function Fixture() {
  const { colors, mode, setMode } = useTheme();
  const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "running";
  return <View style={{ padding: 20, gap: 20, backgroundColor: colors.bg, minHeight: "100%" }}>
    <div style={{ color: colors.text, fontFamily: "Capriola_400Regular", fontSize: 16 }}>Local recorded-data fixture — no live collector ran.</div>
    <button style={{ minHeight: 44 }} onClick={() => setMode(mode === "dark" ? "light" : "dark")}>Switch theme</button>
    <WorkflowGraph workflow={mapWorkflow(recordedWorkflow(scenario))} />
  </View>;
}

createRoot(document.getElementById("root")).render(<ThemeProvider><Fixture /></ThemeProvider>);
