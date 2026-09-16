import { Stack } from "expo-router";

export default function AppLayout() {
  // A Stack for now. The 5-tab bar (built at runtime from permissions, per
  // doc 05) lands in phase 4 — putting it in before there are screens to
  // switch between would just be an empty chrome.
  return <Stack screenOptions={{ headerShown: false }} />;
}
