// LEGACY — individual branch CRUD removed. Storo has no branches.
// Every method returns 410 Gone so any remaining client receives a clear
// signal in the logs instead of silently succeeding.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const gone = () =>
  NextResponse.json(
    { error: "Branches have been removed. Storo is single-location per tenant." },
    { status: 410 },
  );

export async function GET() {
  return gone();
}
export async function PATCH() {
  return gone();
}
export async function DELETE() {
  return gone();
}
