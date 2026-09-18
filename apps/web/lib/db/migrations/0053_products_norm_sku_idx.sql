-- Expression index for the scanner lookup (HANDOFF §8 #6).
--
-- lib/repo/catalog.ts `findProductBySku` filters the tenant's products on
--   lower(regexp_replace(sku, <SKU_STRIP_PG>, '', 'g'))
-- so a scan was a regex per row over the whole tenant catalogue — fine at 24
-- products, not at 20k. Both functions are IMMUTABLE, so Postgres accepts
-- the expression as an index key; the planner then answers a scan from the
-- index instead of re-normalising every row.
--
-- The pattern below MUST stay byte-identical to SKU_STRIP_PG in
-- lib/repo/catalog.ts — the planner only matches an expression index when
-- the query's expression is textually the same, which is also why the query
-- inlines the pattern as a literal rather than binding it. tests/unit/
-- sku-strip-index.test.ts fails if the two ever differ; a change to the
-- pattern means a new migration that drops this index and creates the new
-- one.
CREATE INDEX IF NOT EXISTS products_tenant_norm_sku_idx
  ON products (tenant_id, lower(regexp_replace(sku, '[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\u0001-\u001F\u007F\u200B\u200C\u200D\uFEFF]', '', 'g')));
