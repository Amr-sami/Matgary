/**
 * Devices list, collections config, and the reconcile of this phone's link
 * record (doc 15 spec 09 §4.6.6, §4.7). Used by the wizard, the hub and the
 * devices screen.
 *
 * The reconcile treats the device as ABSENT only on a successful 200 list
 * fetched while this screen is mounted (`isFetchedAfterMount`, not a list
 * cached from before the device was created). Offline, 5xx or 403 change
 * nothing (09 §4.2, §6.17).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useFocusEffect } from "expo-router";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { collectionCredits, collections } from "@matgary/api-client";

import * as listener from "../../../../modules/collection-listener";
import { api } from "@/api/client";
import { collectionKeys } from "@/collections/queries";
import { useSession } from "@/stores/session";

import * as store from "./device-store";
import { collectionConfigKey } from "./queries";
import { resumeAction, type DevicesListState, type SetupRecord } from "./wizard";

export function useCollectionDevices(enabled: boolean) {
  return useQuery({
    queryKey: collectionKeys.devices(),
    queryFn: () => collectionCredits.listDevices(api),
    enabled,
    staleTime: 0,
  });
}

/** GET /api/collections/config under `["collection-config", branchId]` (09 ARCH CR 5). */
export function useCollectionsConfig(enabled: boolean) {
  const branchId = useSession((s) => s.me?.branch?.id ?? null);
  return useQuery({
    queryKey: collectionConfigKey(branchId),
    queryFn: () => collections.getConfig(api),
    enabled,
    staleTime: 60_000,
  });
}

/** A fresh 200 list → the live ids; anything else → unknown. */
export function listStateOf(q: UseQueryResult<collectionCredits.DevicesResponse>): DevicesListState {
  if (q.status === "success" && q.isFetchedAfterMount && !q.isFetching && q.data) {
    return { ok: true, liveIds: q.data.devices.filter((d) => !d.revokedAt).map((d) => d.id) };
  }
  return { ok: false };
}

/**
 * The MMKV record, re-read on focus, and cleared when a fresh list no longer
 * has this phone's device (revoked from the web, `user_removed`). On an
 * Android listener record the native credential goes too (`clearCredentials()`,
 * 09 §4.6.6, M4 / order 29). M3 adds `clearIngestCredential()` here (09 step 18).
 */
export function useSetupRecord(list: DevicesListState) {
  const [record, setRecord] = useState<SetupRecord | null>(() => store.read());

  useFocusEffect(
    useCallback(() => {
      setRecord(store.read());
    }, []),
  );

  const liveKey = list.ok ? list.liveIds.join(",") : null;
  useEffect(() => {
    if (!list.ok) return;
    const cur = store.read();
    if (resumeAction(cur, list).kind === "clear") {
      if (cur?.platform === "android_listener") void listener.clearCredentials();
      store.clear();
      setRecord(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);

  const refresh = useCallback(() => setRecord(store.read()), []);
  return useMemo(() => ({ record, refresh }), [record, refresh]);
}
