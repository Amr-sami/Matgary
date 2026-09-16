#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, orderBy } from "firebase/firestore";

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

// Mirror lib/firestore.ts subscribeToSales mapping
function mapSale(d) {
  const data = d.data();
  return {
    id: d.id,
    productName: data.productName,
    category: data.category,
    gender: data.gender,
    invoiceId: data.invoiceId,
    quantitySold: data.quantitySold,
    totalPrice: data.totalPrice,
    isReturned: data.isReturned || false,
    saleDate: data.saleDate?.toDate?.() ?? new Date(),
    customerName: data.customerName || undefined,
    customerPhone: data.customerPhone || undefined,
    paymentMethod: data.paymentMethod,
    isPaid:
      typeof data.isPaid === "boolean"
        ? data.isPaid
        : data.paymentMethod !== "deferred",
  };
}

// Mirror lib/customers.ts buildCustomerAggregates
function buildCustomerAggregates(sales) {
  const map = new Map();
  for (const s of sales) {
    if (s.isReturned) continue;
    const name = (s.customerName || "").trim();
    const phone = (s.customerPhone || "").trim();
    if (!name && !phone) continue;
    const key = phone || `name:${name.toLowerCase()}`;
    const cur = map.get(key) || {
      key,
      name: name || "بدون اسم",
      phone: phone || undefined,
      invoiceCount: 0,
      saleCount: 0,
      lifetimeValue: 0,
      invoiceIds: new Set(),
      lastVisit: s.saleDate,
    };
    if (name && cur.name === "بدون اسم") cur.name = name;
    if (!cur.phone && phone) cur.phone = phone;
    cur.saleCount += 1;
    cur.lifetimeValue += s.totalPrice;
    if (s.invoiceId) cur.invoiceIds.add(s.invoiceId);
    if (s.saleDate > cur.lastVisit) cur.lastVisit = s.saleDate;
    map.set(key, cur);
  }
  for (const agg of map.values()) {
    agg.invoiceCount = agg.invoiceIds.size || agg.saleCount;
  }
  return Array.from(map.values());
}

const snap = await getDocs(query(collection(db, "sales"), orderBy("saleDate", "desc")));
const sales = snap.docs.map(mapSale);
console.log(`Total sales: ${sales.length}`);
console.log(`Active sales: ${sales.filter((s) => !s.isReturned).length}`);
console.log(
  `With customer data: ${
    sales.filter((s) => !s.isReturned && (s.customerName || s.customerPhone)).length
  }`
);

const agg = buildCustomerAggregates(sales);
console.log(`\nAggregated customers: ${agg.length}\n`);
for (const c of agg) {
  console.log(
    `  • ${c.name} | ${c.phone || "(no phone)"} | ${c.invoiceCount} invoices | ${c.lifetimeValue} ج.م`
  );
}
process.exit(0);
