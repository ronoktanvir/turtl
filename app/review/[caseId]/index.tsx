import { useLocalSearchParams, type Href } from "expo-router";
import { useRef, useState, type ComponentRef } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { CasePage } from "../../../components/fix/CasePage";
import { Header, Icon, Screen, T } from "../../../components/ui";
import { setStarred, useCase, useCases, useProject } from "../../../data";
import { useTheme } from "../../../theme";

export default function Review() {
  const { caseId } = useLocalSearchParams<{ caseId: string }>();
  const first = useCase(caseId);
  const list = useCases(first?.projectId ?? "", first?.type ?? "fix");
  const project = useProject(first?.projectId ?? "");
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

  if (first === undefined || list === undefined) {
    return (
      <Screen>
        <T style={{ padding: 16 }}>Loading…</T>
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
        title={(project?.name ?? "") + (feature ? ": request #" : ": error #") + current.number}
        fallback={("/project/" + current.projectId + (feature ? "/features" : "/fix")) as never}
        testID="review-title"
        right={
          <Pressable
            onPress={() => setStarred(current.id, !current.starred)}
            accessibilityRole="button"
            accessibilityLabel={current.starred ? "Starred. Tap to remove the star" : "Star this to look at later"}
            accessibilityState={{ selected: !!current.starred }}
            testID="case-star"
            hitSlop={8}
            style={{ alignItems: "center", justifyContent: "center", width: 44, height: 44 }}
          >
            <Icon name="Star" size={21} color={current.starred ? "statusNeedsYou" : "textMuted"} strokeWidth={current.starred ? 2.7 : 1.7} />
          </Pressable>
        }
      />
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
            {page + 1 + " of " + ids.length + " · swipe sideways"}
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
                {Math.abs(i - page) <= 1 && <CasePage caseId={id} current={i === page} />}
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </Screen>
  );
}
