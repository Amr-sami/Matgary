#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, query, orderBy, limit, getDocs, doc, getDoc } from "firebase/firestore";

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

const idArg = process.argv[2];

if (idArg) {
  const snap = await getDoc(doc(db, "sales", idArg));
  console.log("Doc exists:", snap.exists());
  if (snap.exists()) {
    console.log("Raw data:");
    console.log(JSON.stringify(snap.data(), null, 2));
  }
} else {
  // List all sales newest-first showing all customer-related fields
  const snap = await getDocs(query(collection(db, "sales"), orderBy("saleDate", "desc"), limit(10)));
  for (const d of snap.docs) {
    const data = d.data();
    const has = (k) =>
      Object.prototype.hasOwnProperty.call(data, k);
    console.log(d.id);
    console.log(`  productName:    ${data.productName}`);
    console.log(`  has customerName:  ${has("customerName")} | value: ${JSON.stringify(data.customerName)}`);
    console.log(`  has customerPhone: ${has("customerPhone")} | value: ${JSON.stringify(data.customerPhone)}`);
    console.log(`  has paymentMethod: ${has("paymentMethod")} | value: ${JSON.stringify(data.paymentMethod)}`);
    console.log(`  has invoiceId:     ${has("invoiceId")} | value: ${JSON.stringify(data.invoiceId)}`);
    console.log("");
  }
}
process.exit(0);
