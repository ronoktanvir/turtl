import { Linking, Platform } from "react-native";

// GitHub's install page opens in the system browser on a phone, and GitHub's last redirect brings the person back
// through turtl:// to Add project. On the web the page itself goes to GitHub and comes back by an ordinary redirect.
export async function openForConnect(url: string): Promise<void> {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.location.assign(url);
    return;
  }
  await Linking.openURL(url);
}

// A GitHub page to look at, with nothing to come back to: a new tab on the web, the system browser on a phone.
export async function openOnGithub(url: string): Promise<void> {
  await Linking.openURL(url);
}
