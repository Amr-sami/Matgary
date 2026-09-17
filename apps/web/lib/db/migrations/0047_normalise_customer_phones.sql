-- Backfill sales.customer_phone to canonical E.164 ("+201XXXXXXXXX").
--
-- Root cause: two writers disagreed. POST /api/sales/cart ran the number
-- through normalizeEgyptPhone() and stored "+201001234008", while the older
-- POST /api/sales stored whatever the client sent — in practice the local
-- form "01001234008". Every reader that keys on customer_phone (the v1
-- customers aggregation GROUP BY, /api/sales/settle's equality match, the
-- loyalty wallet PK) therefore saw one person as two, or could not find them
-- at all. The customer ledger was patched to match both shapes, but the data
-- stayed split.
--
-- /api/sales now normalises on write like the cart route does. This rewrites
-- the rows written before that fix. Idempotent: the WHERE patterns cannot
-- match a row that has already been rewritten to "+20…".

-- "01001234008" -> "+201001234008"
UPDATE sales
   SET customer_phone = '+2' || customer_phone
 WHERE customer_phone ~ '^0[0-9]{10}$';

-- "201001234008" -> "+201001234008"
UPDATE sales
   SET customer_phone = '+' || customer_phone
 WHERE customer_phone ~ '^20[0-9]{10}$';
