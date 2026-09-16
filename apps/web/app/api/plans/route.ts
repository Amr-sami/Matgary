// Public read for the landing page + /billing. No auth. Cached at the edge
// for 60 seconds via Cache-Control headers (the typed fallback inside
// getPlans() guarantees we never serve a blank pricing page even when the
// DB hiccups).

import { NextResponse } from "next/server";
import { getPlans } from "@/lib/plans";

export const runtime = "nodejs";

export async function GET() {
  const data = await getPlans();
  return NextResponse.json(
    { data },
    {
      headers: {
        // Edge: 60s fresh, 120s stale-while-revalidate. Browsers don't
        // cache (we want them to react quickly to an admin edit).
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120, max-age=0",
      },
    },
  );
}
