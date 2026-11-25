/**
 * F6 — reference-resolver tests.
 *
 * These lock down the positional / pronoun detection patterns for Arabic AND
 * English, plus the safety rules: stale references, cross-branch attempts,
 * pronoun-without-selection ambiguity.
 */
import { describe, expect, it } from "vitest";

import { resolveReference } from "@/lib/ai/context/resolver";
import type { ConversationContext, EntityReference } from "@/lib/ai/context/types";

function mkRef(overrides: Partial<EntityReference> = {}): EntityReference {
  return {
    entityType: "product",
    entityId: `00000000-0000-0000-0000-00000000000${overrides.entityId ?? "1"}`,
    displayName: "Musk Rumman",
    branchId: "branch-A",
    turnId: 1,
    capturedAt: new Date().toISOString(),
    confidence: "HIGH",
    source: "search_products",
    snapshot: { price: 2200, quantity: 2 },
    ...overrides,
  };
}

function mkCtx(overrides: Partial<ConversationContext> = {}): ConversationContext {
  return {
    conversationId: "c-1",
    tenantId: "t-1",
    userId: "u-1",
    branchId: "branch-A",
    locale: "en",
    turnCount: 3,
    lastCandidateSet: null,
    selectedEntity: null,
    recentWrites: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/* ─────────────────── positional — English ─────────────────────────────── */

describe("positional (English)", () => {
  const two = [
    mkRef({ entityId: "a", displayName: "First" }),
    mkRef({ entityId: "b", displayName: "Second" }),
  ];
  const ctx = mkCtx({ lastCandidateSet: { query: "x", entityType: "product", candidates: two, turnId: 3, capturedAt: "" } });

  it("resolves 'the second one'", () => {
    const r = resolveReference({ userText: "How much is the second one?", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entity.displayName).toBe("Second");
  });

  it("resolves 'the first product'", () => {
    const r = resolveReference({ userText: "show the first product details", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entity.displayName).toBe("First");
  });

  it("resolves 'the last one'", () => {
    const r = resolveReference({ userText: "pick the last one", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entity.displayName).toBe("Second");
  });

  it("returns unresolved when position is out of range", () => {
    const r = resolveReference({ userText: "show the fifth one", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("unresolved");
  });

  it("returns unresolved when no candidate set exists", () => {
    const r = resolveReference({ userText: "the second one", context: mkCtx(), currentBranchId: "branch-A" });
    expect(r.kind).toBe("unresolved");
  });
});

/* ─────────────────── positional — Arabic ──────────────────────────────── */

describe("positional (Arabic)", () => {
  const two = [
    mkRef({ entityId: "a", displayName: "الأول" }),
    mkRef({ entityId: "b", displayName: "الثاني" }),
  ];
  const ctx = mkCtx({ lastCandidateSet: { query: "x", entityType: "product", candidates: two, turnId: 3, capturedAt: "" } });

  it("resolves 'التاني'", () => {
    const r = resolveReference({ userText: "التاني بكام؟", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entity.displayName).toBe("الثاني");
  });

  it("resolves 'الثاني منهم'", () => {
    const r = resolveReference({ userText: "الثاني منهم سعره كم؟", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entity.displayName).toBe("الثاني");
  });

  it("resolves 'الأول'", () => {
    const r = resolveReference({ userText: "عايز الأول", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entity.displayName).toBe("الأول");
  });

  it("resolves 'الأخير'", () => {
    const r = resolveReference({ userText: "الأخير", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entity.displayName).toBe("الثاني");
  });
});

/* ─────────────────── pronouns — English ───────────────────────────────── */

describe("pronouns (English)", () => {
  const selected = mkRef();
  const ctx = mkCtx({ selectedEntity: selected });

  it("resolves 'its price' to selectedEntity", () => {
    const r = resolveReference({ userText: "what's its price?", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("resolved");
  });

  it("resolves 'change it' to selectedEntity", () => {
    const r = resolveReference({ userText: "change its quantity to 5", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("resolved");
  });

  it("returns unresolved when no selection + no candidate set", () => {
    const r = resolveReference({ userText: "set it to 5", context: mkCtx(), currentBranchId: "branch-A" });
    expect(r.kind).toBe("unresolved");
  });

  it("returns ambiguous when pronoun + multi-candidate set + no selection", () => {
    const two = [mkRef({ entityId: "a" }), mkRef({ entityId: "b" })];
    const c = mkCtx({ lastCandidateSet: { query: "x", entityType: "product", candidates: two, turnId: 3, capturedAt: "" } });
    const r = resolveReference({ userText: "set its price to 1000", context: c, currentBranchId: "branch-A" });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(2);
  });

  it("resolves pronoun to the only candidate when candidate set has size 1", () => {
    const one = [mkRef({ entityId: "a" })];
    const c = mkCtx({ lastCandidateSet: { query: "x", entityType: "product", candidates: one, turnId: 3, capturedAt: "" } });
    const r = resolveReference({ userText: "its price", context: c, currentBranchId: "branch-A" });
    expect(r.kind).toBe("resolved");
  });
});

/* ─────────────────── pronouns — Arabic ────────────────────────────────── */

describe("pronouns (Arabic)", () => {
  const selected = mkRef();
  const ctx = mkCtx({ selectedEntity: selected });

  it("resolves 'سعره'", () => {
    const r = resolveReference({ userText: "سعره كم؟", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("resolved");
  });

  it("resolves 'كميته'", () => {
    const r = resolveReference({ userText: "كميته 5", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("resolved");
  });

  it("resolves 'ده' as product reference", () => {
    const r = resolveReference({ userText: "ده كام؟", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("resolved");
  });

  it("resolves 'منه' (clitic)", () => {
    const r = resolveReference({ userText: "عندي منه كام؟", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("resolved");
  });
});

/* ─────────────────── safety: staleness ────────────────────────────────── */

describe("staleness", () => {
  it("refuses a stale candidate set (older than 5 turns)", () => {
    const old = mkRef();
    const ctx = mkCtx({
      turnCount: 20,
      lastCandidateSet: { query: "x", entityType: "product", candidates: [old], turnId: 1, capturedAt: "" },
    });
    const r = resolveReference({ userText: "the first one", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("unresolved");
    if (r.kind === "unresolved") expect(r.reason).toContain("stale");
  });

  it("refuses a stale selected entity", () => {
    const old = mkRef({ turnId: 1 });
    const ctx = mkCtx({ turnCount: 20, selectedEntity: old });
    const r = resolveReference({ userText: "its price?", context: ctx, currentBranchId: "branch-A" });
    expect(r.kind).toBe("unresolved");
  });
});

/* ─────────────────── no false positives on plain prose ────────────────── */

describe("no false positives", () => {
  it("returns unresolved for prose with no reference pattern", () => {
    const ctx = mkCtx({ selectedEntity: mkRef() });
    const r = resolveReference({
      userText: "Tell me a fun fact about perfume manufacturing.",
      context: ctx,
      currentBranchId: "branch-A",
    });
    expect(r.kind).toBe("unresolved");
  });
});

/* ─────────────────── F7: positional (Portuguese) ──────────────────────── */

describe("positional (Portuguese)", () => {
  const two = [
    mkRef({ entityId: "a", displayName: "Primeiro" }),
    mkRef({ entityId: "b", displayName: "Segundo" }),
  ];
  const ctx = mkCtx({
    lastCandidateSet: {
      query: "x",
      entityType: "product",
      candidates: two,
      turnId: 3,
      capturedAt: "",
    },
  });

  it("resolves 'o segundo'", () => {
    const r = resolveReference({
      userText: "qual o preço do segundo produto?",
      context: ctx,
      currentBranchId: "branch-A",
    });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entity.displayName).toBe("Segundo");
  });

  it("resolves 'o último'", () => {
    const r = resolveReference({
      userText: "mostre o último",
      context: ctx,
      currentBranchId: "branch-A",
    });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entity.displayName).toBe("Segundo");
  });
});

/* ─────────────────── F7: positional (French) ──────────────────────────── */

describe("positional (French)", () => {
  const two = [
    mkRef({ entityId: "a", displayName: "Premier" }),
    mkRef({ entityId: "b", displayName: "Deuxième" }),
  ];
  const ctx = mkCtx({
    lastCandidateSet: {
      query: "x",
      entityType: "product",
      candidates: two,
      turnId: 3,
      capturedAt: "",
    },
  });

  it("resolves 'le deuxième'", () => {
    const r = resolveReference({
      userText: "quel est le prix du deuxième ?",
      context: ctx,
      currentBranchId: "branch-A",
    });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entity.displayName).toBe("Deuxième");
  });

  it("resolves 'le dernier'", () => {
    const r = resolveReference({
      userText: "montrez le dernier",
      context: ctx,
      currentBranchId: "branch-A",
    });
    expect(r.kind).toBe("resolved");
  });
});

/* ─────────────────── F7: positional (Spanish) ─────────────────────────── */

describe("positional (Spanish)", () => {
  const two = [
    mkRef({ entityId: "a", displayName: "Primero" }),
    mkRef({ entityId: "b", displayName: "Segundo" }),
  ];
  const ctx = mkCtx({
    lastCandidateSet: {
      query: "x",
      entityType: "product",
      candidates: two,
      turnId: 3,
      capturedAt: "",
    },
  });

  it("resolves 'el segundo'", () => {
    const r = resolveReference({
      userText: "cuál es el precio del segundo producto?",
      context: ctx,
      currentBranchId: "branch-A",
    });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entity.displayName).toBe("Segundo");
  });

  it("resolves 'el último'", () => {
    const r = resolveReference({
      userText: "muéstrame el último",
      context: ctx,
      currentBranchId: "branch-A",
    });
    expect(r.kind).toBe("resolved");
  });
});

/* ─────────────────── F7: pronouns (Portuguese/French/Spanish) ──────────── */

describe("pronouns — Portuguese", () => {
  const ctx = mkCtx({ selectedEntity: mkRef() });

  it("resolves 'seu preço'", () => {
    const r = resolveReference({
      userText: "qual é seu preço?",
      context: ctx,
      currentBranchId: "branch-A",
    });
    expect(r.kind).toBe("resolved");
  });

  it("resolves 'o estoque dele'", () => {
    const r = resolveReference({
      userText: "mostre o estoque dele",
      context: ctx,
      currentBranchId: "branch-A",
    });
    expect(r.kind).toBe("resolved");
  });

  it("resolves 'mude seu preço'", () => {
    const r = resolveReference({
      userText: "mude seu preço para 2500",
      context: ctx,
      currentBranchId: "branch-A",
    });
    expect(r.kind).toBe("resolved");
  });
});

describe("pronouns — French", () => {
  const ctx = mkCtx({ selectedEntity: mkRef() });

  it("resolves 'son prix'", () => {
    const r = resolveReference({
      userText: "quel est son prix ?",
      context: ctx,
      currentBranchId: "branch-A",
    });
    expect(r.kind).toBe("resolved");
  });

  it("resolves 'changez son prix'", () => {
    const r = resolveReference({
      userText: "changez son prix à 2500",
      context: ctx,
      currentBranchId: "branch-A",
    });
    expect(r.kind).toBe("resolved");
  });
});

describe("pronouns — Spanish", () => {
  const ctx = mkCtx({ selectedEntity: mkRef() });

  it("resolves 'su precio'", () => {
    const r = resolveReference({
      userText: "cuál es su precio?",
      context: ctx,
      currentBranchId: "branch-A",
    });
    expect(r.kind).toBe("resolved");
  });

  it("resolves 'cambia su precio'", () => {
    const r = resolveReference({
      userText: "cambia su precio a 2500",
      context: ctx,
      currentBranchId: "branch-A",
    });
    expect(r.kind).toBe("resolved");
  });
});
