import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, collections } from "@matgary/api-client";

import { api } from "@/api/client";
import { invalidateCollections, newIdempotencyKey } from "@/collections/queries";
import { collectionErrorKey } from "@/collections/rules";
import { ConfirmSheet } from "@/components/collections/ConfirmSheet";
import { RejectSheet } from "@/components/collections/RejectSheet";
import { ReopenSheet } from "@/components/collections/ReopenSheet";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { useOffline } from "@/stores/offline";

type Collection = collections.CollectionDTO;
export type DecisionKind = "confirm" | "reject" | "reopen";

/**
 * A server error on a collection action, worded: a known code → its
 * `app.collections.errors.<CODE>` sentence (05's subtree; checked BEFORE the
 * generic 403 copy, since SELF_CONFIRM_FORBIDDEN is a 403), else errorText().
 */
export function collectionErrorText(e: unknown): string {
  const key = collectionErrorKey(e instanceof ApiError ? e.code : null);
  return key ? t(key) : errorText(e, t("app.collections.detail.actionFailed"));
}

/**
 * Confirm / reject / reopen for ONE screen (collection detail, sale-detail
 * Transfer block): which sheet is open, the Idempotency-Key minted WHEN IT
 * OPENS (reused for every tap and retry inside it — a double tap or a lost
 * response replays, it never decides twice; 03 §C.8 rule 12), the mutation,
 * the invalidations every decision needs, and the sheets to render.
 *
 * Online-only (03 §C.5): offline the submits are disabled and say so.
 */
export function useCollectionDecisions(onDone?: (kind: DecisionKind, result: Collection) => void) {
  const qc = useQueryClient();
  const online = useOffline((s) => s.online);
  const [target, setTarget] = useState<{ kind: DecisionKind; c: Collection; key: string } | null>(null);
  // Remount key for the reject sheet: bumped when it OPENS (its form state is
  // per collection) and kept on close, so the sheet still slides out.
  const [rejectMount, setRejectMount] = useState(0);

  const mut = useMutation({
    mutationFn: (v: { kind: DecisionKind; id: string; key: string; body?: collections.RejectCollectionBody }) => {
      switch (v.kind) {
        case "confirm":
          return collections.confirmCollection(api, v.id, {}, v.key);
        case "reject":
          return collections.rejectCollection(api, v.id, v.body!, v.key);
        case "reopen":
          return collections.reopenCollection(api, v.id, {}, v.key);
      }
    },
    onSuccess: async (result, v) => {
      setTarget(null);
      await invalidateCollections(qc);
      onDone?.(v.kind, result);
    },
    onError: (e) => {
      // Someone else decided first: show the sentence and refetch, so the
      // screen behind the sheet stops offering a decision that is gone.
      if (e instanceof ApiError && e.code === "COLLECTION_NOT_PENDING") void invalidateCollections(qc);
    },
  });

  const open = useCallback(
    (kind: DecisionKind, c: Collection) => {
      mut.reset();
      if (kind === "reject") setRejectMount((n) => n + 1);
      setTarget({ kind, c, key: newIdempotencyKey() });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const close = useCallback(() => {
    if (mut.isPending) return;
    mut.reset();
    setTarget(null);
  }, [mut]);

  const error = mut.isError ? collectionErrorText(mut.error) : null;
  const footnote = online ? null : t("app.collections.detail.onlineOnly");
  const submit = (body?: collections.RejectCollectionBody) => {
    if (!target || !online) return;
    mut.mutate({ kind: target.kind, id: target.c.id, key: target.key, body });
  };

  const sheets = (
    <>
      <ConfirmSheet
        collection={target?.kind === "confirm" ? target.c : null}
        busy={mut.isPending}
        error={error}
        disabled={!online}
        footnote={footnote}
        onClose={close}
        onSubmit={() => submit()}
      />
      <RejectSheet
        key={`reject-${rejectMount}`}
        collection={target?.kind === "reject" ? target.c : null}
        busy={mut.isPending}
        error={error}
        disabled={!online}
        footnote={footnote}
        onClose={close}
        onSubmit={(body) => submit(body)}
      />
      <ReopenSheet
        collection={target?.kind === "reopen" ? target.c : null}
        busy={mut.isPending}
        error={error}
        disabled={!online}
        onClose={close}
        onSubmit={() => submit()}
      />
    </>
  );

  return { open, close, sheets, busy: mut.isPending, online };
}
