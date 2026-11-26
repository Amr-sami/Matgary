import { NextResponse } from "next/server";

import { buildAssetLinks } from "../_lib/app-links";

// Served at /.well-known/assetlinks.json. Android's Digital Asset Links
// verifier fetches it over HTTPS at install time (and on demand via
// `adb shell pm verify-app-links`); it must be `application/json`, must not
// redirect, and every fingerprint listed must belong to a certificate the
// installed APK is actually signed with — hence Play App Signing's key AND the
// EAS upload/debug keys for internal builds.
//
// Reads ANDROID_SHA256_CERT_FINGERPRINTS at request time. Missing/malformed →
// 404 + hint, never a placeholder.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const built = buildAssetLinks(process.env.ANDROID_SHA256_CERT_FINGERPRINTS);
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
      "Cache-Control": "public, max-age=3600",
    },
  });
}
