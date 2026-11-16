import { View } from "react-native";
import { useCodingAgent } from "../../data/secrets";
import { useTheme } from "../../theme";
import { Icon, T } from "../ui";

export const CODING_AGENT_NEEDED = "This needs your coding agent. Connect it first: in Settings (the gear), add your Capy API key under Coding agent.";

/** True only with accounts on, signed in, and no coding agent connected. */
export function useCodingAgentMissing(): boolean {
  const status = useCodingAgent();
  return !!status?.accounts && status.signedIn && !status.set;
}

// Shown where a step needs the owner's coding agent (a code-change option, preparing a project) and none is connected.
export function CodingAgentNotice({ testID }: { testID: string }) {
  const missing = useCodingAgentMissing();
  const { colors } = useTheme();
  if (!missing) return null;
  return (
    <View style={{ flexDirection: "row", gap: 10, padding: 14, borderRadius: 16, backgroundColor: colors.surfaceRaised }} testID={testID}>
      <Icon name="TriangleAlert" size={18} color="statusNeedsYou" />
      <T style={{ flex: 1 }}>{CODING_AGENT_NEEDED}</T>
    </View>
  );
}
