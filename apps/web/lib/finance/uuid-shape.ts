// Permissive UUID validator used for `categoryId` on the finance endpoints.
//
// The seeded system categories (migration 0064) use IDs like
// `00000000-0000-4011-0000-000000000001` — UUID-SHAPED but technically
// invalid per RFC 4122 because the variant nibble is `0` instead of 8/9/a/b.
// zod's strict `.uuid()` rejects them, which blocked every attempt to post
// an expense under a system category (web + mobile).
//
// This regex accepts any 36-char hex-dash string, so:
//   - the seeded system IDs pass,
//   - gen_random_uuid() IDs pass,
//   - obvious garbage ("not-a-uuid", "") is still rejected,
//   - and the DB's FK constraint is the final backstop for anything else.

import { z } from "zod";

/** 8-4-4-4-12 hex-dash. Does NOT enforce RFC 4122 version/variant bits. */
export const uuidShape = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "invalid id",
  );
