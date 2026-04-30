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
  Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";
import type { Product, Sale, Return, Category, Gender, DiscountType, Expense, ExpenseCategory } from "./types";

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
}

export async function deleteProduct(productId: string): Promise<void> {
  const productRef = doc(db, "products", productId);
  await deleteDoc(productRef);
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
        createdAt: convertTimestamp(data.createdAt as Timestamp),
        updatedAt: convertTimestamp(data.updatedAt as Timestamp),
      };
    });
    callback(products);
  });
  
  return unsubscribe;
}

export async function recordSale(
  productId: string,
  quantitySold: number,
  pricePerUnit: number,
  note?: string,
  discountType?: DiscountType,
  discountValue?: number
): Promise<string> {
  const productRef = doc(db, "products", productId);
  const saleRef = doc(collection(db, "sales"));

  return await runTransaction(db, async (transaction) => {
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

    transaction.update(productRef, {
      quantity: currentQty - quantitySold,
      updatedAt: serverTimestamp(),
    });

    transaction.set(saleRef, {
      productId,
      productName: productData.name,
      category: productData.category,
      gender: productData.gender,
      brand: productData.brand || null,
      quantitySold,
      pricePerUnit,
      subtotal,
      discountType: discountType || null,
      discountValue: discountValue || null,
      discountAmount: discountAmount || null,
      totalPrice,
      saleDate: serverTimestamp(),
      isReturned: false,
      returnedAt: null,
      returnedQuantity: null,
      note: note || null,
    });

    return saleRef.id;
  });
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