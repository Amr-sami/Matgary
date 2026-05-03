import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { listCategories } from "@/lib/repo/catalog";
import { addCategory } from "@/lib/repo/catalog-admin";

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const data = await listCategories(r.ctx.tenantId);
  return NextResponse.json({ data });
}

const createSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/, "key must be lowercase letters, digits, _ or -"),
  label: z.string().min(1).max(80),
  icon: z.string().max(40).optional(),
  position: z.number().int().min(0).optional(),
  hasAttributes: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    const result = await addCategory(r.ctx.tenantId, parsed.data);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error && err.message.includes("duplicate")
            ? "هذا المفتاح مستخدم بالفعل"
            : err instanceof Error
              ? err.message
              : "خطأ",
      },
      { status: 409 },
    );
  }
}
