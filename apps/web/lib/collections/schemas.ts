// Digital collections — request bodies of the /api/collections/* routes
// (05 §4.3, §4.10, §4.13, §4.14). Shape only: the semantic checks that carry
// their own error codes (INVALID_IPA_LINK, INVALID_IBAN, PROVIDER_RAIL_MISMATCH,
// …) live in the repos, so a zod failure is always 400 INVALID_REQUEST.

import { z } from "zod";
import {
  COLLECTION_PROVIDER_VALUES,
  COLLECTION_RAIL_VALUES,
  COLLECTION_SOURCE_TYPE_VALUES,
  REJECT_OUTCOME_VALUES,
  REJECT_REASON_VALUES,
} from "@matgary/domain/collections/types";
import { NOTE_MAX_LENGTH } from "@/lib/repo/collections";

const reviewThreshold = z
  .union([z.number(), z.string().trim().regex(/^\d+(\.\d{1,2})?$/).transform(Number)])
  .pipe(z.number().min(0).max(10_000_000));

/** Every account field except rail / provider. `null` clears a field (the
 *  mobile form sends the other rail's fields as null on create). */
const accountFields = {
  holderName: z.string().max(80).nullable().optional(),
  branchId: z.string().uuid().nullable().optional(),
  ipaLink: z.string().max(300).nullable().optional(),
  ipaHandle: z.string().max(80).nullable().optional(),
  accountLast4: z.string().max(8).nullable().optional(),
  isPrepaidCard: z.boolean().nullable().optional(),
  iban: z.string().max(64).nullable().optional(),
  walletMsisdn: z.string().max(32).nullable().optional(),
  walletOpenedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  isDefaultForMobile: z.boolean().nullable().optional(),
  isPosDefault: z.boolean().nullable().optional(),
  autoConfirmEnabled: z.boolean().nullable().optional(),
  reviewThreshold: reviewThreshold.nullable().optional(),
  balanceCheckEnabled: z.boolean().nullable().optional(),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000).nullable().optional(),
};

const label = z.string().trim().min(1).max(60);

/** POST collections/accounts (05 §4.14 AccountCreateBody). */
export const accountCreateSchema = z
  .object({
    rail: z.enum(COLLECTION_RAIL_VALUES),
    provider: z.enum(COLLECTION_PROVIDER_VALUES),
    label,
    ...accountFields,
  })
  .strict();

/** PATCH collections/accounts/[id]: every create field except rail and
 *  provider (a different bank is a new account). */
export const accountPatchSchema = z.object({ label: label.optional(), ...accountFields }).strict();

const note = z.string().max(NOTE_MAX_LENGTH).optional();

/** POST collections/[id]/confirm and /reopen. */
export const decisionNoteSchema = z.object({ note }).strict();

/** POST collections/[id]/reject (05 §4.10). */
export const rejectSchema = z
  .object({
    reason: z.enum(REJECT_REASON_VALUES),
    outcome: z.enum(REJECT_OUTCOME_VALUES).optional(),
    customerPhone: z.string().max(40).optional(),
    note,
  })
  .strict();

/** PATCH collections/[id] — payer hints and the account, while pending. */
export const collectionPatchSchema = z
  .object({
    collectionAccountId: z.string().uuid().optional(),
    payerPhoneLast4: z.string().regex(/^\d{4}$/).nullable().optional(),
    payerReference: z.string().regex(/^[0-9A-Za-z]{4,16}$/).nullable().optional(),
  })
  .strict();

/** PATCH collections/settings (any subset). */
export const settingsPatchSchema = z
  .object({
    collectionsEnabled: z.boolean().optional(),
    collectionsRequireAccount: z.boolean().optional(),
    collectionsStaleAfterMinutes: z.number().int().min(15).max(1440).optional(),
    collectionsAutoConfirmEnabled: z.boolean().optional(),
    collectionsStorePayerNames: z.boolean().optional(),
  })
  .strict();

export const SOURCE_TYPES = COLLECTION_SOURCE_TYPE_VALUES;
