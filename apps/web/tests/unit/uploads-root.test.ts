/**
 * Locks lib/uploads.ts root resolution (launch-readiness §3.1 C1).
 *
 * The production image runs `node apps/web/server.js` from WORKDIR /repo with
 * UPLOADS_DIR=/repo/uploads and the matgary_uploads named volume mounted
 * there. If the root silently fell back to cwd/uploads, or ignored the env,
 * photos would land outside the volume and vanish on the next rebuild.
 * Pure path logic plus one real write into a throwaway tmp dir — no DB.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  deleteTenantUpload,
  getUploadsRoot,
  resolveTenantUpload,
  saveTenantUpload,
} from "@/lib/uploads";

const ORIGINAL_UPLOADS_DIR = process.env.UPLOADS_DIR;

function restoreEnv() {
  if (ORIGINAL_UPLOADS_DIR === undefined) delete process.env.UPLOADS_DIR;
  else process.env.UPLOADS_DIR = ORIGINAL_UPLOADS_DIR;
}

// Smallest buffer sniffImageMime accepts as PNG: the 8 magic bytes, padded to
// the 12-byte minimum it reads.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("getUploadsRoot — UPLOADS_DIR override (C1)", () => {
  afterEach(restoreEnv);

  it("defaults to <cwd>/uploads when UPLOADS_DIR is unset", () => {
    delete process.env.UPLOADS_DIR;
    expect(getUploadsRoot()).toBe(path.join(process.cwd(), "uploads"));
  });

  it("treats an empty or whitespace-only UPLOADS_DIR as unset", () => {
    process.env.UPLOADS_DIR = "";
    expect(getUploadsRoot()).toBe(path.join(process.cwd(), "uploads"));
    process.env.UPLOADS_DIR = "   ";
    expect(getUploadsRoot()).toBe(path.join(process.cwd(), "uploads"));
  });

  it("honours an absolute UPLOADS_DIR verbatim (the container sets /repo/uploads)", () => {
    process.env.UPLOADS_DIR = "/repo/uploads";
    expect(getUploadsRoot()).toBe(path.resolve("/repo/uploads"));
    // Trailing slash is normalised away so path.join never doubles separators.
    process.env.UPLOADS_DIR = "/repo/uploads/";
    expect(getUploadsRoot()).toBe(path.resolve("/repo/uploads"));
  });

  it("resolves a relative UPLOADS_DIR against cwd", () => {
    process.env.UPLOADS_DIR = "var/blobs";
    expect(getUploadsRoot()).toBe(path.join(process.cwd(), "var", "blobs"));
  });

  it("is read per call, not frozen at import", () => {
    process.env.UPLOADS_DIR = "/first";
    expect(getUploadsRoot()).toBe(path.resolve("/first"));
    process.env.UPLOADS_DIR = "/second";
    expect(getUploadsRoot()).toBe(path.resolve("/second"));
  });
});

describe("resolveTenantUpload under an overridden root", () => {
  afterEach(restoreEnv);

  it("anchors tenant paths under UPLOADS_DIR and still refuses traversal", () => {
    process.env.UPLOADS_DIR = "/repo/uploads";
    const root = path.resolve("/repo/uploads");

    expect(resolveTenantUpload("t1", "t1/a.jpg")).toBe(path.join(root, "t1", "a.jpg"));
    expect(resolveTenantUpload("t1", "/t1/a.jpg")).toBe(path.join(root, "t1", "a.jpg"));
    // Nested product folder, as POST /api/uploads/product-image stores it.
    expect(resolveTenantUpload("t1/products", "t1/products/p.png")).toBe(
      path.join(root, "t1", "products", "p.png"),
    );
    // Escapes: another tenant, the root itself, or above it.
    expect(resolveTenantUpload("t1", "t1/../t2/x.jpg")).toBeNull();
    expect(resolveTenantUpload("t1", "../t1/x.jpg")).toBeNull();
    expect(resolveTenantUpload("t1", "t2/x.jpg")).toBeNull();
  });
});

describe("saveTenantUpload / deleteTenantUpload write under UPLOADS_DIR", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "matgary-uploads-c1-"));
    process.env.UPLOADS_DIR = tmpRoot;
  });

  afterEach(async () => {
    restoreEnv();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("creates <UPLOADS_DIR>/<tenant>/<uuid>.<ext>, and delete removes exactly that file", async () => {
    const saved = await saveTenantUpload("tenant-a/products", { mime: "image/png", buffer: PNG_BYTES });

    expect(saved.mime).toBe("image/png");
    expect(saved.bytes).toBe(PNG_BYTES.byteLength);
    expect(saved.relativePath).toMatch(/^tenant-a\/products\/[0-9a-f-]{36}\.png$/);

    const abs = path.join(tmpRoot, saved.relativePath);
    expect(await fs.readFile(abs)).toEqual(PNG_BYTES);
    // Nothing leaked into the default cwd/uploads location.
    expect(resolveTenantUpload("tenant-a/products", saved.relativePath)).toBe(abs);

    await deleteTenantUpload("tenant-a/products", saved.relativePath);
    await expect(fs.access(abs)).rejects.toMatchObject({ code: "ENOENT" });
    // Idempotent: a second delete of a missing file is a no-op, not a throw.
    await expect(deleteTenantUpload("tenant-a/products", saved.relativePath)).resolves.toBeUndefined();
  });
});
