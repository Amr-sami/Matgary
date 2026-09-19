#!/usr/bin/env node
/**
 * One-off: writes the Green API credentials (provided by the user in chat)
 * into the appSettings/whatsapp doc, since the user typed them in the UI
 * without clicking "Save" and they ended up empty in Firestore.
 *
 * Safe to delete after running once.
 */
import { readFileSync } from "node:fs";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq === -1) continue;
  const k = line.slice(0, eq).trim();
  const v = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
  if (!process.env[k]) process.env[k] = v;
}

const app = initializeApp({
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
});
const db = getFirestore(app);

await setDoc(
  doc(db, "appSettings", "whatsapp"),
  {
    greenApiEnabled: true,
    greenApiInstanceId: "7107606136",
    greenApiToken: "21228ca91b714a9db84ab31e7badd14fbf6348c9b9a94190bc",
    greenApiUrl: "https://7107.api.greenapi.com",
    sendAsPdf: true,
  },
  { merge: true }
);

console.log("Green API credentials saved to appSettings/whatsapp.");
process.exit(0);
