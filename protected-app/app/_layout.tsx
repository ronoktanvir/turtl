import { Stack } from "expo-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { Text, View } from "react-native";

const url = process.env.EXPO_PUBLIC_CONVEX_URL;
const client = url ? new ConvexReactClient(url) : null;

export default function Layout() {
  if (!client) {
    return <View style={{ flex: 1, padding: 32, justifyContent: "center", backgroundColor: "#f6f4ed" }}><Text>Set EXPO_PUBLIC_CONVEX_URL to this protected app's Convex deployment, then restart Expo.</Text></View>;
  }
  return <ConvexProvider client={client}><Stack screenOptions={{ headerShown: false }} /></ConvexProvider>;
}
