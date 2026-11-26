import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Check = { ok: true; status: string } | { ok: false; err: string };

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timeout after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

async function checkDb(): Promise<Check> {
  try {
    await withTimeout(db.execute(sql`select 1`), 1000, "db");
    return { ok: true, status: "ok" };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  }
}

async function checkRedis(): Promise<Check> {
  if (!redis) return { ok: true, status: "disabled" };
  try {
    await withTimeout(redis.ping(), 1000, "redis");
    return { ok: true, status: "ok" };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET() {
  const [dbRes, redisRes] = await Promise.all([checkDb(), checkRedis()]);
  const ready = dbRes.ok && redisRes.ok;
  return NextResponse.json(
    {
      status: ready ? "ready" : "not-ready",
      db: dbRes.ok ? dbRes.status : "fail",
      redis: redisRes.ok ? redisRes.status : "fail",
    },
    { status: ready ? 200 : 503 },
  );
}
