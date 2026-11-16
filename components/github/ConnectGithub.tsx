import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { beginGithubConnect, finishGithubConnect, refreshGithubRepositories, useGithubRepositories, useGithubStatus, type GithubRepository, type GithubReturn } from "../../data/github";
import { useTheme } from "../../theme";
import { BrandIcon, Card, Icon, T } from "../ui";
import { openForConnect, openOnGithub } from "./open";

const RETURNS: Record<Exclude<GithubReturn, "connected">, string> = {
  cancelled: "You cancelled on GitHub, so nothing was connected.",
  failed: "GitHub did not confirm who you are, so nothing was connected. Try again.",
  none: "GitHub shows no installation of turtl that you can reach, so nothing was connected. Install it on your account or organization, then try again.",
  requested: "GitHub asked your organization's owner to approve turtl. When they have, tap Connect GitHub again.",
};

const reason = (error: unknown) => (error instanceof Error ? error.message : "turtl could not reach GitHub. Try again.");
const repoUrlOf = (fullName: string) => `https://github.com/${fullName}`;

// The GitHub mark, unaltered and in the text color (black or white), on the one button that connects to GitHub.
export function ConnectButton({ label, onPress, disabled, testID }: { label: string; onPress: () => void; disabled?: boolean; testID: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
      style={({ pressed }) => ({ minHeight: 50, borderWidth: 1, borderColor: colors.border, borderRadius: 14, flexDirection: "row", gap: 10, justifyContent: "center", alignItems: "center", paddingHorizontal: 18, backgroundColor: pressed ? colors.surfaceRaised : colors.bg, opacity: disabled ? 0.65 : 1 })}
    >
      <BrandIcon name="github" size={20} />
      <T variant="strong">{label}</T>
    </Pressable>
  );
}

function TextLink({ label, onPress, testID, disabled }: { label: string; onPress: () => void; testID: string; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="link" accessibilityLabel={label} testID={testID} hitSlop={6} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, opacity: disabled ? 0.65 : 1 }}>
      <T variant="small" color="link" style={{ flexShrink: 1 }}>{label}</T>
      <Icon name="ExternalLink" size={14} color="link" />
    </Pressable>
  );
}

function RepositoryRow({ repository, selected, onPress, disabled }: { repository: GithubRepository; selected: boolean; onPress: () => void; disabled?: boolean }) {
  const { colors } = useTheme();
  const [owner, name] = repository.fullName.split("/");
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={repository.fullName + (repository.private ? ", private" : "")}
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      aria-checked={selected}
      testID={`github-repo-${repository.fullName}`}
      style={({ pressed }) => ({ minHeight: 56, borderRadius: 12, borderWidth: 1, borderColor: selected ? colors.brandDeep : colors.border, backgroundColor: selected || pressed ? colors.surfaceRaised : colors.surface, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12 })}
    >
      <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: selected ? colors.brandDeep : colors.textMuted, backgroundColor: selected ? colors.brandDeep : "transparent", alignItems: "center", justifyContent: "center" }}>
        {selected && <Icon name="Check" size={14} color="onBrand" strokeWidth={3} />}
      </View>
      <View style={{ flex: 1 }}>
        <T variant="strong" numberOfLines={1}>{name}</T>
        <T variant="small" color="textMuted" numberOfLines={1}>{owner}{repository.private ? " · Private" : ""}</T>
      </View>
    </Pressable>
  );
}

// Add project's GitHub section. With Connect GitHub set up on the backend it connects GitHub, then lists the repositories
// the owner chose there; picking one fills in the repository address. Without it, it draws nothing, so the screen is
// the typed address it always was.
export default function ConnectGithub({
  repoUrl,
  onPick,
  returned,
  onReturnHandled,
  disabled,
}: {
  repoUrl: string;
  onPick: (repoUrl: string) => void;
  /** github= and ticket= from the address GitHub's last redirect opened. */
  returned: { github?: string; ticket?: string };
  onReturnHandled: () => void;
  disabled?: boolean;
}) {
  const status = useGithubStatus();
  const ready = !!status?.configured && (!status.accounts || status.signedIn);
  const connected = ready && (status?.connections.length ?? 0) > 0;
  const repositories = useGithubRepositories(connected);
  const [phase, setPhase] = useState<"idle" | "opening" | "finishing" | "refreshing">("idle");
  const [note, setNote] = useState<{ text: string; problem: boolean } | null>(null);
  const handled = useRef<string | null>(null);
  const refreshed = useRef(false);

  const refresh = async () => {
    refreshed.current = true;
    setPhase((current) => (current === "idle" ? "refreshing" : current));
    try {
      const result = await refreshGithubRepositories();
      if (!result.ok) setNote({ text: "turtl could not read every repository from GitHub just now, so this list may be out of date.", problem: true });
    } catch (error) {
      setNote({ text: reason(error), problem: true });
    } finally {
      setPhase((current) => (current === "refreshing" ? "idle" : current));
    }
  };

  const finish = async (ticket: string) => {
    setPhase("finishing");
    setNote(null);
    try {
      // The picker that replaces the Connect card is the confirmation; nothing else needs saying.
      await finishGithubConnect(ticket);
      setPhase("idle");
      await refresh();
    } catch (error) {
      setNote({ text: reason(error), problem: true });
      setPhase("idle");
    } finally {
      onReturnHandled();
    }
  };

  // GitHub's last redirect opened this screen. A ticket is used once; the address forgets it straight away.
  useEffect(() => {
    if (!returned.github || !status) return;
    const key = `${returned.github}:${returned.ticket ?? ""}`;
    if (handled.current === key) return;
    handled.current = key;
    if (returned.github === "connected" && returned.ticket) void finish(returned.ticket);
    else {
      setNote({ text: RETURNS[returned.github as keyof typeof RETURNS] ?? RETURNS.failed, problem: true });
      onReturnHandled();
    }
  }, [returned.github, returned.ticket, status]);

  // The list comes from turtl's records at once and is read again from GitHub when the screen opens.
  useEffect(() => {
    if (connected && !refreshed.current && !returned.ticket) void refresh();
  }, [connected]);

  const connect = async (start: "install" | "authorize" = "install") => {
    setPhase("opening");
    setNote(null);
    try {
      await openForConnect(await beginGithubConnect(start));
    } catch (error) {
      setNote({ text: reason(error), problem: true });
    } finally {
      setPhase("idle");
    }
  };

  if (!status?.configured) return null;
  const busy = disabled || phase === "opening" || phase === "finishing";
  const message = note && (
    <T color={note.problem ? "statusAffected" : "text"} accessibilityRole={note.problem ? "alert" : undefined} accessibilityLiveRegion="polite" testID="github-connect-note">
      {note.text}
    </T>
  );
  if (status.accounts && !status.signedIn) {
    return <Card testID="github-connect-card"><T color="textMuted">Sign in to connect GitHub.</T></Card>;
  }

  if (!connected) {
    return (
      <View style={{ gap: 12 }}>
        <Card testID="github-connect-card" style={{ gap: 12 }}>
          <T variant="heading">Connect GitHub</T>
          <T color="textMuted">turtl reads only the repositories you choose. On GitHub, pick "Only select repositories", choose this app's repository, and come back here.</T>
          <ConnectButton label={phase === "opening" ? "Opening GitHub…" : phase === "finishing" ? "Finishing…" : "Connect GitHub"} disabled={busy} onPress={() => void connect()} testID="github-connect" />
          <TextLink label="Already installed? Confirm on GitHub" disabled={busy} onPress={() => void connect("authorize")} testID="github-confirm-existing" />
        </Card>
        {message}
      </View>
    );
  }

  const logins = [...new Set(status.connections.map((connection) => "@" + connection.githubLogin))].join(" and ");
  const selected = repoUrl.trim().replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  return (
    <View style={{ gap: 12 }}>
      <Card testID="github-picker" style={{ gap: 12 }}>
        <T variant="heading">Your repositories</T>
        <T color="textMuted" testID="github-connected-as">Connected to GitHub as {logins}. Choose this project's repository.</T>
        {repositories === undefined || (repositories.length === 0 && phase === "refreshing") ? (
          <T color="textMuted" testID="github-repos-loading">Reading your repositories from GitHub…</T>
        ) : repositories.length === 0 ? (
          <T color="textMuted" testID="github-repos-empty">turtl cannot reach any of your repositories yet. Choose some on GitHub, then come back.</T>
        ) : (
          <View accessibilityRole="radiogroup" accessibilityLabel="Your repositories" style={{ gap: 8 }}>
            {repositories.map((repository) => (
              <RepositoryRow key={repository.fullName} repository={repository} selected={selected === repoUrlOf(repository.fullName).toLowerCase()} disabled={disabled} onPress={() => onPick(repoUrlOf(repository.fullName))} />
            ))}
          </View>
        )}
        <View>
          {status.connections.map((connection) => (
            <TextLink
              key={connection.installationId}
              label={status.connections.length === 1 ? "Choose different repositories on GitHub" : `Choose repositories in ${connection.accountLogin} on GitHub`}
              onPress={() => void openOnGithub(connection.settingsUrl)}
              testID={`github-choose-${connection.installationId}`}
            />
          ))}
          <TextLink label="Add another account or organization" disabled={busy} onPress={() => void connect()} testID="github-connect-another" />
        </View>
      </Card>
      {message}
    </View>
  );
}
