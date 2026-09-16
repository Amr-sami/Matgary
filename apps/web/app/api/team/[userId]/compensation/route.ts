import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  createCompensation,
  listCompensationHistory,
} from "@/lib/repo/payroll";
import { logActivity } from "@/lib/repo/activity";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const { userId } = await params;
  const history = await listCompensationHistory(r.ctx.tenantId, userId);
  return NextResponse.json({ history });
}

const postSchema = z
  .object({
    payType: z.enum(["fixed", "hourly", "hybrid"]),
    baseSalaryMonthly: z.number().nonnegative().nullable().optional(),
    hourlyRate: z.number().nonnegative().nullable().optional(),
    standardMonthlyHours: z.number().nonnegative().nullable().optional(),
    effectiveFrom: z.string().datetime().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.payType === "fixed" && (v.baseSalaryMonthly ?? 0) <= 0) {
      ctx.addIssue({
        code: "custom",
        message: "أدخل الراتب الأساسي للنوع الثابت",
      });
    }
    if (v.payType === "hourly" && (v.hourlyRate ?? 0) <= 0) {
      ctx.addIssue({
        code: "custom",
        message: "أدخل الأجر بالساعة للنوع بالساعة",
      });
    }
    if (
      v.payType === "hybrid" &&
      ((v.baseSalaryMonthly ?? 0) <= 0 || (v.hourlyRate ?? 0) <= 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "للنوع المختلط أدخل الراتب الأساسي وأجر الساعة",
      });
    }
  });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const { userId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  const row = await createCompensation(r.ctx.tenantId, {
    employeeId: userId,
    payType: parsed.data.payType,
    baseSalaryMonthly: parsed.data.baseSalaryMonthly ?? null,
    hourlyRate: parsed.data.hourlyRate ?? null,
    standardMonthlyHours: parsed.data.standardMonthlyHours ?? null,
    effectiveFrom: parsed.data.effectiveFrom
      ? new Date(parsed.data.effectiveFrom)
      : new Date(),
    createdByUserId: r.ctx.userId,
  });
  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "team.compensation_set",
    category: "team",
    entityType: "user",
    entityId: userId,
    metadata: {
      payType: parsed.data.payType,
      baseSalaryMonthly: parsed.data.baseSalaryMonthly ?? null,
      hourlyRate: parsed.data.hourlyRate ?? null,
    },
  });
  return NextResponse.json({ row }, { status: 201 });
}
