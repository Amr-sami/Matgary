"use client";

// Receiving accounts for the web (doc 15 spec 12 §4.2): the POS picker reads
// them online or, when the network is down, from the IndexedDB snapshot
// written on the last successful load, and says which one it is
// (`state: "ready" | "cached" | "unknown"`). Key: ["collection-accounts",
// branchId, scope] — a prefix invalidation of ["collection-accounts"] also
// refreshes the branch settings (["collection-accounts", branchId, "settings"]).

import { useSession } from "next-auth/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type * as api from "@matgary/api-client/endpoints/collections";
import {
  archiveAccount,
  createAccount,
  listAccounts,
  updateAccount,
  type CollectionAccount,
} from "@/lib/api/collections";
import { readCollectionsSnapshot, writeCollectionsSnapshot } from "@/lib/offline/snapshot";
import { useActiveBranchId } from "./useCollections";

export type AccountsState = "ready" | "cached" | "unknown";

interface AccountsResult {
  accounts: CollectionAccount[];
  branchId: string | null;
  state: AccountsState;
}

export function useCollectionAccounts(opts: { scope?: "branch" | "all"; enabled?: boolean; includeArchived?: boolean } = {}) {
  const { data: session, status } = useSession();
  const tenantId = session?.user?.tenantId ?? null;
  const branchId = useActiveBranchId();
  const scope = opts.scope ?? "branch";
  // Only the POS list (branch scope, active only) is snapshotted: that is the
  // list a cashier needs offline.
  const snapshotted = scope === "branch" && !opts.includeArchived;
  const query = useQuery<AccountsResult>({
    queryKey: ["collection-accounts", branchId, scope, opts.includeArchived ? "archived" : "active"],
    enabled: (opts.enabled ?? true) && status === "authenticated" && !!tenantId,
    staleTime: 60_000,
    queryFn: async () => {
      try {
        const r = await listAccounts({ scope, includeArchived: opts.includeArchived });
        const bid = r.branchId || branchId;
        if (snapshotted && tenantId && bid) void writeCollectionsSnapshot("accounts", tenantId, bid, r.data);
        return { accounts: r.data, branchId: r.branchId ?? branchId, state: "ready" };
      } catch (e) {
        const offline = e instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false);
        if (!offline) throw e;
        const cached =
          snapshotted && tenantId && branchId
            ? await readCollectionsSnapshot<CollectionAccount[]>("accounts", tenantId, branchId)
            : null;
        return cached
          ? { accounts: cached, branchId, state: "cached" }
          : { accounts: [], branchId, state: "unknown" };
      }
    },
  });
  return {
    accounts: query.data?.accounts ?? [],
    branchId: query.data?.branchId ?? branchId,
    // An HTTP error (not a network one) also means "unknown": the pick is
    // then not required and the sale books without an account (flagged).
    state: (query.isError ? "unknown" : query.data?.state ?? "unknown") as AccountsState,
    loading: query.isPending && query.fetchStatus !== "idle",
    error: query.error,
    refetch: query.refetch,
  };
}

export function useCollectionAccountMutations() {
  const qc = useQueryClient();
  const done = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["collection-accounts"] }),
      qc.invalidateQueries({ queryKey: ["collections-config"] }),
    ]);
  const create = useMutation({
    mutationFn: (v: { body: api.AccountCreateBody; key: string }) => createAccount(v.body, v.key),
    onSuccess: done,
  });
  const update = useMutation({
    mutationFn: (v: { id: string; patch: api.AccountPatchBody }) => updateAccount(v.id, v.patch),
    onSuccess: done,
  });
  const archive = useMutation({
    mutationFn: (id: string) => archiveAccount(id),
    onSuccess: done,
  });
  return { create, update, archive };
}
