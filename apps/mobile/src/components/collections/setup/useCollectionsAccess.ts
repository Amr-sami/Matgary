/**
 * The session-bound gate hook for the collections settings screens (doc 15
 * spec 09 §4.2). The rules themselves are pure, in ./access.ts.
 */
import { useMemo } from "react";

import { useSession } from "@/stores/session";

import { collectionsSetupAccess, type CollectionsSetupAccess } from "./access";

export type { CollectionsSetupAccess } from "./access";

export function useCollectionsAccess(): CollectionsSetupAccess {
  const me = useSession((s) => s.me);
  return useMemo(() => collectionsSetupAccess(me), [me]);
}
