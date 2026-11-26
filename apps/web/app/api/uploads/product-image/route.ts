import { NextRequest, NextResponse } from "next/server";
import {
  requirePermissionAudited,
  requireTenant,
  requireTenantWithBranch,
} from "@/lib/api/auth-helpers";
import { saveTenantUpload, UploadValidationError } from "@/lib/uploads";
import { saveShopSettings, sanitizeLogoDataUri } from "@/lib/repo/settings";

/**
 * POST /api/uploads/product-image — multipart `file` (jpg/png/webp, ≤ 3 MB;
 * magic bytes are sniffed by saveTenantUpload). Mirrors /api/uploads/team but
 * the file lands under `<tenant>/products/` so the public read route below can
 * never reach an employee photo, and the response is `{ url }` — a relative
 * path the client prefixes with its API base and stores on products.imageUrl.
 *
 * `kind=receipt-logo` (form field) reuses the same validation for the receipt
 * logo, but writes it as a data URI into settings.receiptLogoUrl (the historic
 * logo_path column) because receipts render as self-contained HTML/PDF on the
 * web, in WhatsApp and inside expo-print — none of which can follow an
 * authenticated or even a relative URL. That path is owner-only and capped by
 * the existing 256 KB data-URI limit.
 */
/**
 * Largest multipart body we are willing to buffer: the 3 MB file cap from
 * apps/web/lib/uploads.ts plus room for the boundary and the `kind` part.
 */
const MAX_BODY_BYTES = 3 * 1024 * 1024 + 16 * 1024;

export async function POST(req: NextRequest) {
  // Authenticate BEFORE touching the body. App Router handlers have no body
  // limit and the 3 MB cap only runs after buffering, so an anonymous caller
  // must not be able to make the server read a multipart body at all. The
  // per-kind permission / role check follows once the form says which kind.
  const auth = await requireTenant();
  if (!auth.ok) return auth.response;
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "الملف كبير جداً — الحد الأقصى 3 ميجابايت" },
      { status: 413 },
    );
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "ملف غير صالح" }, { status: 400 });
  }
  const kind = form.get("kind") === "receipt-logo" ? "receipt-logo" : "product";

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "أرفق ملف الصورة" }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());

  if (kind === "receipt-logo") return saveReceiptLogo(file.type, buffer);

  const r = await requirePermissionAudited("manage_inventory");
  if (!r.ok) return r.response;

  try {
    const saved = await saveTenantUpload(`${r.ctx.tenantId}/products`, {
      mime: file.type,
      buffer,
    });
    return NextResponse.json(
      { url: `/api/uploads/product-image/${saved.relativePath}` },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

const LOGO_MAX_BYTES = 190 * 1024; // base64 of this stays under the 256 KB DTO cap

async function saveReceiptLogo(mime: string, buffer: Buffer) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  if (r.ctx.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
    return NextResponse.json(
      { error: "نوع الملف غير مدعوم — استخدم JPG أو PNG أو WebP" },
      { status: 400 },
    );
  }
  if (buffer.byteLength > LOGO_MAX_BYTES) {
    return NextResponse.json(
      { error: "الشعار كبير جداً — الحد الأقصى 190 كيلوبايت" },
      { status: 400 },
    );
  }
  const dataUri = sanitizeLogoDataUri(`data:${mime};base64,${buffer.toString("base64")}`);
  if (!dataUri) {
    return NextResponse.json({ error: "الملف لا يطابق نوعه المُعلَن" }, { status: 400 });
  }
  await saveShopSettings(r.ctx.tenantId, r.ctx.branchId, { receiptLogoUrl: dataUri });
  return NextResponse.json({ url: dataUri }, { status: 201 });
}
