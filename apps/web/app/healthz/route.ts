import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VERSION =
  process.env.APP_VERSION ||
  process.env.GIT_SHA ||
  process.env.npm_package_version ||
  "dev";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    version: VERSION,
  });
}
