/**
 * Doc 14 §3.1 C3 — the six WhatsApp credential fields on GET / PATCH
 * /api/settings for a caller WITHOUT `manage_whatsapp`.
 *
 * Two contracts, both fed by the web POS and the web /settings page:
 *   - GET masks a configured credential to the `********` placeholder and an
 *     unconfigured one to "" — never the real id — so `SaleForm.tsx` can still
 *     tell "a server-side sender is configured" from truthiness (a blank would
 *     silently drop every cashier till to the wa.me popup), while the values
 *     themselves stay with `manage_whatsapp`;
 *   - PATCH drops the six keys from the body, whatever the enforcement flag
 *     says, so the /settings page's whole-draft save (placeholders + blanks
 *     after the GET above) can never null a token or write "********" as an
 *     instance id from a `view_settings`-only session.
 * Every collaborator is faked; the assertions are about the route alone.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const C = vi.hoisted(() => ({
  TENANT: "11111111-1111-4111-8111-111111111111",
  BRANCH: "33333333-3333-4333-8333-333333333333",
  USER: "22222222-2222-4222-8222-222222222222",
  PLACEHOLDER: "********",
}));

const CREDENTIAL_KEYS = [
  "greenApiInstanceId",
  "greenApiToken",
  "greenApiUrl",
  "whatsappCloudPhoneId",
  "whatsappCloudToken",
  "whatsappCloudBusinessId",
] as const;

/** What the repo hands the route: Green API configured, Cloud API not. */
const stored = vi.hoisted(() => ({
  full: {
    shopName: "Amr Store",
    shopPhone: "01000000000",
    autoOpenWhatsApp: true,
    messageTemplate: "hi {name}",
    greenApiEnabled: true,
    greenApiInstanceId: "7107606136",
    greenApiToken: "********",
    greenApiUrl: "https://7107.api.greenapi.com",
    whatsappCloudEnabled: false,
    whatsappCloudPhoneId: "",
    whatsappCloudToken: "",
    whatsappCloudBusinessId: "",
    loyaltyEnabled: false,
    receiptFooterText: "thanks",
  } as Record<string, unknown>,
}));

const auth = vi.hoisted(() => ({ ctx: {} as Record<string, unknown> }));

vi.mock("@/lib/api/auth-helpers", () => ({
  requireTenantWithBranch: vi.fn(async () => ({ ok: true, ctx: auth.ctx })),
  // Audit mode: the gate logs and lets the request through — exactly the
  // situation the PATCH strip exists for.
  requirePermissionWithBranch: vi.fn(async () => ({ ok: true, ctx: auth.ctx })),
}));

vi.mock("@/lib/repo/settings", () => ({
  TOKEN_PLACEHOLDER: C.PLACEHOLDER,
  getShopSettings: vi.fn(async () => ({ ...stored.full })),
  saveShopSettings: vi.fn(async () => undefined),
}));

vi.mock("@/lib/repo/activity", () => ({ logActivity: vi.fn() }));

import { GET, PATCH } from "@/app/api/settings/route";
import { logActivity } from "@/lib/repo/activity";
import { saveShopSettings } from "@/lib/repo/settings";

const principal = (role: string, permissions: string[]) => ({
  userId: C.USER,
  tenantId: C.TENANT,
  branchId: C.BRANCH,
  role,
  permissions,
  walls: [],
});
const OWNER = principal("owner", []);
const CASHIER = principal("staff", ["record_sales", "view_settings"]);
const WHATSAPP_STAFF = principal("staff", ["manage_whatsapp"]);

async function get() {
  const res = await GET();
  return { status: res.status, json: (await res.json()) as { data: Record<string, unknown>; branchId: string } };
}

async function patch(body: unknown) {
  const req = new NextRequest("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await PATCH(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** The third argument of the one saveShopSettings call. */
function savedPatch(): Record<string, unknown> {
  expect(saveShopSettings).toHaveBeenCalledTimes(1);
  const call = (saveShopSettings as Mock).mock.calls[0] as [string, string, Record<string, unknown>];
  expect(call[0]).toBe(C.TENANT);
  expect(call[1]).toBe(C.BRANCH);
  return call[2];
}

beforeEach(() => {
  (saveShopSettings as Mock).mockClear();
  (logActivity as Mock).mockClear();
});

describe("GET /api/settings — credential fields", () => {
  it("masks each configured credential to the placeholder and leaves an unconfigured one blank for a cashier", async () => {
    auth.ctx = CASHIER;
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.json.branchId).toBe(C.BRANCH);
    expect(r.json.data).toMatchObject({
      greenApiInstanceId: C.PLACEHOLDER,
      greenApiToken: C.PLACEHOLDER,
      greenApiUrl: C.PLACEHOLDER,
      whatsappCloudPhoneId: "",
      whatsappCloudToken: "",
      whatsappCloudBusinessId: "",
    });
    // The real id never leaves the server …
    expect(JSON.stringify(r.json)).not.toContain("7107");
    // … and every non-credential field is untouched (receipt printing).
    for (const [k, v] of Object.entries(stored.full)) {
      if ((CREDENTIAL_KEYS as readonly string[]).includes(k)) continue;
      expect(r.json.data[k]).toEqual(v);
    }
  });

  it("keeps the truthiness the web POS keys provider detection on (SaleForm.tsx)", async () => {
    auth.ctx = CASHIER;
    const { data } = (await get()).json;
    const useGreen = !!data.greenApiEnabled && !!data.greenApiInstanceId && !!data.greenApiToken;
    const useCloud = !!data.whatsappCloudEnabled && !!data.whatsappCloudPhoneId && !!data.whatsappCloudToken;
    expect(useGreen).toBe(true);
    expect(useCloud).toBe(false);
  });

  it("returns the fields untouched to the owner", async () => {
    auth.ctx = OWNER;
    expect((await get()).json.data).toEqual(stored.full);
  });

  it("returns the fields untouched to staff holding manage_whatsapp", async () => {
    auth.ctx = WHATSAPP_STAFF;
    expect((await get()).json.data).toEqual(stored.full);
  });
});

describe("PATCH /api/settings — credential fields", () => {
  const body = {
    shopName: "Renamed",
    loyaltyEnabled: true,
    greenApiInstanceId: C.PLACEHOLDER,
    greenApiToken: "",
    greenApiUrl: C.PLACEHOLDER,
    whatsappCloudPhoneId: "",
    whatsappCloudToken: "EAAG-forged",
    whatsappCloudBusinessId: "987654321098765",
  };

  it("drops the six keys for a cashier and saves the rest", async () => {
    auth.ctx = CASHIER;
    const r = await patch(body);
    expect(r).toEqual({ status: 200, json: { ok: true } });
    expect(savedPatch()).toEqual({ shopName: "Renamed", loyaltyEnabled: true });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settings.update",
        metadata: { changed: ["shopName", "loyaltyEnabled"] },
      }),
    );
  });

  it("passes the six keys through for the owner", async () => {
    auth.ctx = OWNER;
    const r = await patch(body);
    expect(r).toEqual({ status: 200, json: { ok: true } });
    expect(savedPatch()).toEqual(body);
  });

  it("passes the six keys through for staff holding manage_whatsapp", async () => {
    auth.ctx = WHATSAPP_STAFF;
    await patch(body);
    expect(savedPatch()).toEqual(body);
  });

  it("makes a cashier's GET → whole-draft PATCH round trip a no-op on every credential", async () => {
    auth.ctx = CASHIER;
    const draft = (await get()).json.data;
    await patch(draft);
    const saved = savedPatch();
    for (const k of CREDENTIAL_KEYS) expect(saved).not.toHaveProperty(k);
    expect(saved.shopName).toBe("Amr Store");
  });

  it("still rejects an invalid body before touching the repo", async () => {
    auth.ctx = CASHIER;
    const r = await patch({ shopName: 42 });
    expect(r.status).toBe(400);
    expect(saveShopSettings).not.toHaveBeenCalled();
  });
});
