import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ConnectGithub from "../components/github/ConnectGithub";
import PracticeStart from "../components/practice/PracticeStart";
import { Button, Header, Screen, T } from "../components/ui";
import { addProject } from "../data";
import { useTheme } from "../theme";

export default function AddProject() {
  const router = useRouter();
  // GitHub's last redirect after Connect GitHub opens this screen with github= and, when it worked, a one-time ticket=.
  const returned = useLocalSearchParams<{ github?: string; ticket?: string }>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [repoUrl, setRepoUrl] = useState("");
  const [liveUrl, setLiveUrl] = useState("");
  const [folders, setFolders] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const input = { color: colors.text, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border, borderRadius: 12, minHeight: 48, paddingHorizontal: 14, fontSize: 16, fontFamily: "Capriola_400Regular" };

  const submit = async () => {
    if (pending.current || !repoUrl.trim()) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const { projectId } = await addProject({
        repoUrl: repoUrl.trim(),
        liveUrl: liveUrl.trim() || undefined,
        folders: folders.split(",").map((folder) => folder.trim()).filter(Boolean),
      });
      router.replace(("/project/" + projectId + "/prepare") as Href);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "turtl could not add this project. Try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const fields = [
    { id: "add-project-repo", label: "GitHub repository", value: repoUrl, set: setRepoUrl, placeholder: "https://github.com/you/app", keyboard: "url" as const },
    { id: "add-project-live", label: "Live app URL (optional)", value: liveUrl, set: setLiveUrl, placeholder: "https://", keyboard: "url" as const },
    { id: "add-project-folders", label: "Folders (optional)", value: folders, set: setFolders, placeholder: "apps/mobile, packages/api", keyboard: "default" as const, hint: "For an app that shares its repository. Separate folders with commas." },
  ];

  return (
    <Screen testID="add-project">
      <Header title="Add project" fallback="/projects" testID="add-project-title" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 24, paddingBottom: insets.bottom + 40 }}>
          <T color="textMuted">turtl reads the repository, tells you what it found, and asks what must never break before it changes anything.</T>
          <ConnectGithub repoUrl={repoUrl} onPick={setRepoUrl} returned={{ github: returned.github, ticket: returned.ticket }} onReturnHandled={() => router.setParams({ github: undefined, ticket: undefined })} disabled={busy} />
          {fields.map((field) => (
            <View key={field.id} style={{ gap: 8 }}>
              <T variant="strong">{field.label}</T>
              <TextInput
                value={field.value}
                onChangeText={field.set}
                placeholder={field.placeholder}
                placeholderTextColor={colors.textMuted}
                accessibilityLabel={field.label}
                testID={field.id}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType={field.keyboard}
                editable={!busy}
                onSubmitEditing={() => void submit()}
                style={input}
              />
              {field.hint && <T variant="small" color="textMuted">{field.hint}</T>}
            </View>
          ))}
          {error && <T font="text" color="statusAffected" accessibilityRole="alert" testID="add-project-error">{error}</T>}
          <Button label={busy ? "Adding…" : "Add project"} icon="Plus" disabled={busy || !repoUrl.trim()} onPress={() => void submit()} testID="add-project-submit" />
          <PracticeStart testID="add-project-practice" card disabled={busy} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
