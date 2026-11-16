import { useRouter, type Href } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { breakPractice, FAILURE_WORDS, mendPractice, type PracticeFailure, type PracticeProject } from "../../data/practice";
import { useTheme } from "../../theme";
import { Button, Icon, Sheet, T } from "../ui";

// What the practice tile opens: the confirmation for breaking the practice app on purpose (which failure, and exactly
// what happens next), where turtl is with an issue it opened, or the way to put a practice app back that turtl did not
// fix. Nothing here changes anything until its last button is pressed.

const ORDER: PracticeFailure[] = ["recommendations", "booking_store"];
const NOTICE_MS = 3 * 60_000;

function Choice({ failure, selected, onPress }: { failure: PracticeFailure; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const words = FAILURE_WORDS[failure];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      aria-checked={selected}
      accessibilityState={{ checked: selected }}
      accessibilityLabel={words.title + ". " + words.what}
      testID={"practice-choice-" + failure}
      style={({ pressed }) => ({ flexDirection: "row", gap: 12, minHeight: 64, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: selected ? colors.statusAffected : colors.border, backgroundColor: pressed ? colors.surfaceRaised : selected ? colors.surfaceRaised : colors.surface })}
    >
      <View style={{ width: 22, height: 22, marginTop: 2, borderRadius: 11, borderWidth: 2, borderColor: selected ? colors.statusAffected : colors.textMuted, alignItems: "center", justifyContent: "center" }}>
        {selected && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.statusAffected }} />}
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <T variant="strong">{words.title}</T>
        <T variant="small" color="textMuted">{words.what}</T>
      </View>
    </Pressable>
  );
}

function Step({ index, text }: { index: number; text: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 12 }}>
      <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" }}>
        <T variant="small" color="textMuted">{index}</T>
      </View>
      <T style={{ flex: 1 }}>{text}</T>
    </View>
  );
}

// Where turtl is with the issue it opened, said truly at each stage, and the one way to it that fits.
export const STAGE_WORDS: Record<NonNullable<PracticeProject["caseStage"]>, { title: string; line: string; button: string; enacting: boolean }> = {
  working: {
    title: "turtl is working it out",
    line: "turtl's check noticed and opened an issue under Fix. It is finding out what broke and which fixes would work. It changes nothing until you approve one.",
    button: "Open the issue",
    enacting: false,
  },
  waiting: {
    title: "A fix is waiting for you",
    line: "turtl found what broke and has a fix ready. Nothing changes until you approve it.",
    button: "Look at the fix",
    enacting: false,
  },
  carrying_out: {
    title: "turtl is carrying out the fix",
    line: "You approved a fix. turtl is making the change, then it runs the booking check again to show it worked.",
    button: "Watch it",
    enacting: true,
  },
  not_answering: {
    title: "Your practice app is not answering",
    line: "turtl's checks get no answer from it, so turtl cannot work out a fix. It keeps checking and closes the issue when the app answers.",
    button: "Open the issue",
    enacting: false,
  },
};

/** When today's breaks start again, in the person's own time: "at 4:00 PM", or "tomorrow at 1:00 AM". */
export function resetWords(resetAt: number, now = Date.now()): string {
  const at = new Date(resetAt);
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === new Date(now).toDateString() ? `at ${time}` : `tomorrow at ${time}`;
}

const timesLeft = (left: number) => (left === 1 ? "You can break it once more today." : `You can break it ${left} more times today.`);

export default function PracticeSheet({ visible, onClose, project }: { visible: boolean; onClose: () => void; project: PracticeProject }) {
  const router = useRouter();
  const { colors } = useTheme();
  const [failure, setFailure] = useState<PracticeFailure>("recommendations");
  const [mending, setMending] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) {
      setMending(false);
      setError(null);
    }
  }, [visible]);

  const run = async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work. Try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const problem = error && <T font="text" color="statusAffected" accessibilityRole="alert" testID="practice-sheet-error">{error}</T>;

  // turtl has an issue open on it: say where it is, and lead to it (to the fix itself when one is waiting).
  if (project.failure && project.caseId) {
    const caseId = project.caseId;
    const stage = STAGE_WORDS[project.caseStage ?? "working"];
    return (
      <Sheet visible={visible} onClose={onClose} title={stage.title} testID="practice-sheet" footer={<View style={{ gap: 10 }}>
        <Button label={stage.button} onPress={() => { onClose(); router.push(("/review/" + caseId + (stage.enacting ? "/enacting" : project.caseStage === "waiting" ? "?part=fixes" : "")) as Href); }} testID="practice-open-issue" />
        <Button label="Close" kind="plain" onPress={onClose} testID="practice-sheet-close" />
      </View>}>
        <T testID="practice-stage">{`${FAILURE_WORDS[project.failure].title}. ${stage.line}`}</T>
      </Sheet>
    );
  }

  // Broken, and no issue is open: turtl has not noticed yet, or its fixes were declined.
  if (project.failure) {
    const recent = !project.stalled && project.brokenAt !== undefined && Date.now() - project.brokenAt < NOTICE_MS;
    const id = project.projectId;
    return (
      <Sheet visible={visible} onClose={onClose} title={mending ? "Put it back?" : "Your practice app is broken"} testID="practice-sheet" footer={<View style={{ gap: 10 }}>
        {mending ? (
          <>
            <Button label={busy ? "Putting it back…" : "Put it back"} disabled={busy} onPress={() => void run(() => mendPractice(id))} testID="practice-mend-confirm" />
            <Button label="Leave it broken" kind="plain" disabled={busy} onPress={() => setMending(false)} testID="practice-mend-cancel" />
          </>
        ) : (
          <>
            <Button label="Put it back" kind="outline" onPress={() => setMending(true)} testID="practice-mend" />
            <Button label="Close" kind="plain" onPress={onClose} testID="practice-sheet-close" />
          </>
        )}
      </View>}>
        {mending ? (
          <T>turtl switches off the failure you chose, so bookings save again. Nothing else changes, and turtl's next check sees it working.</T>
        ) : (
          <>
            <T>{FAILURE_WORDS[project.failure].what}</T>
            <T color="textMuted">{recent ? "turtl's regular check notices within a minute or two and opens an issue under Fix." : "No issue is open on it: turtl's fixes were declined, or the issue ended without a fix. turtl opens no new issue until it works again, so put it back yourself."}</T>
          </>
        )}
        {problem}
      </Sheet>
    );
  }

  // It works: the confirmation for breaking it. At the day's limit it says so first, with when it resets, and offers no
  // choice that cannot be used.
  const out = project.breaksLeft <= 0;
  if (out) {
    return (
      <Sheet visible={visible} onClose={onClose} title="That's all for today" testID="practice-sheet" footer={<Button label="Close" kind="plain" onPress={onClose} testID="practice-break-cancel" />}>
        <T testID="practice-breaks-left">{`You have broken your practice app as often as one day allows. You can break it again ${project.breaksResetAt ? resetWords(project.breaksResetAt) : "tomorrow"}.`}</T>
        <T color="textMuted">It works now. Your issues and their fixes stay under Fix, to read again.</T>
        {project.note && <T font="text" color="textMuted" testID="practice-note">{project.note}</T>}
      </Sheet>
    );
  }
  return (
    <Sheet visible={visible} onClose={onClose} title="Break your practice app?" testID="practice-sheet" footer={<View style={{ gap: 10 }}>
      <Button label={busy ? "Breaking it…" : "Break it"} kind="danger" icon="Zap" disabled={busy} onPress={() => void run(() => breakPractice(project.projectId, failure))} testID="practice-break-confirm" />
      <Button label="Keep it working" kind="plain" disabled={busy} onPress={onClose} testID="practice-break-cancel" />
    </View>}>
      <T>Only your practice app breaks. No real customer and no other app is affected.</T>
      <View accessibilityRole="radiogroup" accessibilityLabel="What goes wrong" style={{ gap: 10 }}>
        {ORDER.map((option) => <Choice key={option} failure={option} selected={failure === option} onPress={() => setFailure(option)} />)}
      </View>
      <View style={{ gap: 12 }}>
        <T variant="heading">What happens next</T>
        <Step index={1} text="Your practice app fails at once, the way you chose." />
        <Step index={2} text="Within a minute or two, turtl notices and opens an issue under Fix." />
        <Step index={3} text="turtl offers a fix and changes nothing until you approve it. Then it runs the booking check again." />
      </View>
      {project.note && <View style={{ flexDirection: "row", gap: 10, padding: 14, borderRadius: 16, backgroundColor: colors.surfaceRaised }}>
        <Icon name="Info" size={18} color="textMuted" />
        <T font="text" style={{ flex: 1 }} testID="practice-note">{project.note + " Breaking it again switches that back first."}</T>
      </View>}
      <T variant="small" color="textMuted" testID="practice-breaks-left">{timesLeft(project.breaksLeft)}</T>
      {problem}
    </Sheet>
  );
}
