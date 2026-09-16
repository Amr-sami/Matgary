#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc } from "firebase/firestore";

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

const snap = await getDoc(doc(db, "appSettings", "whatsapp"));
console.log("Doc exists:", snap.exists());
if (snap.exists()) {
  const data = snap.data();
  // Mask token
  if (data.greenApiToken) {
    data.greenApiToken =
      data.greenApiToken.slice(0, 6) +
      "..." +
      data.greenApiToken.slice(-4);
  }
  console.log(JSON.stringify(data, null, 2));
}
process.exit(0);
