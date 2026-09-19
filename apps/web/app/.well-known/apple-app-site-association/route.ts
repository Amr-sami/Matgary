import { NextResponse } from "next/server";

import { buildAppleAppSiteAssociation } from "../_lib/app-links";

// Served at /.well-known/apple-app-site-association (no extension — Apple
// requires exactly this path). Apple's CDN fetches it over HTTPS, follows no
// redirects, and needs `Content-Type: application/json`; the middleware lets
// /.well-known/* through unauthenticated (PUBLIC_PREFIXES).
//
// Reads APPLE_TEAM_ID at request time so a deploy can flip it on without a
// rebuild. Missing/malformed → 404 + hint: never a placeholder Team ID.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const built = buildAppleAppSiteAssociation(process.env.APPLE_TEAM_ID);
  if (!built.ok) {
    return NextResponse.json(
      { error: "not_configured", hint: built.hint },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(built.body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Apple re-fetches on install/update at most every few days anyway;
      // an hour keeps a Team-ID fix from being stuck behind our own CDN.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
