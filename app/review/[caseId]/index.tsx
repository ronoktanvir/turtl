import { useLocalSearchParams, type Href } from "expo-router";
import { useRef, useState, type ComponentRef } from "react";
import { Pressable, ScrollView, View } from "react-native";
import AiNotice from "../../../components/consent/AiNotice";
import { CasePage } from "../../../components/fix/CasePage";
import { caseTitle, Header, Icon, Screen, T } from "../../../components/ui";
import { SkeletonCase } from "../../../components/ui/Skeleton";
import { setStarred, useCase, useCases, useDataStatus, useProject } from "../../../data";
import { useTheme } from "../../../theme";

export default function Review() {
  // ?part=fixes opens the issue on its Fixes page (the practice sheet's "Look at the fix").
  const { caseId, part } = useLocalSearchParams<{ caseId: string; part?: string }>();
  const first = useCase(caseId);
  const practice = useProject(first?.projectId ?? "")?.practice === true;
  const { errors } = useDataStatus();
  const list = useCases(first?.projectId ?? "", first?.type ?? "fix");
  const { colors } = useTheme();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const width = size.width;
  const pager = useRef<ComponentRef<typeof ScrollView>>(null);
  const order = useRef<string[] | null>(null);
  if (!order.current && first && list) {
    order.current = list.some((c) => c.id === caseId) ? list.map((c) => c.id) : [caseId];
  }
  const ids = order.current ?? [];
  const [index, setIndex] = useState(-1);
  const page = index === -1 ? Math.max(0, ids.indexOf(caseId)) : index;
  const current = useCase(ids[page] ?? caseId);
  const starPending = useRef(false);
  const [starring, setStarring] = useState(false);
  const [starError, setStarError] = useState<string | null>(null);
  const toggleStar = async () => {
    if (!current || starPending.current) return;
    starPending.current = true;
    setStarring(true);
    setStarError(null);
    try {
      await setStarred(current.id, !current.starred);
    } catch (error) {
      setStarError(error instanceof Error ? error.message : "Could not update this star. Please try again.");
    } finally {
      starPending.current = false;
      setStarring(false);
    }
  };

  if (first === undefined || (first && list === undefined) || current === undefined) {
    return (
      <Screen>
        {errors.length === 0 && <SkeletonCase />}
      </Screen>
    );
  }
  if (!first || !current) {
    return (
      <Screen>
        <Header title="Not found" fallback={"/projects" as Href} />
        <T style={{ padding: 16 }}>This case could not be found.</T>
      </Screen>
    );
  }

  const feature = current.type === "feature";
  const goTo = (next: number) => {
    setIndex(next);
    pager.current?.scrollTo({ x: next * width, animated: true });
  };

  return (
    <Screen testID="review">
      <Header
        title={caseTitle(current)}
        scrollTitle
        fallback={("/project/" + current.projectId + (feature ? "/features" : "/fix")) as never}
        testID="review-title"
        right={
          <Pressable
            onPress={() => void toggleStar()}
            disabled={starring}
            accessibilityRole="button"
            accessibilityLabel={current.starred ? "Starred. Tap to remove the star" : "Star this to look at later"}
            accessibilityState={{ selected: !!current.starred, disabled: starring, busy: starring }}
            testID="case-star"
            hitSlop={8}
            style={{ alignItems: "center", justifyContent: "center", width: 44, height: 44 }}
          >
            <Icon name="Star" size={21} color={current.starred ? "statusNeedsYou" : "textMuted"} strokeWidth={current.starred ? 2.7 : 1.7} />
          </Pressable>
        }
      />
      {starError && <T font="text" color="statusAffected" accessibilityRole="alert" testID="case-star-error" style={{ paddingHorizontal: 20, paddingVertical: 8 }}>{starError}</T>}
      {/* A case about an app that is not answering uses no AI: turtl only waits for the app to answer. */}
      {!current.notAnswering && <AiNotice uses={practice ? ["openai"] : ["openai", "capy"]} cannot={practice ? "diagnose this with AI" : "diagnose this with AI or write code fixes"} style={{ marginHorizontal: 20, marginTop: 8 }} />}

      {ids.length > 1 && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 12,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <Pressable
            onPress={() => goTo(page - 1)}
            disabled={page === 0}
            accessibilityRole="button"
            testID="case-prev"
            style={{ padding: 10, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 4, opacity: page === 0 ? 0.35 : 1 }}
          >
            <Icon name="ArrowLeft" size={14} color="textMuted" />
            <T variant="small" color="textMuted">
              Previous
            </T>
          </Pressable>
          <T variant="small" color="textMuted" testID="case-position">
            {page + 1 + " of " + ids.length}
          </T>
          <Pressable
            onPress={() => goTo(page + 1)}
            disabled={page === ids.length - 1}
            accessibilityRole="button"
            testID="case-next"
            style={{ padding: 10, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 4, opacity: page === ids.length - 1 ? 0.35 : 1 }}
          >
            <T variant="small" color="textMuted">
              Next
            </T>
            <Icon name="ArrowRight" size={14} color="textMuted" />
          </Pressable>
        </View>
      )}
      <View style={{ flex: 1 }} onLayout={(event) => setSize(event.nativeEvent.layout)}>
        {width > 0 && (
          <ScrollView
            ref={pager}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={32}
            onLayout={() => pager.current?.scrollTo({ x: page * width, animated: false })}
            onScroll={(event) => {
              const next = Math.round(event.nativeEvent.contentOffset.x / width);
              if (next !== page && next >= 0 && next < ids.length) setIndex(next);
            }}
            testID="case-pager"
          >
            {ids.map((id, i) => (
              <View key={id} style={{ width, height: size.height }}>
                {Math.abs(i - page) <= 1 && <CasePage caseId={id} current={i === page} startOn={part === "fixes" && id === caseId ? "fixes" : "case"} />}
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </Screen>
  );
}
