import type { ApiClient } from "../http";

/**
 * Branches — the tenant's locations. Every read and write in the product is
 * scoped to ONE of them, chosen per request by the `X-Branch-Id` header the
 * client attaches (see apps/mobile/src/api/client.ts). There is no
 * server-side "select" for native: switching is a header change, confirmed
 * by re-reading `/api/v1/me`, which is what `useSession().switchBranch` does.
 *
 * `GET /api/branches` is the owner-facing management list (address, phone,
 * active flag). For the picker itself `MeResponse.branches` is enough and
 * arrives with the session — this list is for the settings page and for
 * detail the summary does not carry.
 */

/** apps/web/lib/repo/branches.ts `BranchDescriptor`, serialised. */
export interface Branch {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  address: string | null;
  phone: string | null;
  /** Suspended branches stay in the list so the owner can re-activate them. */
  isActive: boolean;
  /** Exactly one per tenant; cannot be suspended or deleted. */
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

/** apps/web/app/api/branches/route.ts GET */
export interface BranchListResponse {
  /**
   * Owner: every branch in the tenant. Staff: only the ones on their
   * allow-list. Primary first, then by creation date.
   */
  data: Branch[];
  /**
   * The branch the server resolved for THIS request — `X-Branch-Id` header,
   * then the web's `mg.branch` cookie, then the primary (see
   * apps/web/lib/api/branch-context.ts). Null only for a tenant with no
   * branch row at all.
   */
  currentBranchId: string | null;
}

export async function list(client: ApiClient): Promise<BranchListResponse> {
  return client.request<BranchListResponse>("/api/branches");
}

/** apps/web/app/api/branches/[id]/route.ts GET */
export async function get(client: ApiClient, id: string): Promise<Branch> {
  const res = await client.request<{ data: Branch }>(`/api/branches/${encodeURIComponent(id)}`);
  return res.data;
}

export interface CreateBranchInput {
  name: string;
  address?: string | null;
  phone?: string | null;
}

/** Owner only — the server answers 403 for staff. */
export async function create(
  client: ApiClient,
  input: CreateBranchInput,
): Promise<{ id: string }> {
  return client.request<{ id: string }>("/api/branches", {
    method: "POST",
    body: input,
  });
}

/**
 * apps/web/app/api/branches/[id]/route.ts PATCH body. Every field optional;
 * `isActive: false` suspends (refused for the primary), `true` re-activates.
 */
export interface UpdateBranchInput {
  name?: string;
  address?: string | null;
  phone?: string | null;
  isActive?: boolean;
}

/** Owner only. Rename, re-address, or flip the active flag. */
export async function update(
  client: ApiClient,
  id: string,
  input: UpdateBranchInput,
): Promise<{ ok: true }> {
  return client.request<{ ok: true }>(`/api/branches/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
  });
}

/** Owner only. Shorthand for `update(..., { isActive })`. */
export function setActive(
  client: ApiClient,
  id: string,
  isActive: boolean,
): Promise<{ ok: true }> {
  return update(client, id, { isActive });
}

/**
 * Owner only. The primary branch cannot be deleted (400), and a branch that
 * still has stock, sales or staff bound to it answers 409 with the counts —
 * suspend those with `setActive(false)` instead.
 */
export async function remove(client: ApiClient, id: string): Promise<{ ok: true }> {
  return client.request<{ ok: true }>(`/api/branches/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
