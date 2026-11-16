import { useState } from "react";
import { View } from "react-native";
import { disconnectGithub, useGithubStatus, type GithubConnection } from "../../data/github";
import { useTheme } from "../../theme";
import { Button, T } from "../ui";

const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

function Stops({ connections, accounts }: { connections: GithubConnection[]; accounts: boolean }) {
  const own = connections.filter((connection) => connection.scope === "all").map((connection) => connection.accountLogin);
  const shared = connections.filter((connection) => connection.scope === "chosen").map((connection) => connection.accountLogin);
  return (
    <View style={{ gap: 8 }}>
      <T>When you disconnect, turtl stops:</T>
      {["Reading your code to explain what broke and suggest fixes.", "Following and merging the pull requests for your fixes.", "Preparing projects you add, which reads and changes their repository."].map((line) => (
        <View key={line} style={{ flexDirection: "row", gap: 8 }}>
          <T color="textMuted">•</T>
          <T style={{ flex: 1 }}>{line}</T>
        </View>
      ))}
      {own.length > 0 && <T color="textMuted">turtl uninstalls its GitHub App from {list(own)}, so it keeps no access to those repositories.</T>}
      {shared.length > 0 && (
        <T color="textMuted">
          {accounts
            ? `In ${list(shared)}, turtl stops using GitHub for you. Its app stays installed there until an owner removes it on GitHub.`
            : `In ${list(shared)}, turtl stops using GitHub for you, and uninstalls its app there unless someone else still uses turtl with it.`}
        </T>
      )}
      <T color="textMuted">Your projects and cases stay in turtl. You can connect GitHub again from Add project.</T>
    </View>
  );
}

// The gear sheet's GitHub row: who is connected, and Disconnect, which first says what stops working. It draws
// nothing when the backend cannot connect GitHub, so the sheet is unchanged there.
export default function GithubSettings() {
  const status = useGithubStatus();
  const { colors } = useTheme();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; problem: boolean } | null>(null);
  if (!status?.configured || (status.accounts && !status.signedIn)) return null;
  const { connections } = status;
  const logins = list([...new Set(connections.map((connection) => "@" + connection.githubLogin))]);
  const accounts = list(connections.map((connection) => connection.accountLogin));

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await disconnectGithub(status.accounts);
      if (result.ok) {
        setConfirming(false);
        // Installations turtl left in place (an organization's) come with the backend's sentence saying who can remove them.
        const kept = (result.stillInstalled ?? []).map((entry) => entry.message);
        setMessage({ text: kept.length ? ["GitHub is disconnected.", ...kept].join(" ") : "GitHub is disconnected. turtl holds no access to your repositories.", problem: false });
      } else {
        const stuck = connections.filter((connection) => result.failed.some((failure) => failure.installationId === connection.installationId)).map((connection) => connection.accountLogin);
        setMessage({ text: `GitHub did not confirm removing turtl from ${list(stuck) || "your account"}, so turtl is still connected there. Try again, or uninstall turtl in GitHub's settings.`, problem: true });
      }
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "turtl could not disconnect GitHub. Try again.", problem: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 12 }} testID="github-settings">
      <T variant="heading">GitHub</T>
      {connections.length === 0 ? (
        <T color="textMuted" testID="github-settings-status">Not connected. Connect GitHub when you add a project.</T>
      ) : (
        <>
          <T testID="github-settings-status">Connected as {logins}. turtl reads the repositories you chose in {accounts}.</T>
          {!confirming ? (
            <Button label="Disconnect GitHub" kind="danger" disabled={busy} onPress={() => { setConfirming(true); setMessage(null); }} testID="github-disconnect" />
          ) : (
            <View style={{ gap: 12, borderWidth: 1, borderColor: colors.statusAffected, borderRadius: 16, padding: 16 }} testID="github-disconnect-confirm">
              <T variant="strong">Disconnect GitHub?</T>
              <Stops connections={connections} accounts={status.accounts} />
              <Button label={busy ? "Disconnecting…" : "Disconnect"} kind="danger" disabled={busy} onPress={() => void disconnect()} testID="github-disconnect-confirm-button" />
              <Button label="Keep connected" kind="plain" disabled={busy} onPress={() => setConfirming(false)} testID="github-disconnect-cancel" />
            </View>
          )}
        </>
      )}
      {message && (
        <T color={message.problem ? "statusAffected" : "text"} accessibilityRole={message.problem ? "alert" : undefined} testID="github-settings-message">
          {message.text}
        </T>
      )}
    </View>
  );
}
