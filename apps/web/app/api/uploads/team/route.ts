import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import { saveTenantUpload, UploadValidationError } from "@/lib/uploads";

export async function POST(req: NextRequest) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "ملف غير صالح" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "أرفق ملف الصورة" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const saved = await saveTenantUpload(r.ctx.tenantId, {
      mime: file.type,
      buffer,
    });
    return NextResponse.json({ path: saved.relativePath }, { status: 201 });
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
