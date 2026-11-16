import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useAction, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { ReportForm } from "../report/ReportForm";

type Confirmation = { bookingId: string; serviceId: string; date: string; time: string };
type Suggestions = { status: "loading" | "ready" | "disabled" | "unavailable"; serviceIds: string[] };

function timeLabel(time: string) {
  const hour = Number(time.slice(0, 2));
  return `${hour % 12 || 12}:00 ${hour >= 12 ? "PM" : "AM"}`;
}

export default function BookingScreen() {
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const catalog = useQuery(api.bookingDemo.booking.getCatalog);
  const flags = useQuery(api.bookingDemo.booking.getFlags);
  const recommend = useAction(api.bookingDemo.booking.recommendations);
  const submit = useAction(api.bookingDemo.booking.submit);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions>({ status: "loading", serviceIds: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; id?: string; code?: string } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const service = catalog?.services.find((s) => s.id === (confirmation?.serviceId ?? serviceId));
  const date = catalog ? new Date(`${confirmation?.date ?? catalog.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }) : "";

  useEffect(() => {
    if (!flags) return;
    let active = true;
    if (!flags.recommendationsEnabled) {
      setSuggestions({ status: "disabled", serviceIds: [] });
      return;
    }
    setSuggestions({ status: "loading", serviceIds: [] });
    recommend({}).then((result) => { if (active) setSuggestions(result); }).catch(() => { if (active) setSuggestions({ status: "unavailable", serviceIds: [] }); });
    return () => { active = false; };
  }, [flags?.recommendationsEnabled, recommend]);

  async function book() {
    if (!catalog || !serviceId || !time || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submit({ serviceId, date: catalog.date, time });
      if (result.ok) setConfirmation(result);
      else setError({ message: result.error.message, id: result.errorId ?? undefined, code: result.error.code });
    } catch {
      setError({ message: "We couldn't confirm your booking. Please check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return <ScrollView style={s.page} contentContainerStyle={s.pageContent}>
    <View style={s.shell}>
      <View style={[s.nav, !wide && { marginBottom: 24 }]}><Text style={s.wordmark}>still<Text style={s.wordmarkDot}>.</Text></Text><View style={s.demoBadge}><View style={s.dot} /><Text style={s.demoText}>BOOKING DEMO</Text></View></View>
      <View style={[s.main, wide && s.mainWide]}>
        <View style={[s.intro, wide && s.introWide]}>
          <Text style={s.eyebrow}>A LITTLE TIME FOR YOURSELF</Text>
          <Text style={[s.headline, wide && s.headlineWide]}>Less rush.{"\n"}More reset.</Text>
          <Text style={s.introText}>Make space to feel like yourself again. A thoughtful treatment, at a time that works for you.</Text>
          {wide && <><View style={s.art}><View style={s.artCircleOuter}><View style={s.artCircleInner}><Text style={s.artStar}>✳</Text></View></View><View style={s.artCaption}><Text style={s.artCaptionTitle}>Take a breath.</Text><Text style={s.artCaptionText}>We'll take it from here.</Text></View></View>
          <View style={s.introFooter}><Text style={s.tiny}>THOUGHTFUL CARE</Text><Text style={s.tiny}>ONE APPOINTMENT AT A TIME</Text></View></>}
        </View>
        <View style={[s.card, wide && s.cardWide]}>
          {!catalog || !flags ? <View style={s.loading}><ActivityIndicator color="#31564b" /><Text style={s.body}>Finding a little breathing room…</Text></View> : confirmation ? <View style={s.confirmation}>
            <View style={s.successMark}><Text style={s.successTick}>✓</Text></View>
            <Text style={s.eyebrow}>YOU'RE ALL SET</Text><Text style={s.cardTitle}>A moment, reserved.</Text>
            <Text style={s.body}>Your booking is confirmed and saved. All that's left is to show up and settle in.</Text>
            <View style={s.receipt}><Text style={s.serviceTitle}>{service?.name}</Text><Text style={s.body}>{date} · {timeLabel(confirmation.time)} UTC</Text><Text style={s.body}>{service?.minutes} minutes · ${service?.price}</Text><View style={s.receiptRule} /><Text style={s.tiny}>CONFIRMATION</Text><Text selectable style={s.confirmationId}>{confirmation.bookingId}</Text></View>
            <Pressable accessibilityRole="button" style={s.primary} onPress={() => { setConfirmation(null); setServiceId(null); setTime(null); setError(null); }}><Text style={s.primaryText}>Book another moment  ↗</Text></Pressable>
          </View> : <>
            <View style={s.cardHeader}><Text style={s.eyebrow}>YOUR NEXT GOOD HOUR</Text><Text style={s.cardTitle}>Book a moment.</Text><Text style={s.body}>Choose your treatment. We'll save your spot.</Text></View>
            <View style={s.recommendations}>
              <View style={s.recommendationHeader}><Text style={s.recommendationTitle}>✧  A little inspiration</Text><Text style={s.optional}>OPTIONAL AI SUGGESTIONS</Text></View>
              {suggestions.status === "loading" ? <Text style={s.recommendationBody}>Finding a thoughtful fit…</Text> : suggestions.status === "ready" ? <><Text style={s.recommendationBody}>For a slower day, try one of these.</Text><View style={s.suggestionRow}>{suggestions.serviceIds.map((id) => <Pressable key={id} accessibilityRole="button" onPress={() => setServiceId(id)} style={s.suggestion}><Text style={s.suggestionText}>{catalog.services.find((item) => item.id === id)?.name} ↗</Text></Pressable>)}</View></> : <Text style={s.recommendationBody}>{suggestions.status === "disabled" ? "Suggestions are off. Choose any treatment below." : "Suggestions are unavailable right now."}</Text>}
            </View>
            <Text style={s.sectionLabel}>01 <Text style={s.sectionTitle}>Choose your treatment</Text></Text>
            <View style={s.services}>{catalog.services.map((item) => {
              const selected = serviceId === item.id;
              return <Pressable key={item.id} accessibilityRole="radio" accessibilityLabel={`${item.name}, ${item.minutes} minutes, $${item.price}`} accessibilityState={{ checked: selected }} onPress={() => { setServiceId(item.id); setError(null); }} style={[s.service, selected && s.serviceSelected]}><View style={[s.radio, selected && s.radioSelected]}>{selected && <View style={s.radioInner} />}</View><View style={s.serviceContent}><View style={s.serviceTop}><Text style={s.serviceTitle}>{item.name}</Text><Text style={s.price}>${item.price}</Text></View><Text style={s.serviceDescription}>{item.description}</Text><Text style={s.duration}>{item.minutes} MIN</Text></View></Pressable>;
            })}</View>
            <View style={s.timeHeading}><Text style={s.sectionLabel}>02 <Text style={s.sectionTitle}>Find your time</Text></Text><Text style={s.date}>{date} · UTC</Text></View>
            <View style={s.slots}>{catalog.slots.map((slot) => <Pressable key={slot} accessibilityRole="radio" accessibilityState={{ checked: time === slot }} onPress={() => { setTime(slot); setError(null); }} style={[s.slot, time === slot && s.slotSelected]}><Text style={[s.slotText, time === slot && s.slotTextSelected]}>{timeLabel(slot)}</Text></Pressable>)}</View>
            {error && <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={s.error}><Text style={s.errorTitle}>We couldn't save your spot.</Text><Text style={s.errorText}>{error.message}</Text>{error.id && <Text selectable style={s.errorId}>Error reference: {error.id}</Text>}{error.code === "RECOMMENDATIONS_TIMEOUT" && <Text style={s.errorId}>Staged demo: optional recommendations are blocking booking.</Text>}{error.code === "BOOKING_STORE_UNAVAILABLE" && <Text style={s.errorId}>Staged demo: the booking store is unavailable.</Text>}</View>}
            <View style={s.summary}><Text style={s.summaryText}>{service && time ? `${service.name} · ${service.minutes} min` : "Your next little reset"}</Text><Text style={s.summaryPrice}>{service ? `$${service.price}` : "—"}</Text></View>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: !serviceId || !time || busy }} disabled={!serviceId || !time || busy} onPress={book} style={[s.primary, (!serviceId || !time || busy) && s.primaryDisabled]}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryText}>Confirm booking  ↗</Text>}</Pressable>
            <Text style={s.disclaimer}>Demo booking only. No payment is collected.</Text>
          </>}
        </View>
      </View>
      <ReportForm />
      <View style={s.footer}><Text style={s.footerText}>STILL · A PROTECTED DEMO APP</Text><Text style={s.footerText}>A small pause. A better day.</Text></View>
    </View>
  </ScrollView>;
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#f3f2eb" }, pageContent: { paddingHorizontal: 22, paddingVertical: 24 }, shell: { width: "100%", maxWidth: 1120, alignSelf: "center" },
  nav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 42 }, wordmark: { fontSize: 38, letterSpacing: -2, fontWeight: "700", color: "#213d34" }, wordmarkDot: { color: "#c27f54" },
  demoBadge: { flexDirection: "row", gap: 7, alignItems: "center", borderColor: "#d6ded3", borderWidth: 1, borderRadius: 30, paddingVertical: 8, paddingHorizontal: 11 }, dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: "#56816e" }, demoText: { fontSize: 9, letterSpacing: 1.2, color: "#526b5f", fontWeight: "600" },
  main: { gap: 26 }, mainWide: { flexDirection: "row", gap: 64, alignItems: "flex-start" }, intro: { paddingTop: 6 }, introWide: { flex: 1, paddingTop: 38 }, eyebrow: { fontSize: 10, letterSpacing: 1.8, color: "#68786a", fontWeight: "600" }, headline: { fontSize: 48, lineHeight: 51, letterSpacing: -2.8, color: "#283e32", marginTop: 21, fontWeight: "500" }, headlineWide: { fontSize: 72, lineHeight: 74, letterSpacing: -4 }, introText: { fontSize: 15, lineHeight: 25, color: "#788076", marginTop: 22, maxWidth: 310 },
  art: { marginTop: 35, height: 240, borderRadius: 180, backgroundColor: "#e7e8dc", overflow: "hidden", justifyContent: "center", alignItems: "center", maxWidth: 350 }, artCircleOuter: { width: 200, height: 200, borderRadius: 110, borderWidth: 1, borderColor: "#c8cebb", alignItems: "center", justifyContent: "center", position: "absolute", top: -42, right: -17 }, artCircleInner: { width: 142, height: 142, borderRadius: 80, backgroundColor: "#d6dccb", justifyContent: "center", alignItems: "center" }, artStar: { color: "#74886c", fontSize: 79, fontWeight: "200" }, artCaption: { alignSelf: "flex-start", marginLeft: 36, marginTop: 100 }, artCaptionTitle: { color: "#526249", fontSize: 24, letterSpacing: -0.7 }, artCaptionText: { color: "#7c8574", fontSize: 12, marginTop: 6 }, introFooter: { flexDirection: "row", gap: 18, marginTop: 29, marginBottom: 8 }, tiny: { fontSize: 8, letterSpacing: 1, color: "#7b8579", fontWeight: "500" },
  card: { backgroundColor: "#fffefa", borderRadius: 20, padding: 24, borderWidth: 1, borderColor: "#e6e6dc" }, cardWide: { width: 550, padding: 30 }, cardHeader: { marginBottom: 23 }, cardTitle: { fontSize: 30, letterSpacing: -1.2, color: "#2b3f34", marginTop: 9, marginBottom: 8, fontWeight: "500" }, body: { fontSize: 13, lineHeight: 21, color: "#7c8278" },
  recommendations: { backgroundColor: "#f0f2e9", padding: 15, borderRadius: 11, marginBottom: 25 }, recommendationHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }, recommendationTitle: { fontSize: 12, fontWeight: "600", color: "#506248" }, optional: { fontSize: 7, letterSpacing: 0.9, color: "#7e8d72" }, recommendationBody: { fontSize: 11, color: "#7c8772", marginTop: 7, lineHeight: 17 }, suggestionRow: { flexDirection: "row", gap: 7, marginTop: 10 }, suggestion: { borderWidth: 1, borderColor: "#d4dcc6", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 }, suggestionText: { color: "#586d4d", fontSize: 10 },
  sectionLabel: { fontSize: 10, letterSpacing: 0.8, color: "#a0a797", marginBottom: 13 }, sectionTitle: { fontSize: 12, letterSpacing: 0, fontWeight: "600", color: "#425041" }, services: { gap: 9 }, service: { flexDirection: "row", padding: 14, borderRadius: 10, borderColor: "#e5e7dc", borderWidth: 1, gap: 12 }, serviceSelected: { borderColor: "#759271", backgroundColor: "#f4f7ef" }, radio: { width: 16, height: 16, borderRadius: 9, borderWidth: 1, borderColor: "#cdd3c4", marginTop: 2, justifyContent: "center", alignItems: "center" }, radioSelected: { borderColor: "#526f4d" }, radioInner: { width: 8, height: 8, borderRadius: 5, backgroundColor: "#526f4d" }, serviceContent: { flex: 1 }, serviceTop: { flexDirection: "row", justifyContent: "space-between" }, serviceTitle: { fontSize: 14, fontWeight: "600", color: "#3a493a" }, price: { fontSize: 13, color: "#53674a", fontWeight: "500" }, serviceDescription: { fontSize: 10, lineHeight: 16, color: "#8b9282", marginTop: 4 }, duration: { fontSize: 8, letterSpacing: 0.9, color: "#9a9f90", marginTop: 7 },
  timeHeading: { marginTop: 24 }, date: { fontSize: 10, color: "#8d9586", marginBottom: 12 }, slots: { flexDirection: "row", gap: 8, flexWrap: "wrap" }, slot: { flex: 1, minWidth: 62, borderRadius: 8, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: "#e2e5d9" }, slotSelected: { backgroundColor: "#526d4f", borderColor: "#526d4f" }, slotText: { fontSize: 10, color: "#78836e" }, slotTextSelected: { color: "#fff" },
  summary: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 23, marginTop: 23, paddingBottom: 16, borderTopWidth: 1, borderTopColor: "#eceee3" }, summaryText: { color: "#808a77", fontSize: 11 }, summaryPrice: { color: "#3e533b", fontSize: 19, fontWeight: "500" }, primary: { backgroundColor: "#2f5145", minHeight: 48, borderRadius: 9, alignItems: "center", justifyContent: "center" }, primaryDisabled: { opacity: 0.4 }, primaryText: { color: "#fffefa", fontSize: 12, fontWeight: "500", letterSpacing: 0.2 }, disclaimer: { color: "#a5aa9b", fontSize: 9, textAlign: "center", marginTop: 12 },
  error: { backgroundColor: "#fbede5", borderRadius: 9, padding: 14, marginTop: 18, gap: 6 }, errorTitle: { color: "#874b35", fontSize: 13, fontWeight: "600" }, errorText: { color: "#9f6048", fontSize: 11, lineHeight: 17 }, errorId: { color: "#a47360", fontSize: 8, lineHeight: 13 },
  loading: { minHeight: 400, justifyContent: "center", alignItems: "center", gap: 15 }, confirmation: { gap: 12, paddingVertical: 18 }, successMark: { width: 54, height: 54, backgroundColor: "#e7efdf", borderRadius: 28, alignItems: "center", justifyContent: "center", marginBottom: 16 }, successTick: { fontSize: 26, color: "#5a7750" }, receipt: { backgroundColor: "#f3f5ec", padding: 22, borderRadius: 12, marginVertical: 16, gap: 9 }, receiptRule: { borderTopWidth: 1, borderTopColor: "#dde4d3", marginVertical: 9 }, confirmationId: { color: "#75816a", fontSize: 10 }, footer: { flexDirection: "row", justifyContent: "space-between", marginTop: 38, paddingTop: 18, borderTopColor: "#e0e3d7", borderTopWidth: 1, flexWrap: "wrap", gap: 10 }, footerText: { color: "#939b88", fontSize: 8, letterSpacing: 0.9 },
});
