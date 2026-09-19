// File storage for sensitive user uploads (employee photos, ID scans, etc.)
//
// Layout: <UPLOADS_DIR>/<tenantId>/<uuid>.<ext>
// UPLOADS_DIR defaults to <cwd>/uploads — apps/web/uploads under `next dev`,
// /repo/uploads in the production image, where the Dockerfile runner stage
// pre-creates it owned by the runtime user and docker-compose.prod.yml mounts
// the matgary_uploads named volume on it (launch-readiness §3.1 C1). Set it
// explicitly to put the files anywhere else; a relative value resolves
// against cwd.
// The leading <tenantId> segment lets the serving route authorize by checking
// that the requester belongs to that tenant — no DB lookup needed for ACL.
// Files are NOT under /public; reaching them must go through /api/uploads/*
// which enforces auth and the tenant match.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Absolute root every tenant directory lives under. Read per call rather than
 * frozen at import so UPLOADS_DIR is honoured whenever it is set (tests set it
 * after the module loads) and so the container path is explicit, not inferred
 * from wherever `node apps/web/server.js` happens to be launched.
 *
 * The turbopackIgnore comments matter: `next build` traces every path that
 * reaches an fs call to decide what the standalone output must carry. A path
 * rooted in an env var is unbounded, and Turbopack then traces the WHOLE
 * project into .next/standalone ("Encountered unexpected file in NFT list",
 * with next.config.ts reached through this file). Uploads are runtime data,
 * never build assets, so tracing is switched off on EVERY path expression
 * the root flows through before an fs call — the root itself, the tenant
 * dir, the file join in saveTenantUpload and the resolve in
 * resolveTenantUpload — not only where the env var is read: an un-annotated
 * join/resolve of an ignored value is analysed afresh and re-widens to "any
 * file under the project".
 */
export function getUploadsRoot(): string {
  const configured = process.env.UPLOADS_DIR?.trim();
  if (configured) return path.resolve(/*turbopackIgnore: true*/ configured);
  return path.join(process.cwd(), "uploads");
}

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const MAX_BYTES = 3 * 1024 * 1024; // 3 MB

// H07 — server-side magic-byte sniff. The client-supplied MIME (via
// `file.type`) is taken at face value by the form parser, so a hostile
// upload of a `.exe` claiming `Content-Type: image/jpeg` would otherwise
// land in /uploads. This double-check trusts only the first 12 bytes.
function sniffImageMime(buf: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return "image/png";
  }
  // WebP: RIFF........WEBP (RIFF at 0-3, WEBP at 8-11)
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

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
  // H07 — verify the bytes match the declared MIME. Client-set
  // Content-Type cannot be trusted on its own.
  const sniffed = sniffImageMime(file.buffer);
  if (!sniffed || sniffed !== file.mime) {
    throw new UploadValidationError("الملف لا يطابق نوعه المُعلَن");
  }

  const ext = EXT_BY_MIME[file.mime];
  const id = crypto.randomUUID();
  const filename = `${id}.${ext}`;
  const dir = path.join(/*turbopackIgnore: true*/ getUploadsRoot(), tenantId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(/*turbopackIgnore: true*/ dir, filename), file.buffer);

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
  const tenantDir = path.join(/*turbopackIgnore: true*/ getUploadsRoot(), tenantId);
  const absolute = path.resolve(/*turbopackIgnore: true*/ tenantDir, path.relative(tenantId, cleaned));
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
