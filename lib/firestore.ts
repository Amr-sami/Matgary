import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  runTransaction,
  onSnapshot,
  query,
  orderBy,
  where,
  serverTimestamp,
  writeBatch,
  Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";
import type {
  Product,
  Sale,
  Return,
  Category,
  Gender,
  DiscountType,
  Expense,
  ExpenseCategory,
  ProductHistoryEvent,
  ProductHistoryEventType,
} from "./types";

export async function addExpense(
  data: Omit<Expense, "id" | "date">
): Promise<string> {
  const expensesRef = collection(db, "expenses");
  
  // Create a clean data object without undefined values
  const cleanData = { ...data };
  if (cleanData.note === undefined) {
    delete cleanData.note;
  }

  const docRef = await addDoc(expensesRef, {
    ...cleanData,
    date: serverTimestamp(),
  });
  return docRef.id;
}

export async function deleteExpense(expenseId: string): Promise<void> {
  const expenseRef = doc(db, "expenses", expenseId);
  await deleteDoc(expenseRef);
}

export function subscribeToExpenses(callback: (expenses: Expense[]) => void): () => void {
  const expensesRef = collection(db, "expenses");
  const q = query(expensesRef, orderBy("date", "desc"));
  
  const unsubscribe = onSnapshot(q, (snapshot) => {
    const expenses: Expense[] = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.title,
        amount: data.amount,
        category: data.category as ExpenseCategory,
        date: convertTimestamp(data.date as Timestamp),
        note: data.note,
      };
    });
    callback(expenses);
  });
  
  return unsubscribe;
}

function convertTimestamp(ts: Timestamp | null | undefined): Date {
  if (!ts) return new Date();
  return ts.toDate();
}

export async function addProduct(
  data: Omit<Product, "id" | "createdAt" | "updatedAt">
): Promise<string> {
  const productsRef = collection(db, "products");
  const docRef = await addDoc(productsRef, {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  void recordHistoryEvent({
    productId: docRef.id,
    productName: data.name,
    type: "created",
    quantityAfter: data.quantity,
  });
  return docRef.id;
}

export async function updateProduct(
  productId: string,
  data: Partial<Omit<Product, "id" | "createdAt">>
): Promise<void> {
  const productRef = doc(db, "products", productId);
  await updateDoc(productRef, {
    ...data,
    updatedAt: serverTimestamp(),
  });
  void recordHistoryEvent({
    productId,
    productName: data.name || "",
    type: "updated",
    quantityAfter: typeof data.quantity === "number" ? data.quantity : undefined,
  });
}

export async function deleteProduct(productId: string): Promise<void> {
  const productRef = doc(db, "products", productId);
  await deleteDoc(productRef);
}

async function recordHistoryEvent(input: {
  productId: string;
  productName: string;
  type: ProductHistoryEventType;
  delta?: number;
  quantityAfter?: number;
  note?: string;
}): Promise<void> {
  try {
    const ref = collection(db, "productHistory");
    const data: Record<string, unknown> = {
      productId: input.productId,
      productName: input.productName,
      type: input.type,
      createdAt: serverTimestamp(),
    };
    if (typeof input.delta === "number") data.delta = input.delta;
    if (typeof input.quantityAfter === "number") data.quantityAfter = input.quantityAfter;
    if (input.note) data.note = input.note;
    await addDoc(ref, data);
  } catch (e) {
    // History write must never block primary mutations
    console.warn("history write failed", e);
  }
}

export function subscribeToProductHistory(
  productId: string,
  callback: (events: ProductHistoryEvent[]) => void
): () => void {
  const ref = collection(db, "productHistory");
  const q = query(
    ref,
    where("productId", "==", productId),
    orderBy("createdAt", "desc")
  );
  return onSnapshot(q, (snap) => {
    const events: ProductHistoryEvent[] = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        productId: data.productId,
        productName: data.productName,
        type: data.type as ProductHistoryEventType,
        delta: data.delta,
        quantityAfter: data.quantityAfter,
        note: data.note,
        createdAt: convertTimestamp(data.createdAt as Timestamp),
      };
    });
    callback(events);
  });
}

export async function bulkDeleteProducts(productIds: string[]): Promise<void> {
  if (productIds.length === 0) return;
  const chunkSize = 400;
  for (let i = 0; i < productIds.length; i += chunkSize) {
    const batch = writeBatch(db);
    for (const id of productIds.slice(i, i + chunkSize)) {
      batch.delete(doc(db, "products", id));
    }
    await batch.commit();
  }
}

type BulkUpdate =
  | { type: "category"; value: Category }
  | { type: "gender"; value: Gender }
  | { type: "supplier"; value: string }
  | { type: "location"; value: string }
  | { type: "addTag"; value: string }
  | { type: "priceMultiplier"; value: number };

export async function bulkUpdateProducts(
  products: Pick<Product, "id" | "price" | "tags">[],
  update: BulkUpdate
): Promise<void> {
  if (products.length === 0) return;
  const chunkSize = 400;
  for (let i = 0; i < products.length; i += chunkSize) {
    const batch = writeBatch(db);
    for (const p of products.slice(i, i + chunkSize)) {
      const ref = doc(db, "products", p.id);
      const patch: Record<string, unknown> = { updatedAt: serverTimestamp() };
      switch (update.type) {
        case "category":
          patch.category = update.value;
          break;
        case "gender":
          patch.gender = update.value;
          break;
        case "supplier":
          patch.supplier = update.value;
          break;
        case "location":
          patch.location = update.value;
          break;
        case "addTag": {
          const next = Array.from(new Set([...(p.tags || []), update.value])).filter(Boolean);
          patch.tags = next;
          break;
        }
        case "priceMultiplier":
          patch.price = Math.max(0, Math.round(p.price * update.value));
          break;
      }
      batch.update(ref, patch);
    }
    await batch.commit();
  }
}

export async function bulkAddProducts(
  rows: Omit<Product, "id" | "createdAt" | "updatedAt">[]
): Promise<number> {
  if (rows.length === 0) return 0;
  const chunkSize = 400;
  let added = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const batch = writeBatch(db);
    for (const row of rows.slice(i, i + chunkSize)) {
      const ref = doc(collection(db, "products"));
      const cleaned: Record<string, unknown> = { ...row };
      Object.keys(cleaned).forEach((k) => {
        if (cleaned[k] === undefined) delete cleaned[k];
      });
      batch.set(ref, {
        ...cleaned,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      added++;
    }
    await batch.commit();
  }
  return added;
}

export async function adjustProductQuantity(
  productId: string,
  delta: number
): Promise<number> {
  const productRef = doc(db, "products", productId);
  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(productRef);
    if (!snap.exists()) throw new Error("المنتج غير موجود");
    const current = (snap.data().quantity as number) ?? 0;
    const next = Math.max(0, current + delta);
    tx.update(productRef, { quantity: next, updatedAt: serverTimestamp() });
    return { next, name: snap.data().name as string };
  });
  void recordHistoryEvent({
    productId,
    productName: result.name,
    type: delta >= 0 ? "restocked" : "decreased",
    delta,
    quantityAfter: result.next,
  });
  return result.next;
}

export function subscribeToProducts(callback: (products: Product[]) => void): () => void {
  const productsRef = collection(db, "products");
  const q = query(productsRef, orderBy("createdAt", "desc"));
  
  const unsubscribe = onSnapshot(q, (snapshot) => {
    const products: Product[] = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name,
        category: data.category as Category,
        gender: data.gender as Gender,
        brand: data.brand,
        quantity: data.quantity,
        price: data.price,
        costPrice: data.costPrice,
        lowStockThreshold: data.lowStockThreshold || 3,
        sku: data.sku,
        tags: Array.isArray(data.tags) ? (data.tags as string[]) : undefined,
        supplier: data.supplier,
        location: data.location,
        createdAt: convertTimestamp(data.createdAt as Timestamp),
        updatedAt: convertTimestamp(data.updatedAt as Timestamp),
      };
    });
    callback(products);
  });
  
  return unsubscribe;
}

function makeInvoiceId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `INV-${ts}${rnd}`.toUpperCase();
}

export async function recordSale(
  productId: string,
  quantitySold: number,
  pricePerUnit: number,
  note?: string,
  discountType?: DiscountType,
  discountValue?: number,
  customDate?: Date,
  invoiceId?: string
): Promise<string> {
  const productRef = doc(db, "products", productId);
  const saleRef = doc(collection(db, "sales"));

  const result = await runTransaction(db, async (transaction) => {
    const productSnap = await transaction.get(productRef);
    if (!productSnap.exists()) {
      throw new Error("المنتج غير موجود");
    }

    const currentQty = productSnap.data().quantity;
    if (currentQty < quantitySold) {
      throw new Error("الكمية المطلوبة غير متوفرة في المخزن");
    }

    const productData = productSnap.data();
    const subtotal = quantitySold * pricePerUnit;

    let discountAmount = 0;
    if (discountType && discountValue && discountValue > 0) {
      if (discountType === "percentage") {
        discountAmount = Math.round((subtotal * discountValue) / 100);
      } else {
        discountAmount = discountValue;
      }
    }
    discountAmount = Math.min(discountAmount, subtotal);
    const totalPrice = subtotal - discountAmount;

    const nextQty = currentQty - quantitySold;
    transaction.update(productRef, {
      quantity: nextQty,
      updatedAt: serverTimestamp(),
    });

    transaction.set(saleRef, {
      invoiceId: invoiceId || makeInvoiceId(),
      productId,
      productName: productData.name,
      category: productData.category,
      gender: productData.gender,
      brand: productData.brand || null,
      quantitySold,
      pricePerUnit,
      costPriceAtSale: typeof productData.costPrice === "number" ? productData.costPrice : null,
      subtotal,
      discountType: discountType || null,
      discountValue: discountValue || null,
      discountAmount: discountAmount || null,
      totalPrice,
      saleDate: customDate ? Timestamp.fromDate(customDate) : serverTimestamp(),
      isReturned: false,
      returnedAt: null,
      returnedQuantity: null,
      note: note || null,
    });

    return { saleId: saleRef.id, name: productData.name as string, nextQty };
  });

  void recordHistoryEvent({
    productId,
    productName: result.name,
    type: "sold",
    delta: -quantitySold,
    quantityAfter: result.nextQty,
  });

  return result.saleId;
}

export async function getSaleById(saleId: string): Promise<Sale | null> {
  const saleRef = doc(db, "sales", saleId);
  const snap = await getDoc(saleRef);
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    id: snap.id,
    productId: data.productId,
    productName: data.productName,
    category: data.category as Category,
    gender: data.gender as Gender,
    brand: data.brand,
    invoiceId: data.invoiceId,
    quantitySold: data.quantitySold,
    pricePerUnit: data.pricePerUnit,
    costPriceAtSale: typeof data.costPriceAtSale === "number" ? data.costPriceAtSale : undefined,
    subtotal: data.subtotal ?? (data.totalPrice + (data.discountAmount || 0)),
    discountType: data.discountType as DiscountType | undefined,
    discountValue: data.discountValue,
    discountAmount: data.discountAmount,
    totalPrice: data.totalPrice,
    saleDate: convertTimestamp(data.saleDate as Timestamp),
    isReturned: data.isReturned || false,
    returnedAt: data.returnedAt ? convertTimestamp(data.returnedAt as Timestamp) : undefined,
    returnedQuantity: data.returnedQuantity,
    note: data.note,
  };
}

export function subscribeToSales(callback: (sales: Sale[]) => void): () => void {
  const salesRef = collection(db, "sales");
  const q = query(salesRef, orderBy("saleDate", "desc"));
  
  const unsubscribe = onSnapshot(q, (snapshot) => {
    const sales: Sale[] = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        productId: data.productId,
        productName: data.productName,
        category: data.category as Category,
        gender: data.gender as Gender,
        brand: data.brand,
        quantitySold: data.quantitySold,
        pricePerUnit: data.pricePerUnit,
        subtotal: data.subtotal ?? (data.totalPrice + (data.discountAmount || 0)),
        discountType: data.discountType as DiscountType | undefined,
        discountValue: data.discountValue,
        discountAmount: data.discountAmount,
        totalPrice: data.totalPrice,
        saleDate: convertTimestamp(data.saleDate as Timestamp),
        isReturned: data.isReturned || false,
        returnedAt: data.returnedAt ? convertTimestamp(data.returnedAt as Timestamp) : undefined,
        returnedQuantity: data.returnedQuantity,
        note: data.note,
      };
    });
    callback(sales);
  });
  
  return unsubscribe;
}

export interface CartSaleLineInput {
  productId: string;
  quantity: number;
  pricePerUnit: number;
  lineDiscountType?: DiscountType;
  lineDiscountValue?: number;
}

export interface CartSaleResult {
  invoiceId: string;
  saleIds: string[];
}

export async function recordCartSale(
  lines: CartSaleLineInput[],
  options: {
    note?: string;
    orderDiscountType?: DiscountType;
    orderDiscountValue?: number;
    customDate?: Date;
  } = {}
): Promise<CartSaleResult> {
  if (lines.length === 0) throw new Error("الفاتورة فارغة");
  const invoiceId = makeInvoiceId();

  const result = await runTransaction(db, async (tx) => {
    // Read all referenced products inside the transaction
    type Pre = {
      line: CartSaleLineInput;
      productData: any;
      currentQty: number;
      ref: ReturnType<typeof doc>;
      saleRef: ReturnType<typeof doc>;
      lineSubtotal: number;
      lineDiscount: number;
    };
    const pre: Pre[] = [];
    let cartGross = 0;
    for (const line of lines) {
      const ref = doc(db, "products", line.productId);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error(`المنتج غير موجود (${line.productId})`);
      const data = snap.data();
      const currentQty = (data.quantity as number) ?? 0;
      if (currentQty < line.quantity) {
        throw new Error(
          `الكمية المطلوبة من "${data.name}" غير متوفرة (المتاح ${currentQty})`
        );
      }
      const lineSubtotal = line.quantity * line.pricePerUnit;
      let lineDiscount = 0;
      if (line.lineDiscountType && line.lineDiscountValue && line.lineDiscountValue > 0) {
        lineDiscount =
          line.lineDiscountType === "percentage"
            ? Math.round((lineSubtotal * line.lineDiscountValue) / 100)
            : line.lineDiscountValue;
      }
      lineDiscount = Math.min(lineDiscount, lineSubtotal);
      cartGross += lineSubtotal - lineDiscount;
      pre.push({
        line,
        productData: data,
        currentQty,
        ref,
        saleRef: doc(collection(db, "sales")),
        lineSubtotal,
        lineDiscount,
      });
    }

    // Apportion order-level discount across lines proportionally
    let orderDiscountTotal = 0;
    if (
      options.orderDiscountType &&
      typeof options.orderDiscountValue === "number" &&
      options.orderDiscountValue > 0 &&
      cartGross > 0
    ) {
      orderDiscountTotal =
        options.orderDiscountType === "percentage"
          ? Math.round((cartGross * options.orderDiscountValue) / 100)
          : options.orderDiscountValue;
      orderDiscountTotal = Math.min(orderDiscountTotal, cartGross);
    }

    const saleIds: string[] = [];
    let allocated = 0;
    for (let i = 0; i < pre.length; i++) {
      const p = pre[i];
      const afterLine = p.lineSubtotal - p.lineDiscount;
      const sharePct = cartGross > 0 ? afterLine / cartGross : 0;
      let allocation = i === pre.length - 1
        ? orderDiscountTotal - allocated
        : Math.round(orderDiscountTotal * sharePct);
      allocation = Math.max(0, Math.min(allocation, afterLine));
      allocated += allocation;
      const totalLineDiscount = p.lineDiscount + allocation;
      const totalPrice = p.lineSubtotal - totalLineDiscount;

      tx.update(p.ref, {
        quantity: p.currentQty - p.line.quantity,
        updatedAt: serverTimestamp(),
      });
      tx.set(p.saleRef, {
        invoiceId,
        productId: p.line.productId,
        productName: p.productData.name,
        category: p.productData.category,
        gender: p.productData.gender,
        brand: p.productData.brand || null,
        quantitySold: p.line.quantity,
        pricePerUnit: p.line.pricePerUnit,
        costPriceAtSale:
          typeof p.productData.costPrice === "number" ? p.productData.costPrice : null,
        subtotal: p.lineSubtotal,
        discountType:
          totalLineDiscount > 0
            ? p.line.lineDiscountType ||
              (options.orderDiscountType === "percentage" ? "percentage" : "fixed")
            : null,
        discountValue:
          totalLineDiscount > 0 && p.line.lineDiscountValue
            ? p.line.lineDiscountValue
            : null,
        discountAmount: totalLineDiscount || null,
        totalPrice,
        saleDate: options.customDate ? Timestamp.fromDate(options.customDate) : serverTimestamp(),
        isReturned: false,
        returnedAt: null,
        returnedQuantity: null,
        note: options.note || null,
      });
      saleIds.push(p.saleRef.id);
    }

    return { invoiceId, saleIds, snapshots: pre };
  });

  // Fire history events outside the transaction
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const snap = (result as any).snapshots[i];
    void recordHistoryEvent({
      productId: line.productId,
      productName: snap.productData.name,
      type: "sold",
      delta: -line.quantity,
      quantityAfter: snap.currentQty - line.quantity,
    });
  }

  return { invoiceId: result.invoiceId, saleIds: result.saleIds };
}

export async function updateSale(
  saleId: string,
  updates: {
    quantitySold?: number;
    pricePerUnit?: number;
    discountType?: DiscountType | null;
    discountValue?: number | null;
    note?: string;
    saleDate?: Date;
  }
): Promise<void> {
  const saleRef = doc(db, "sales", saleId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(saleRef);
    if (!snap.exists()) throw new Error("البيع غير موجود");
    const data = snap.data();

    const productRef = doc(db, "products", data.productId);
    const productSnap = await tx.get(productRef);

    const oldQty = data.quantitySold as number;
    const newQty = updates.quantitySold ?? oldQty;
    const newPrice = updates.pricePerUnit ?? (data.pricePerUnit as number);
    const newDiscType =
      updates.discountType === undefined
        ? (data.discountType as DiscountType | null | undefined)
        : updates.discountType;
    const newDiscVal =
      updates.discountValue === undefined
        ? (data.discountValue as number | null | undefined)
        : updates.discountValue;

    const subtotal = newQty * newPrice;
    let discountAmount = 0;
    if (newDiscType && typeof newDiscVal === "number" && newDiscVal > 0) {
      discountAmount =
        newDiscType === "percentage"
          ? Math.round((subtotal * newDiscVal) / 100)
          : newDiscVal;
    }
    discountAmount = Math.min(discountAmount, subtotal);
    const totalPrice = subtotal - discountAmount;

    // Quantity diff -> stock change
    if (productSnap.exists() && newQty !== oldQty) {
      const currentStock = (productSnap.data().quantity as number) ?? 0;
      const stockDelta = oldQty - newQty;
      const nextStock = Math.max(0, currentStock + stockDelta);
      tx.update(productRef, {
        quantity: nextStock,
        updatedAt: serverTimestamp(),
      });
    }

    const patch: Record<string, unknown> = {
      quantitySold: newQty,
      pricePerUnit: newPrice,
      subtotal,
      discountType: newDiscType ?? null,
      discountValue: newDiscVal ?? null,
      discountAmount: discountAmount || null,
      totalPrice,
    };
    if (updates.note !== undefined) patch.note = updates.note || null;
    if (updates.saleDate) patch.saleDate = Timestamp.fromDate(updates.saleDate);

    tx.update(saleRef, patch);
  });
}

export async function voidSale(saleId: string): Promise<void> {
  const saleRef = doc(db, "sales", saleId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(saleRef);
    if (!snap.exists()) throw new Error("البيع غير موجود");
    const data = snap.data();
    if (data.isReturned) {
      tx.delete(saleRef);
      return;
    }
    const productRef = doc(db, "products", data.productId);
    const productSnap = await tx.get(productRef);
    if (productSnap.exists()) {
      const currentQty = (productSnap.data().quantity as number) ?? 0;
      tx.update(productRef, {
        quantity: currentQty + (data.quantitySold as number),
        updatedAt: serverTimestamp(),
      });
    }
    tx.delete(saleRef);
  });
}

export async function recordReturn(
  saleId: string,
  productId: string,
  returnedQuantity: number,
  reason: string
): Promise<void> {
  const productRef = doc(db, "products", productId);
  const saleRef = doc(db, "sales", saleId);
  const returnRef = doc(collection(db, "returns"));

  await runTransaction(db, async (transaction) => {
    const productSnap = await transaction.get(productRef);
    if (!productSnap.exists()) {
      throw new Error("المنتج غير موجود");
    }

    const saleSnap = await transaction.get(saleRef);
    if (!saleSnap.exists()) {
      throw new Error("البيع غير موجود");
    }

    const currentQty = productSnap.data().quantity;
    const saleData = saleSnap.data();

    transaction.update(productRef, {
      quantity: currentQty + returnedQuantity,
      updatedAt: serverTimestamp(),
    });

    transaction.update(saleRef, {
      isReturned: true,
      returnedAt: serverTimestamp(),
      returnedQuantity,
    });

    transaction.set(returnRef, {
      saleId,
      productId,
      productName: saleData.productName,
      returnedQuantity,
      returnDate: serverTimestamp(),
      reason,
    });
  });
}

export function subscribeToReturns(callback: (returns: Return[]) => void): () => void {
  const returnsRef = collection(db, "returns");
  const q = query(returnsRef, orderBy("returnDate", "desc"));
  
  const unsubscribe = onSnapshot(q, (snapshot) => {
    const returns: Return[] = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        saleId: data.saleId,
        productId: data.productId,
        productName: data.productName,
        returnedQuantity: data.returnedQuantity,
        returnDate: convertTimestamp(data.returnDate as Timestamp),
        reason: data.reason,
      };
    });
    callback(returns);
  });
  
  return unsubscribe;
}