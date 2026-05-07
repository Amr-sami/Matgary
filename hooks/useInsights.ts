"use client";

import { useMemo } from "react";
import { useSales } from "./useSales";
import { useReturns } from "./useReturns";
import { useProducts } from "./useProducts";
import { useExpenses } from "./useExpenses";
import { startOfDay, endOfDay, getThisMonthRange, isBetween } from "@/lib/utils";
import { startOfMonth, subMonths, format, eachDayOfInterval, isSameDay } from "date-fns";
import type { Sale, Return, Product } from "@/lib/types";

export interface InsightsWindow {
  /** Start of the analysed period, inclusive. Undefined = open-ended. */
  from?: Date;
  /** End of the analysed period, inclusive. Undefined = now. */
  to?: Date;
}

export function useInsights(window?: InsightsWindow) {
  const { sales, loading: salesLoading } = useSales();
  const { returns, loading: returnsLoading } = useReturns();
  const { products, loading: productsLoading } = useProducts();
  const { expenses, loading: expensesLoading } = useExpenses();

  const windowFrom = window?.from;
  const windowTo = window?.to;
  // Stable dependency keys so useMemo doesn't re-run on every render due to
  // new Date instances passed in by the parent.
  const fromKey = windowFrom ? windowFrom.getTime() : null;
  const toKey = windowTo ? windowTo.getTime() : null;

  const data = useMemo(() => {
    if (salesLoading || returnsLoading || productsLoading || expensesLoading) return null;

    const now = new Date();

    // Resolve the active analysis window. When the caller passes one we honour
    // it; otherwise default to "this month" for revenue / "all time" for the
    // bottom totals (preserving the original page behavior).
    const hasWindow = !!(windowFrom || windowTo);
    const fromDate = windowFrom ?? new Date(0);
    const toDate = windowTo ?? endOfDay(now);
    const inWindow = (d: Date) => d >= fromDate && d <= toDate;

    // 0. Product Cost Map for Profit Calculation
    const productCostMap: Record<string, number> = {};
    products.forEach(p => {
      productCostMap[p.id] = p.costPrice || 0;
    });

    // 1. Current vs prior period revenue.
    //    - With a window: compare the window to the immediately preceding
    //      window of the same length.
    //    - Without a window: compare current calendar month to last month
    //      (preserves the original page behaviour).
    let currentRevenue: number;
    let lastRevenue: number;
    if (hasWindow && windowFrom) {
      const winSales = sales.filter((s) => inWindow(new Date(s.saleDate)));
      currentRevenue = winSales.reduce((sum, s) => sum + s.totalPrice, 0);
      const lengthMs = toDate.getTime() - fromDate.getTime();
      const prevTo = new Date(fromDate.getTime() - 1);
      const prevFrom = new Date(prevTo.getTime() - lengthMs);
      lastRevenue = sales
        .filter((s) => {
          const d = new Date(s.saleDate);
          return d >= prevFrom && d <= prevTo;
        })
        .reduce((sum, s) => sum + s.totalPrice, 0);
    } else {
      const currentMonthStart = startOfMonth(now);
      const lastMonthStart = startOfMonth(subMonths(now, 1));
      const lastMonthEnd = endOfDay(new Date(currentMonthStart.getTime() - 1));
      const currentMonthSales = sales.filter(s => new Date(s.saleDate) >= currentMonthStart);
      const lastMonthSales = sales.filter(s => {
        const d = new Date(s.saleDate);
        return d >= lastMonthStart && d <= lastMonthEnd;
      });
      currentRevenue = currentMonthSales.reduce((sum, s) => sum + s.totalPrice, 0);
      lastRevenue = lastMonthSales.reduce((sum, s) => sum + s.totalPrice, 0);
    }
    const revenueGrowth =
      lastRevenue === 0
        ? currentRevenue > 0
          ? 100
          : 0
        : ((currentRevenue - lastRevenue) / lastRevenue) * 100;

    // 2. Revenue Trend
    //    - With a window: span the window (daily buckets, capped at 90 days for
    //      readability).
    //    - Without a window: last 30 days (preserves original page behaviour).
    const TREND_MAX_DAYS = 90;
    const trendStart = hasWindow
      ? startOfDay(windowFrom ?? new Date(toDate.getTime() - 29 * 24 * 60 * 60 * 1000))
      : (() => {
          const d = startOfDay(new Date());
          d.setDate(d.getDate() - 29);
          return d;
        })();
    const trendEnd = hasWindow ? endOfDay(toDate) : endOfDay(now);
    const totalDays =
      Math.floor((trendEnd.getTime() - trendStart.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    const cappedStart =
      totalDays > TREND_MAX_DAYS
        ? new Date(trendEnd.getTime() - (TREND_MAX_DAYS - 1) * 24 * 60 * 60 * 1000)
        : trendStart;
    const days = eachDayOfInterval({ start: cappedStart, end: trendEnd });
    const trendData = days.map((day) => {
      const daySales = sales.filter((s) => isSameDay(new Date(s.saleDate), day));
      return {
        date: format(day, "MMM dd"),
        revenue: daySales.reduce((sum, s) => sum + s.totalPrice, 0),
        count: daySales.length,
      };
    });

    // 3. Sales / returns / expenses constrained to the window for the totals
    //    block. With no window we keep the all-time totals.
    const winSales = hasWindow ? sales.filter((s) => inWindow(new Date(s.saleDate))) : sales;
    const winReturns = hasWindow
      ? returns.filter((r) => inWindow(new Date(r.returnDate)))
      : returns;
    const winExpenses = hasWindow
      ? expenses.filter((e) => inWindow(new Date(e.date)))
      : expenses;

    // 4. Top Products (within window)
    const productSales: Record<string, { id: string; name: string; brand?: string; qty: number; revenue: number }> = {};
    winSales.forEach(s => {
      if (!productSales[s.productId]) {
        productSales[s.productId] = { id: s.productId, name: s.productName, brand: s.brand, qty: 0, revenue: 0 };
      }
      productSales[s.productId].qty += s.quantitySold;
      productSales[s.productId].revenue += s.totalPrice;
    });

    const topProducts = Object.values(productSales)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);

    // 5. Category Performance (within window)
    const categoryData: Record<string, number> = {};
    winSales.forEach(s => {
      categoryData[s.category] = (categoryData[s.category] || 0) + s.totalPrice;
    });

    const categoryChartData = Object.entries(categoryData).map(([name, value]) => ({ name, value }));

    // 6. Financial totals (within window)
    const totalRevenue = winSales.reduce((sum, s) => sum + s.totalPrice, 0);
    const totalCostOfGoods = winSales.reduce((sum, s) => {
      const costPerUnit = productCostMap[s.productId] || 0;
      return sum + (costPerUnit * s.quantitySold);
    }, 0);
    const totalExpenses = winExpenses.reduce((sum, e) => sum + e.amount, 0);
    const totalDiscounts = winSales.reduce((sum, s) => sum + (s.discountAmount || 0), 0);
    const grossProfit = totalRevenue - totalCostOfGoods;
    const netProfit = grossProfit - totalExpenses;

    const potentialRevenue = winSales.reduce((sum, s) => sum + (s.subtotal || s.totalPrice), 0);
    const discountPercent = potentialRevenue === 0 ? 0 : (totalDiscounts / potentialRevenue) * 100;

    return {
      window: hasWindow ? { from: fromDate, to: toDate } : null,
      metrics: {
        currentRevenue,
        lastRevenue,
        revenueGrowth,
        totalRevenue,
        totalCostOfGoods,
        totalExpenses,
        grossProfit,
        netProfit,
        totalDiscounts,
        discountPercent,
        totalSales: winSales.length,
        totalReturns: winReturns.length,
      },
      trendData,
      topProducts,
      categoryChartData,
    };
  }, [sales, returns, products, expenses, salesLoading, returnsLoading, productsLoading, expensesLoading, fromKey, toKey]);

  return { data, loading: salesLoading || returnsLoading || productsLoading || expensesLoading };
}
