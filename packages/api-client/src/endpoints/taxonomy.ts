import type { ApiClient } from "../http";
import type { Brand, Category, ListEnvelope } from "../types";

/**
 * Taxonomy — categories, brands, attributes and attribute values.
 *
 * These are the web's own admin handlers (`/api/categories`, `/api/brands`,
 * `/api/categories/[id]/attributes`, `/api/attributes/[id]`,
 * `/api/attributes/[id]/values`, `/api/attribute-values/[id]`). They already
 * enforce tenant isolation and branch scoping; `POST /api/categories` and
 * `POST /api/brands` additionally require `manage_catalog`. The mobile
 * screens gate every write on the same permission so the UI never offers an
 * action the server will refuse.
 *
 * Deleting a category that products still use answers 409 with the web's
 * own "in use" sentence in `error` — surfaced verbatim by the screens.
 */

export type { Brand, Category };

export interface AttributeValue {
  id: string;
  attributeId: string;
  key: string;
  label: string;
  position: number;
}

export interface CategoryAttribute {
  id: string;
  categoryId: string;
  key: string;
  label: string;
  position: number;
  required: boolean;
  values: AttributeValue[];
}

export interface Created {
  id: string;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export interface CreateCategoryInput {
  key: string;
  label: string;
  icon?: string;
  position?: number;
  hasAttributes?: boolean;
}

export interface UpdateCategoryInput {
  label?: string;
  icon?: string | null;
  position?: number;
  hasAttributes?: boolean;
}

export async function listCategories(c: ApiClient): Promise<Category[]> {
  const res = await c.request<ListEnvelope<Category>>("/api/categories");
  return res.data ?? [];
}

export const createCategory = (c: ApiClient, body: CreateCategoryInput) =>
  c.request<Created>("/api/categories", { method: "POST", body });

export const updateCategory = (c: ApiClient, id: string, body: UpdateCategoryInput) =>
  c.request<{ ok: true }>(`/api/categories/${id}`, { method: "PATCH", body });

export const deleteCategory = (c: ApiClient, id: string) =>
  c.request<{ ok: true }>(`/api/categories/${id}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

export interface CreateBrandInput {
  name: string;
  categoryId?: string | null;
}

export interface UpdateBrandInput {
  name?: string;
  categoryId?: string | null;
}

export async function listBrands(c: ApiClient, categoryId?: string): Promise<Brand[]> {
  const res = await c.request<ListEnvelope<Brand>>("/api/brands", {
    query: categoryId ? { categoryId } : undefined,
  });
  return res.data ?? [];
}

export const createBrand = (c: ApiClient, body: CreateBrandInput) =>
  c.request<Created>("/api/brands", { method: "POST", body });

export const updateBrand = (c: ApiClient, id: string, body: UpdateBrandInput) =>
  c.request<{ ok: true }>(`/api/brands/${id}`, { method: "PATCH", body });

export const deleteBrand = (c: ApiClient, id: string) =>
  c.request<{ ok: true }>(`/api/brands/${id}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// Attributes (per category) and their values
// ---------------------------------------------------------------------------

export interface CreateAttributeInput {
  key: string;
  label: string;
  position?: number;
  required?: boolean;
}

export interface UpdateAttributeInput {
  label?: string;
  position?: number;
  required?: boolean;
}

export interface CreateAttributeValueInput {
  key: string;
  label: string;
  position?: number;
}

export interface UpdateAttributeValueInput {
  label?: string;
  position?: number;
}

export async function listAttributes(
  c: ApiClient,
  categoryId: string,
): Promise<CategoryAttribute[]> {
  const res = await c.request<{ data: CategoryAttribute[] }>(
    `/api/categories/${categoryId}/attributes`,
  );
  return res.data ?? [];
}

export const createAttribute = (c: ApiClient, categoryId: string, body: CreateAttributeInput) =>
  c.request<Created>(`/api/categories/${categoryId}/attributes`, { method: "POST", body });

export const updateAttribute = (c: ApiClient, id: string, body: UpdateAttributeInput) =>
  c.request<{ ok: true }>(`/api/attributes/${id}`, { method: "PATCH", body });

export const deleteAttribute = (c: ApiClient, id: string) =>
  c.request<{ ok: true }>(`/api/attributes/${id}`, { method: "DELETE" });

export const createAttributeValue = (
  c: ApiClient,
  attributeId: string,
  body: CreateAttributeValueInput,
) => c.request<Created>(`/api/attributes/${attributeId}/values`, { method: "POST", body });

export const updateAttributeValue = (c: ApiClient, id: string, body: UpdateAttributeValueInput) =>
  c.request<{ ok: true }>(`/api/attribute-values/${id}`, { method: "PATCH", body });

export const deleteAttributeValue = (c: ApiClient, id: string) =>
  c.request<{ ok: true }>(`/api/attribute-values/${id}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// Helpers shared by the three screens
// ---------------------------------------------------------------------------

/**
 * The server requires `key` to match /^[a-z0-9_-]+$/ (≤ 40 chars). Mirrors
 * `apps/web/lib/utils/slug.ts`: Latin labels become a hyphenated slug; Arabic
 * (or anything that leaves fewer than 3 ASCII chars) gets a prefixed random
 * key, because transliterating the label would leak nothing useful and the
 * key is never shown to shoppers. Uniqueness is enforced by the DB — a clash
 * answers 409 and the screen shows the server's message.
 */
export function slugKey(label: string, prefix = "item"): string {
  const ascii = label
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (ascii.length >= 3) return ascii.slice(0, 40);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${random}`.slice(0, 40);
}

/**
 * The curated icon names the web's CategoriesEditor offers. They are lucide
 * names and are stored as-is on the category row; the mobile screen maps them
 * to phosphor glyphs for display and falls back to Package, exactly like the
 * web's Step1Category does.
 */
export const CATEGORY_ICONS = [
  "Watch",
  "FlaskConical",
  "Glasses",
  "Headphones",
  "Shirt",
  "ShoppingBag",
  "Smartphone",
  "Pill",
  "Coffee",
  "Cookie",
  "Package",
] as const;

export type CategoryIcon = (typeof CATEGORY_ICONS)[number];
