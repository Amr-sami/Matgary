/**
 * Spec 09's query keys (doc 15 spec 09 §4.1 step 3; 03 §B.10).
 *
 * The settings key is NOT a second definition: it is 08's
 * `collectionKeys.settings` (`["collection-accounts", branchId, "settings"]`,
 * 08 ARCH CR 4 / 09 ARCH CR 5), re-exported under 09's name. It shares the
 * `collection-accounts` snapshot root with the accounts list, so one
 * `invalidateQueries({queryKey: ["collection-accounts"]})` refreshes the POS
 * picker, `collectionsRequireAccount` offline, and these screens together.
 * Only `src/collections/queries.ts` (08) creates keys under that root.
 */
import { collectionKeys } from "@/collections/queries";

/** GET /api/collections/settings for a branch — 08's key, re-exported. */
export const collectionSettingsKey = collectionKeys.settings;

/** GET /api/collections/config (09 ARCH CR 5, accepted): the wizard's config read (M2). */
export const collectionConfigKey = (branchId: string | null) => ["collection-config", branchId] as const;

/** Every receiving-account list of every branch (the prefix a save / archive invalidates). */
export const COLLECTION_ACCOUNTS_ROOT = ["collection-accounts"] as const;
