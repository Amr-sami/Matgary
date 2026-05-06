// File storage for sensitive user uploads (employee photos, ID scans, etc.)
//
// Layout: <repo>/uploads/<tenantId>/<uuid>.<ext>
// The leading <tenantId> segment lets the serving route authorize by checking
// that the requester belongs to that tenant — no DB lookup needed for ACL.
// Files are NOT under /public; reaching them must go through /api/uploads/*
// which enforces auth and the tenant match.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const UPLOADS_ROOT = path.join(process.cwd(), "uploads");

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const MAX_BYTES = 3 * 1024 * 1024; // 3 MB

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

export interface SavedUpload {
  /** Path stored in DB and used in `/api/uploads/team/<relativePath>`. */
  relativePath: string;
  mime: string;
  bytes: number;
}

export async function saveTenantUpload(
  tenantId: string,
  file: { mime: string; buffer: Buffer },
): Promise<SavedUpload> {
  if (!ALLOWED_MIME.has(file.mime)) {
    throw new UploadValidationError("نوع الملف غير مدعوم — استخدم JPG أو PNG أو WebP");
  }
  if (file.buffer.byteLength > MAX_BYTES) {
    throw new UploadValidationError("الملف كبير جداً — الحد الأقصى 3 ميجابايت");
  }

  const ext = EXT_BY_MIME[file.mime];
  const id = crypto.randomUUID();
  const filename = `${id}.${ext}`;
  const dir = path.join(UPLOADS_ROOT, tenantId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), file.buffer);

  return {
    relativePath: `${tenantId}/${filename}`,
    mime: file.mime,
    bytes: file.buffer.byteLength,
  };
}

/**
 * Resolve a stored relative path to an absolute filesystem path, verifying it
 * stays inside the tenant's directory. Returns null if the path is malformed
 * or escapes the upload root (defense against `../` traversal).
 */
export function resolveTenantUpload(
  tenantId: string,
  relativePath: string,
): string | null {
  // Strip any leading slashes so `/<tenant>/x.jpg` and `<tenant>/x.jpg` both work.
  const cleaned = relativePath.replace(/^\/+/, "");
  const tenantDir = path.join(UPLOADS_ROOT, tenantId);
  const absolute = path.resolve(tenantDir, path.relative(tenantId, cleaned));
  // Must be inside tenantDir.
  if (!absolute.startsWith(tenantDir + path.sep) && absolute !== tenantDir) {
    return null;
  }
  return absolute;
}

export async function deleteTenantUpload(
  tenantId: string,
  relativePath: string,
): Promise<void> {
  const abs = resolveTenantUpload(tenantId, relativePath);
  if (!abs) return;
  try {
    await fs.unlink(abs);
  } catch (err) {
    // Ignore missing files — best-effort cleanup.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function mimeFromPath(relativePath: string): string {
  const ext = relativePath.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}
