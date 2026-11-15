import { useQuery } from "convex/react";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../convex/_generated/api";
import { CASE_STATUSES, CLOSED_CASE_STATUSES } from "../../convex/constants";
import { useDevActions } from "./useDevActions";

const clientEnabled = __DEV__ || process.env.EXPO_PUBLIC_DEV_TOOLS === "1";

export function DevTools() {
  if (!clientEnabled) return null;
  return <DevToolsOverlay />;
}

function DevToolsOverlay() {
  const status = useQuery(api.dev.status);
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const { run, decide, error } = useDevActions();

  if (!status?.enabled) return null;

  const unfinished = status.cases.find(
    (c) => !(CLOSED_CASE_STATUSES as readonly string[]).includes(c.case.status),
  );
  const totalSteps = status.cases.reduce((n, c) => n + c.steps.length, 0);
  const doneSteps = status.cases.reduce(
    (n, c) =>
      n +
      c.steps.filter((s) => s.status === "done" || s.status === "skipped")
        .length,
    0,
  );
  const resolvedCases = status.cases.filter(
    (c) => c.case.status === "resolved",
  ).length;
  const progress = status.cases.length
    ? `${doneSteps} of ${totalSteps} steps done · ${resolvedCases} of ${status.cases.length} cases resolved`
    : "No sample cases";

  const live = status.live ?? [];
  const latestLive = live[0]?.case;
  const waitingLive = live.find(
    (c) => c.case.status === "waiting_for_owner",
  )?.case;
  const liveLabel = latestLive
    ? `Live run: ${CASE_STATUSES.find((s) => s.id === latestLive.status)?.label ?? latestLive.status}`
    : "No live runs";

  const booking = status.booking ?? null;
  const bookingLabel = !booking
    ? "Booking app: not registered"
    : booking.case
      ? `Booking app: ${CASE_STATUSES.find((s) => s.id === booking.case?.status)?.label ?? booking.case.status}`
      : "Booking app: no case";
  const pending = booking?.proposal ?? null;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.layer, { paddingBottom: insets.bottom + 8 }]}
    >
      {open && (
        <View style={styles.panel}>
          <Text style={styles.progress}>{progress}</Text>
          {error && <Text style={styles.error}>{error}</Text>}
          <DevButton
            testID="dev-new-sample"
            label="New sample cases"
            onPress={() => run("create")}
          />
          <DevButton
            testID="dev-advance"
            label="Advance"
            disabled={!unfinished}
            onPress={() => unfinished && run("advance", unfinished.case._id)}
          />
          <DevButton
            testID="dev-auto-run"
            label="Auto-run"
            disabled={!unfinished}
            onPress={() => run("autoRun")}
          />
          <DevButton
            testID="dev-reset"
            label="Reset samples"
            onPress={() => run("reset")}
          />
          <View style={styles.section}>
            <Text style={styles.progress} testID="dev-live-status">
              {liveLabel}
            </Text>
            <DevButton
              testID="dev-live-start"
              label="Start live run"
              onPress={() => run("liveStart")}
            />
            <DevButton
              testID="dev-live-approve"
              label="Approve"
              disabled={!waitingLive}
              onPress={() => waitingLive && run("liveApprove", waitingLive._id)}
            />
            <DevButton
              testID="dev-live-decline"
              label="Decline"
              disabled={!waitingLive}
              onPress={() => waitingLive && run("liveDecline", waitingLive._id)}
            />
            <DevButton
              testID="dev-live-clear"
              label="Clear live runs"
              disabled={!latestLive}
              onPress={() => run("liveClear")}
            />
          </View>
          <View style={styles.section}>
            <Text style={styles.progress} testID="dev-booking-status">
              {bookingLabel}
            </Text>
            <DevButton
              testID="dev-booking-register"
              label="Register booking app"
              onPress={() => run("bookingRegister")}
            />
            <DevButton
              testID="dev-booking-check"
              label="Check now"
              disabled={!booking}
              onPress={() => run("bookingCheck")}
            />
            <DevButton
              testID="dev-booking-stage"
              label="Stage outage (staged)"
              onPress={() => run("bookingStage")}
            />
            <DevButton
              testID="dev-booking-clear-stage"
              label="Clear staged outage"
              onPress={() => run("bookingClearStage")}
            />
            <DevButton
              testID="dev-booking-stage-store"
              label="Stage store failure (staged)"
              onPress={() => run("bookingStageStore")}
            />
            <DevButton
              testID="dev-booking-clear-store"
              label="Clear staged store failure"
              onPress={() => run("bookingClearStore")}
            />
            <DevButton
              testID="dev-booking-approve"
              label="Approve proposal"
              disabled={
                !pending || booking?.case?.status !== "waiting_for_owner"
              }
              onPress={() => pending && decide("approve", pending)}
            />
            <DevButton
              testID="dev-booking-decline"
              label="Decline proposal"
              disabled={
                !pending || booking?.case?.status !== "waiting_for_owner"
              }
              onPress={() => pending && decide("decline", pending)}
            />
          </View>
        </View>
      )}
      <Pressable
        testID="dev-tools-toggle"
        accessibilityRole="button"
        accessibilityLabel="Dev tools"
        onPress={() => setOpen((value) => !value)}
        style={styles.pill}
      >
        <Text style={styles.pillText}>{open ? "Dev ✕" : "Dev"}</Text>
      </Pressable>
    </View>
  );
}

function DevButton(props: {
  testID: string;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.button, props.disabled && styles.buttonDisabled]}
    >
      <Text style={styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFill,
    alignItems: "flex-end",
    justifyContent: "flex-end",
    paddingRight: 12,
    gap: 8,
  },
  pill: {
    backgroundColor: "#111827",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    opacity: 0.9,
  },
  pillText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  panel: {
    width: 240,
    backgroundColor: "#111827",
    borderRadius: 12,
    padding: 10,
    gap: 6,
  },
  progress: { color: "#e5e7eb", fontSize: 13, fontWeight: "600" },
  section: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#4b5563",
    paddingTop: 6,
    gap: 6,
  },
  error: { color: "#fca5a5", fontSize: 12 },
  button: {
    backgroundColor: "#374151",
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "#fff", fontSize: 13, fontWeight: "600" },
});
