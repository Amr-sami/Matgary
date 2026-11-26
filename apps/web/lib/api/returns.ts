import type { Return } from "@/lib/types";

interface ReturnApiRow extends Omit<Return, "returnDate"> {
  returnDate: string;
}

function reviveReturn(r: ReturnApiRow): Return {
  return { ...r, returnDate: new Date(r.returnDate) };
}

async function jsonFetch<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? (null as T) : res.json();
}

export async function listReturns(opts?: {
  all?: boolean;
  days?: number;
}): Promise<Return[]> {
  const qs = new URLSearchParams();
  if (opts?.all) qs.set("all", "1");
  else if (opts?.days) qs.set("days", String(opts.days));
  const url = qs.toString() ? `/api/returns?${qs}` : "/api/returns";
  const json = await jsonFetch<{ data: ReturnApiRow[] }>(url);
  return json.data.map(reviveReturn);
}

export async function recordReturn(
  saleId: string,
  productId: string,
  returnedQuantity: number,
  reason: string,
): Promise<void> {
  await jsonFetch("/api/returns", {
    method: "POST",
    body: JSON.stringify({ saleId, productId, returnedQuantity, reason }),
  });
}
