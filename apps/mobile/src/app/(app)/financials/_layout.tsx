// Mobile Financials stack. Overview + P&L — the two views production needs
// from a phone. CRUD (expenses, money movements, categories, recurring)
// stays on the web for 2b; mobile reads but doesn't write financial data
// yet.

import { Stack } from "expo-router";

export default function FinancialsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
