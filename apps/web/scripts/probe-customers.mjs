#!/usr/bin/env node
/**
 * Diagnostic + repair helper for the customers issue.
 *
 *   node scripts/probe-customers.mjs            # read-only: inspect last 5 sales
 *   node scripts/probe-customers.mjs --write    # also writes a test sale with customer data
 *
 * The script uses the same Firebase config the app uses (NEXT_PUBLIC_*),
 * so what it sees is exactly what /customers sees.
 */

import { readFileSync } from "node:fs";
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  addDoc,
  serverTimestamp,
} from "firebase/firestore";

// Load .env.local manually (Next loads it for the app, not for plain node)
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq === -1) continue;
  const k = line.slice(0, eq).trim();
  const v = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
  if (!process.env[k]) process.env[k] = v;
}

const cfg = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

if (!cfg.projectId) {
  console.error(
    "Could not find NEXT_PUBLIC_FIREBASE_PROJECT_ID in .env.local — aborting"
  );
  process.exit(1);
}

const app = initializeApp(cfg);
const db = getFirestore(app);

const args = new Set(process.argv.slice(2));
const doWrite = args.has("--write");

console.log(`\n— project: ${cfg.projectId}\n`);

// 1. Inspect the 5 most recent sales
const recentSnap = await getDocs(
  query(collection(db, "sales"), orderBy("saleDate", "desc"), limit(5))
);

console.log(`Last ${recentSnap.size} sales:\n`);
for (const d of recentSnap.docs) {
  const data = d.data();
  const has = (k) =>
    Object.prototype.hasOwnProperty.call(data, k)
      ? data[k] === null
        ? "null"
        : JSON.stringify(data[k])
      : "(missing)";
  console.log(`  • ${d.id}`);
  console.log(`     productName:   ${data.productName}`);
  console.log(`     customerName:  ${has("customerName")}`);
  console.log(`     customerPhone: ${has("customerPhone")}`);
  console.log(`     paymentMethod: ${has("paymentMethod")}`);
  console.log(`     invoiceId:     ${has("invoiceId")}`);
  console.log("");
}

// 2. Aggregate count of sales that have any customer data
const countSnap = await getDocs(
  query(collection(db, "sales"), orderBy("saleDate", "desc"), limit(500))
);
let withCustomer = 0;
let total = 0;
for (const d of countSnap.docs) {
  const x = d.data();
  if (x.isReturned) continue;
  total += 1;
  if ((x.customerName && x.customerName.trim()) || (x.customerPhone && x.customerPhone.trim())) {
    withCustomer += 1;
  }
}
console.log(
  `Of the last ${total} non-returned sales, ${withCustomer} have a customerName or customerPhone.`
);

if (!doWrite) {
  console.log(
    "\nRun again with --write to add a synthetic test sale with customer data."
  );
  process.exit(0);
}

// 3. Pick a real product so the FK is valid
const productSnap = await getDocs(query(collection(db, "products"), limit(1)));
if (productSnap.empty) {
  console.error("No products in /products — cannot create a test sale.");
  process.exit(1);
}
const p = productSnap.docs[0];
const product = p.data();
console.log(`\nUsing product "${product.name}" (${p.id}) for the test sale.`);

const payload = {
  invoiceId: `INV-DIAG-${Date.now()}`,
  productId: p.id,
  productName: product.name,
  category: product.category,
  gender: product.gender,
  brand: product.brand || null,
  quantitySold: 1,
  pricePerUnit: product.price ?? 0,
  costPriceAtSale:
    typeof product.costPrice === "number" ? product.costPrice : null,
  subtotal: product.price ?? 0,
  discountType: null,
  discountValue: null,
  discountAmount: null,
  totalPrice: product.price ?? 0,
  saleDate: serverTimestamp(),
  isReturned: false,
  returnedAt: null,
  returnedQuantity: null,
  note: "diagnostic — safe to delete",
  customerName: "Test Customer (diagnostic)",
  customerPhone: "01000000000",
  paymentMethod: "cash",
  isPaid: true,
  paidAt: serverTimestamp(),
};

const ref = await addDoc(collection(db, "sales"), payload);
console.log(
  `\nWrote diagnostic sale ${ref.id} with customerName/customerPhone.`
);
console.log(
  "Now reload /customers — if the test customer appears, the read path works\nand the issue is the form's write path. If it does NOT appear, the issue is\nthe customers page itself."
);
process.exit(0);
