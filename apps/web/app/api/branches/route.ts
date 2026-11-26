// LEGACY — branches were removed as a product concept.
//
// GET: returns the tenant's single branch. Historically this route listed
// every branch in the tenant and let the owner pick one. It now returns a
// one-element array so callers like the legacy `useBranches` hook keep
// working during the transition.
//
// POST: creation is disabled. Nothing in the UI can reach it anymore; any
// stray request gets a 410 Gone so we hear about it in logs.

import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { resolveActiveBranch } from "@/lib/api/branch-context";
import { listBranches } from "@/lib/repo/branches";

export const runtime = "nodejs";

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;

  const [all, current] = await Promise.all([
    listBranches(r.ctx.tenantId),
    resolveActiveBranch(r.ctx),
  ]);

  // Collapse to the active (primary) branch if present. Everything else
  // sits in the DB as historical residue — never surfaced.
  const single = current ? all.filter((b) => b.id === current.branchId) : [];

  return NextResponse.json({
    data: single,
    currentBranchId: current?.branchId ?? null,
  });
}

export async function POST() {
  return NextResponse.json(
    { error: "Branches have been removed. Storo is single-location per tenant." },
    { status: 410 },
  );
}
