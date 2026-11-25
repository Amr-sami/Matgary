import { listExpenses } from "@/lib/repo/expenses";

import type { Tool } from "./types";
import {
  DATE_FROM_SCHEMA,
  DATE_TO_SCHEMA,
  PERIOD_SCHEMA,
  parseLimit,
  resolveWindow,
} from "./_shared";

/**
 * F10.4 — Expense read tools.
 *
 * Period-scoped roll-ups built on the existing repo helper. All numbers are
 * computed here — the LLM only picks the window + limit.
 */

/* ──────────────────────────── get_expenses_summary ─────────────────── */

export const getExpensesSummary: Tool = {
  name: "get_expenses_summary",
  description:
    "Expenses roll-up for a period: total spend, count, breakdown by category, top individual expenses. Pass a `period` preset OR an explicit `from`+`to` ISO day pair for arbitrary ranges. Use for 'how much did I spend', 'biggest expenses', 'expense breakdown this month'.",
  requiredPermission: "view_expenses",
  parameters: {
    type: "object",
    properties: {
      period: PERIOD_SCHEMA,
      from: DATE_FROM_SCHEMA,
      to: DATE_TO_SCHEMA,
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 30,
        description: "Max top-individual expenses to return (default 10).",
      },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const resolved = resolveWindow(args);
    const limit = parseLimit(args.limit, 10, 30);
    const w = resolved.window;
    const since = w?.from;
    // Tenant-scoped only (Storo has no branch feature). listExpenses' second
    // arg is the legacy branch filter — passing null disables it so every
    // tenant row is included.
    const rows = await listExpenses(ctx.tenantId, null, since);

    // Period 'all' or no window → listExpenses returned everything; otherwise
    // the repo filter already scoped to since. Still cap the upper bound for
    // 'today'/'yesterday' etc. so an open-ended future-dated row doesn't leak.
    const scoped = w
      ? rows.filter((e) => e.date <= w.to)
      : rows;

    const total = scoped.reduce((s, e) => s + e.amount, 0);
    const byCategory = new Map<string, { total: number; count: number }>();
    for (const e of scoped) {
      const cur = byCategory.get(e.category) ?? { total: 0, count: 0 };
      cur.total += e.amount;
      cur.count += 1;
      byCategory.set(e.category, cur);
    }
    const categories = Array.from(byCategory.entries())
      .map(([category, v]) => ({
        category,
        total: round2(v.total),
        count: v.count,
      }))
      .sort((a, b) => b.total - a.total);

    const topIndividual = [...scoped]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, limit)
      .map((e) => ({
        id: e.id,
        title: e.title,
        amount: e.amount,
        category: e.category,
        supplierId: e.supplierId,
        date: e.date.toISOString(),
        note: e.note ?? null,
      }));

    return {
      ok: true,
      data: {
        period: resolved.period,
        currency: "EGP",
        window: w
          ? { from: w.from.toISOString(), to: w.to.toISOString() }
          : null,
        total: round2(total),
        count: scoped.length,
        categories,
        topIndividual,
      },
    };
  },
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
