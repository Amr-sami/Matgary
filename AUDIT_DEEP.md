# Matgary — Multi-Reviewer Engineering Audit (Deep)

**Mandate**: Audit this codebase as a panel of ten reviewers, on the assumption it must reach **100,000 tenants, millions of invoices and products, hundreds of concurrent users**. Brutally honest, no inflation, evidence-based.

**Reviewers**: P1 Principal FS, P2 Staff Architect, P3 Sr Security, P4 Sr DevOps, P5 Sr DBA, P6 Sr Perf, P7 Sr FE, P8 Sr BE, P9 SaaS Scale, P10 SRE.

> Evidence inputs: 83,922 LOC, 169 routes, 53 tables, 39 migrations, 1,404 test lines, 40 RLS-forced tables, 14 rate-limit buckets, 1 Server Action, 0 `loading.tsx`, 91 % client components, 60 s user-context cache, single Redis, single Postgres, single Node instance, BullMQ wired but barely used, Paymob HMAC-verified, WhatsApp HMAC-verified, cron auth via `timingSafeEqual + CRON_SECRET + IP rate limit`, daily pg_dump with 14-day/8-week retention, no managed deploy yet.

---

## 1. Executive Summary

This is **the upper end of senior work** with **staff-level security discipline** sitting on top of a **single-instance MVP infrastructure**. It is honest about what it is — the README, `task.md`, and pre-pentest audit are unusually candid — and it has been hardened in the parts the author touched. The parts that haven't been touched yet are the parts that will collapse under scale:

- **The data plane is one Postgres, one Redis, one Node process** — fine for 10 tenants, painful at 1,000, unworkable at 100,000.
- **The frontend leaves Next 16's entire performance toolkit (RSC, streaming, Cache Components) unused** — 91 % client components, 0 `loading.tsx`, 1 Server Action, 5 `<Suspense>`.
- **Three god files** carry the most business logic and are the choke point on velocity (`lib/repo/operations.ts` 1,552 lines, `components/sales/SaleForm.tsx` 1,394 lines, `app/settings/page.tsx` 1,584 lines).
- **Two N+1 query hot paths** (`recordCartSale`, `materializeDueRecurringExpenses`) — one of them is the POS critical path.
- **Test coverage is 1.7 % by lines** — only the tenant-isolation suite is load-bearing.
- **No production deploy pipeline.** No blue/green. No canary. No rollback runbook. Backups exist; restore is manually invoked from a host shell.
- **Security floor is high**: RLS forced on all 40 scoped tables, HMAC-verified webhooks, timing-safe cron auth, bcrypt + TOTP + recovery codes + token versioning, CSP per-request nonce (Report-Only), rate limits on auth surfaces, magic-byte file sniff on uploads.

**Bottom line**: at this scale (~10 tenants) the codebase is well above industry median. To reach **1,000 tenants** is a focused quarter of work. To reach **100,000** is a re-architecture, not an upgrade.

---

## 2. Critical Issues (P0 — fix in 1–2 sprints)

### C-1. Two N+1 queries on the POS hot path
- **Reviewer**: P6, P8 — **Confidence: High** — **Impact: Performance, Reliability, Revenue**
- **Evidence**: `lib/repo/operations.ts:439` `recordCartSale` — per-line `SELECT FROM products LIMIT 1` and per-line `loadAttributeSnapshot` inside one transaction. A 10-line invoice = 21 round trips. Same pattern at `:1295` `materializeDueRecurringExpenses`.

### C-2. Seven route handlers bypass `lib/repo` and call `lib/db` directly
- **Reviewer**: P3, P2 — **Confidence: High** — **Impact: Security, Maintainability**
- **Routes**: `insights/staff-performance`, `customers/by-phone/[phone]/payments`, `settings/cash-drawer`, `auth/2fa-needed`, `account/email/check`, `account/store-handle/check`, `whatsapp/webhook/events/[id]/replay`. Two of those handle tenant-scoped data **without `withTenant`** — RLS still protects them because the app role doesn't BYPASSRLS, but the explicit `tenant_id` filter (the primary line) is missing in spots.

### C-3. File uploads land on a host bind mount (`uploads/`)
- **Reviewer**: P4, P9, P10 — **Confidence: High** — **Impact: Reliability, Scalability**
- **Evidence**: `Dockerfile` does not include `uploads/`; the path is mounted from the host. The moment you deploy a second node, half the team photos disappear.

### C-4. Zero production deploy pipeline + zero rollback strategy
- **Reviewer**: P4, P10 — **Confidence: High** — **Impact: Reliability, Revenue**
- **Evidence**: `README.md` line "Not yet wired. Production target requires …". No GitHub Action that builds and deploys. No blue/green. No canary. No documented rollback. The only safety net is `pg_dump`.

### C-5. Notifications SSE pinned to one Node process
- **Reviewer**: P9, P10 — **Confidence: High** — **Impact: Scalability, Reliability**
- **Evidence**: `app/api/notifications/stream/route.ts` uses Redis pub/sub for fan-out, which is correct **for now**, but the SSE response stream is held open in one process. Behind a load balancer with no sticky sessions, half of users get a stale snapshot per reconnect. No documented LB strategy.

### C-6. Hourly cron runs synchronously across every tenant
- **Reviewer**: P5, P9 — **Confidence: High** — **Impact: Performance, Reliability**
- **Evidence**: `cron/digest-tick`, `cron/cash-shift-sweep`, `cron/recurring-expenses` iterate `SELECT id FROM tenants` and process serially in one request. At 1,000 tenants × digest with WhatsApp send, that's a ~10-minute synchronous request. Cron handlers are HTTP; the orchestrator will time out.

### C-7. Connection pool of 10 will be the first concurrency wall
- **Reviewer**: P5, P6 — **Confidence: High** — **Impact: Performance, Reliability**
- **Evidence**: `lib/db/index.ts` `max: 10`. With a per-request transaction model (mandatory for `withTenant`), 11 simultaneous writes block. Modest POS load + insights query + a cron tick is enough.

### C-8. Arabic exception strings become HTTP 500s
- **Reviewer**: P1, P8 — **Confidence: High** — **Impact: Reliability, Revenue (POS UX)**
- **Evidence**: `recordCartSale` throws `الفاتورة فارغة`, `المنتج غير موجود`, `الكمية المطلوبة من … غير متوفرة`. The route catches and returns 500. A 4xx with an error code would let the UI show a helpful message; 500s are uselessly opaque and trigger Sentry alerts on user error.

---

## 3. High Issues (P1 — within the quarter)

### H-1. `lib/repo/operations.ts` is a 1,552-line god module
- **Reviewer**: P2, P1 — **Confidence: High** — **Impact: Maintainability**
- Sales + returns + expenses + recurring expense cron. 16 public functions. Split into `repo/sales.ts`, `repo/returns.ts`, `repo/expenses.ts`.

### H-2. `components/sales/SaleForm.tsx` is a 1,394-line client component
- **Reviewer**: P7, P1 — **Confidence: High** — **Impact: Maintainability, Performance**
- 6 `useEffect`s, 4 `fetch`s, cart state + autocomplete + discount math + receipt build + WhatsApp send + offline plumbing + print routing. Extract `useCart()` hook + `<CartLineEditor>` + `<DiscountControls>` + `<ReceiptDispatcher>`.

### H-3. `app/settings/page.tsx` is a 1,584-line client page
- **Reviewer**: P7 — **Confidence: High** — **Impact: Maintainability, Performance**
- Ten tabs, all loaded eagerly, all client. Per-tab dynamic import + Server Component shells.

### H-4. 91 % of components are client; zero `loading.tsx`; one Server Action
- **Reviewer**: P7, P1 — **Confidence: High** — **Impact: Performance**
- Dashboard (`app/page.tsx`) is `"use client"` with no interactivity. Customer detail, sales list, insights all client. **The entire Next 16 performance budget is leaving the building.**

### H-5. 38 client components self-fetch their own data after hydration
- **Reviewer**: P7, P6 — **Confidence: High** — **Impact: Performance, Reliability**
- `<CategoriesEditor>` 7 fetches, `<TeamEditor>` 6, `<AttendanceRoster>` 6. Every re-mount re-issues every fetch. Move to Server Components or hoist to a parent + share via context.

### H-6. `logActivity` runs synchronously on the hot path
- **Reviewer**: P5, P6 — **Confidence: High** — **Impact: Performance, Scalability**
- Every meaningful mutation inserts to `activity_logs` synchronously. With `bullmq` already installed and 53 mutating routes, this is a textbook queue offload.

### H-7. Offset pagination on growing tables
- **Reviewer**: P5, P9 — **Confidence: Medium** — **Impact: Performance, Scalability**
- Sales, customers, products, activity_logs. Cursor pagination needed by 1,000 tenants × 1,000 invoices each. `activity_logs` is already on a 2-year retention sweep — that's an admission of the problem, not a fix.

### H-8. Insights & sales-overview aggregates have no cache
- **Reviewer**: P6 — **Confidence: Medium** — **Impact: Performance**
- `task.md` admits "deliberately not cached". Insights overview is the second-most-hit read after the dashboard.

### H-9. Catalog / settings / branches have a 5-min Redis cache; no `cacheTag` / Cache Components
- **Reviewer**: P7 — **Confidence: High** — **Impact: Performance**
- Hand-rolled Redis cache works, but `use cache` + `cacheTag` would let the framework do half this work and turn it into PPR.

### H-10. zod validation present on 47 % of routes
- **Reviewer**: P8, P3 — **Confidence: High** — **Impact: Reliability, Security**
- 79/169 routes have an explicit zod schema. The rest accept raw `req.json()` and trust the shape. A stray `extra` field in body is harmless; a missing field that the repo doesn't guard isn't.

### H-11. `console.*` 72 sites, `logger.*` 72 sites
- **Reviewer**: P10 — **Confidence: High** — **Impact: Reliability, Observability**
- Half of all logging bypasses the structured logger. In incident response that's the half that won't be queryable.

### H-12. No tracing
- **Reviewer**: P10 — **Confidence: High** — **Impact: Reliability, Performance**
- Sentry is set up but only `tracesSampler` is configured. No request IDs flowing through repo calls. Diagnosing a slow page = a one-by-one log dig.

### H-13. `eslint-disable react-hooks/exhaustive-deps` 32 times
- **Reviewer**: P7 — **Confidence: Medium** — **Impact: Reliability**
- Each is a documented bet against React's dependency analyser. Each is also a class of bug Cookie sessions hide.

### H-14. Background worker bootstrapped via `instrumentation.ts` runs co-located with HTTP
- **Reviewer**: P9, P10 — **Confidence: Medium** — **Impact: Reliability, Scalability**
- The WhatsApp BullMQ worker boots on every Node process that also serves HTTP. Fine for one process; at horizontal scale every replica will start a worker and contend on the same queue without isolation knobs.

### H-15. `setBranchNameCookie` is non-HttpOnly by design
- **Reviewer**: P3 — **Confidence: Medium** — **Impact: Security**
- Necessary for the SSR-render-without-flicker pattern. Value is a tenant name — not a secret — but it widens the cookie surface for XSS-based reconnaissance. CSP currently allows `'unsafe-inline'` for styles (Tailwind 4 limitation), so this is more material than it would be under strict CSP.

---

## 4. Medium Issues (P2 — within 6 months)

### M-1. No structured error taxonomy
- Reviewer P8 — Confidence High — Impact: Maintainability
- `SettlementError` exists; `PurchaseOrderConflictError` exists; `TeamConflictError` exists. They're not a hierarchy. Introduce a `DomainError` base with `code: string` + `httpStatus: number` + `safeDetail?: string`.

### M-2. Drizzle row types leak to UI
- Reviewer P2 — Confidence Medium — Impact: Maintainability
- `lib/types.ts` types are decent; some components reach into `r.attributesSnapshot` directly. Force-route through mappers.

### M-3. Single Sentry config for all environments, no PII redaction config beyond `scrubSentryEvent`
- Reviewer P3 — Confidence Medium — Impact: Security
- The scrubber covers credentials and obvious params; doesn't scrub Egyptian national IDs (already deliberately not validated — but they're still PDPL-sensitive if any sales note ever contains one).

### M-4. Cash-shift state machine implicit in repo functions
- Reviewer P2 — Confidence Medium — Impact: Maintainability
- `closeShift` / `force-close` / `auto-close` / `review` — state transitions encoded across 5 functions in a 943-line file. Extract a state-machine module.

### M-5. Catalog cache key strategy ad-hoc
- Reviewer P9 — Confidence Medium — Impact: Performance
- Key scheme is fine (`matgary:<env>:v1:t:<tenantId>:catalog`). Hit-rate is unobservable. Add a cache-hit metric.

### M-6. Two paths for WhatsApp (Cloud API folder + Green API file)
- Reviewer P2 — Confidence High — Impact: Maintainability
- Fold legacy file under the folder as `green-api.ts`. ESLint guard against new Green API imports.

### M-7. `admin/` is becoming a second copy of `repo/`
- Reviewer P2 — Confidence Medium — Impact: Maintainability
- `lib/admin/sales.ts` (627 lines) re-implements parts of `lib/repo/operations.ts` against the BYPASSRLS pool. Pull a sharedreader that takes a `Db` and let both pools consume it. Risky — go slow.

### M-8. No data-classification labels on tables
- Reviewer P3 — Confidence Medium — Impact: Security, Compliance
- Future PDPL audit will ask "which columns hold personal data?". A schema annotation (comment or sidecar JSON) per column would let you answer in a day.

### M-9. No request ID + no log correlation
- Reviewer P10 — Confidence High — Impact: Reliability
- A single user complaint can't be reconstructed from logs. Inject `requestId` via middleware, propagate through `withTenant`, attach to `logger`.

### M-10. CSP `style-src 'unsafe-inline'`
- Reviewer P3 — Confidence Medium — Impact: Security
- Tailwind 4 runtime injects unhashed inline styles. Documented backlog item. Material for XSS impact analysis until fixed.

### M-11. `allowedDevOrigins: ["192.168.1.42", "192.168.1.*"]` hardcoded in `next.config.ts`
- Reviewer P4 — Confidence Low — Impact: Maintainability
- Dev convenience leaking into a tracked file. Move to env or `.env.development`.

### M-12. No bundle analyser in CI; no size budget
- Reviewer P7 — Confidence High — Impact: Performance
- `recharts`, `pdf-lib`, `@pdf-lib/fontkit`, `qrcode`, `@dnd-kit/*` are eagerly bundled. A 30-line analyser step + a budget guard would surface the first regression.

### M-13. Bcrypt cost factor not pinned
- Reviewer P3 — Confidence Medium — Impact: Security
- `bcrypt.hash(plaintext, 10)` for recovery codes. 10 is the library default and 2026-soft. Recovery codes are throwaway, but consistency would say 12 across auth surfaces.

### M-14. WhatsApp Cloud token stored at-rest with no key rotation story
- Reviewer P3 — Confidence Medium — Impact: Security
- AES-256-GCM at rest is correct. No documented key-rotation procedure (`SECRET_KEY` rotation breaks every encrypted column on next read).

### M-15. Daily backup retains 14 + 8 — no off-site default
- Reviewer P4, P10 — Confidence High — Impact: Reliability
- `BACKUP_REMOTE_HOOK` exists; default deploy doesn't ship one. A single host loss = total data loss.

### M-16. No "delete me" GDPR/PDPL pipeline for individual customers
- Reviewer P3 — Confidence Medium — Impact: Compliance
- `tenant_deletions` covers tenant-level. Customer phone numbers live in `sales.customer_phone` snapshots — no scrub job exists.

### M-17. Notifications stream re-fetches snapshot on every event
- Reviewer P6 — Confidence Medium — Impact: Performance
- Two queries (`listNotificationsForUser`, `unreadNotificationCount`) per event marker. Coalesce into one read or push deltas.

### M-18. No HTTP caching headers on read-only public endpoints other than `/api/plans`
- Reviewer P7 — Confidence Medium — Impact: Performance
- `/api/plans` sets `Cache-Control`. `/api/branches`, `/api/categories`, `/api/brands` (per-tenant) would benefit from `private, max-age=60` or `cacheTag`.

### M-19. No CORS policy declared anywhere
- Reviewer P3 — Confidence Medium — Impact: Security
- Same-origin only by accident (no `Access-Control-Allow-Origin` set). Documented intent + explicit allow-list would prevent the day someone tries to share endpoints.

### M-20. `instrumentation.ts` does not register Sentry
- Reviewer P10 — Confidence Medium — Impact: Reliability
- It only boots BullMQ. Sentry config files run on import; Next 16 best-practice is to call `Sentry.init` from `instrumentation.ts` so it captures earlier in the lifecycle.

---

## 5. Low Issues (P3 — opportunistic)

- **L-1** `console.warn("[paymob-webhook] …")` instead of `logger.warn`. Many callsites; one canonical example.
- **L-2** `next.config.ts` has no `images.remotePatterns` configured but `next/image` is used.
- **L-3** No `robots.txt` / `sitemap.xml` for the marketing pages.
- **L-4** `tsbuildinfo` (1.1 MB) is checked in — `.gitignore` should exclude.
- **L-5** Lint is non-gating (`continue-on-error: true`) — fine while backlog exists, **must** be gating before headcount grows.
- **L-6** `app/page.tsx` carries an inline structural comment about the dashboard grid — useful, but the kind of thing that drifts.
- **L-7** `tsconfig.json` `target: ES2017`. Node 20 supports much newer. Tiny bundle/build wins available.
- **L-8** 1 `@ts-expect-error` and 32 `eslint-disable` — each should carry a `// reason: …` line; some do, some don't.
- **L-9** `apps/` directory exists but is empty — vestigial.
- **L-10** No `CONTRIBUTING.md` / `SECURITY.md`.

---

## 6. Security Audit

| Control | State | Reviewer |
|---|---|---|
| Tenant isolation (RLS) | **Strong**. 40 tables `FORCE ROW LEVEL SECURITY`, NOSUPERUSER app role, `withTenant` sets `app.tenant_id` in-tx. Isolation suite verifies. | P3 ✓ |
| Auth (login) | bcrypt + TOTP + recovery codes + token versioning + IP + email rate limits + invisible-char normalisation. | P3 ✓ |
| Sessions | JWT in HttpOnly cookies via Auth.js v5. `tv` claim invalidates on password change / 2FA toggle / sign-out-everywhere. | P3 ✓ |
| CSRF | SameSite=Lax cookies + no cross-origin mutating routes. No explicit CSRF token. Acceptable for Lax + same-origin posture. | P3 ✓ |
| CSP | Per-request nonce, `strict-dynamic`. **Report-Only** by default. `style-src 'unsafe-inline'` open (Tailwind 4). | P3 ⚠ |
| HSTS | Set by nginx template at 2 y + includeSubDomains. Not enforced in app. | P3 ✓ |
| Webhook auth | Meta + Paymob both HMAC-verified with `timingSafeEqual` before parsing. Raw-body-first pattern correct. | P3 ✓ |
| Cron auth | `CRON_SECRET` bearer + `timingSafeEqual` + IP rate limit + POST-only. Refuses to run without the secret (no "open mode"). | P3 ✓ |
| Upload safety | MIME allow-list + magic-byte sniff + filename sanitisation. | P3 ✓ |
| File serving | Tenant-scoped path resolution before disk read. | P3 ✓ |
| At-rest encryption | AES-256-GCM for Green API tokens. No documented key rotation. | P3 ⚠ |
| Secrets handling | All required via env, no defaults in source. Sentry scrubber for outbound events. | P3 ✓ |
| Admin separation | Separate cookie, IP allowlist, BYPASSRLS pool, ESLint import-guard, separate audit log + password rotation. | P3 ✓ |
| Rate limits | 14 buckets across auth + WhatsApp send + cron. Per-tenant API rate limits — **missing**. | P3 ⚠ |
| OWASP A01 (Broken AC) | RLS + `requirePermission` + 7 direct-DB routes need conversion. | P3 ⚠ |
| OWASP A02 (Crypto) | bcrypt 10, AES-256-GCM — fine. | P3 ✓ |
| OWASP A03 (Injection) | All Drizzle parameterised, one `sql.raw` (audit-clean per H07 audit). | P3 ✓ |
| OWASP A04 (Insecure design) | Tenant isolation as a design property is the strongest signal here. | P3 ✓ |
| OWASP A05 (Misconfig) | `output: standalone`, `poweredByHeader: false`, no debug pages. | P3 ✓ |
| OWASP A06 (Vuln deps) | H07 pre-pentest pass documented; 3 deferred (Next 16.2.3 i18n, nodemailer CRLF, postcss<8.5.10) — non-exploitable in current usage. **Re-check on every dependabot tick.** | P3 ⚠ |
| OWASP A07 (Auth failures) | Solid — 2FA, recovery codes, token version, rate limits. | P3 ✓ |
| OWASP A08 (Integrity) | Webhook HMAC verified. No SRI on third-party scripts (none currently used). | P3 ✓ |
| OWASP A09 (Logging failures) | 72 `console.*` calls outside the logger. **Material gap for incident response.** | P3 ⚠ |
| OWASP A10 (SSRF) | No outbound URLs taken from user input except WhatsApp Cloud (Meta-verified) and Paymob (config). | P3 ✓ |

**Security score: 78 / 100** — Floor is staff-level. Ceiling is held by 7 direct-DB routes, `style-src 'unsafe-inline'`, missing per-tenant API rate limits, and inconsistent logging.

---

## 7. Architecture Audit

| Dimension | Score | Notes |
|---|---|---|
| Bounded contexts | 65 | Auth / tenant / catalog / operations / cash / people / WhatsApp / admin are recognisable. `operations.ts` blurs sales + returns + expenses. |
| Module boundaries | 75 | `app → lib/repo → lib/db` is enforced almost everywhere. Components and hooks never touch `drizzle-orm` directly (verified: 0 occurrences). |
| Domain separation | 60 | God modules confuse it. |
| Dependency flow | 80 | Unidirectional. ESLint guard around `lib/admin`. No circular deps observed. |
| Ownership / responsibility | 55 | Several cross-cutting concerns (activity log, cash-shift stamping, notifications, customer wallet) leak into every mutation handler. |
| Leaks | — | Drizzle row types leak in two places (`r.attributesSnapshot`); branch context threaded as a parameter rather than request-scoped value. |
| God modules | **3** | `operations.ts`, `SaleForm.tsx`, `settings/page.tsx`. |

**Architecture Health Score: 65 / 100.**

**Top recommended changes**:
1. Split `operations.ts` into three repos.
2. Introduce `lib/services/` for cross-cutting orchestration (sale → cash-shift → wallet → notification → activity).
3. Make `branchId` a request-scoped value injected by middleware, not a parameter on every repo function.

---

## 8. Performance Audit

| Layer | Score | Bottleneck |
|---|---|---|
| **DB** | 60 | Pool=10, N+1 in POS, offset pagination, no query plans in CI. Schema is well-indexed (205 indexes). |
| **Cache** | 65 | Redis layer is good; hit-rate unobservable; no Cache Components. |
| **Server** | 65 | Repo layer is clean; logActivity synchronous; cron tasks serial across all tenants. |
| **Network / API** | 50 | 38 components self-fetching post-hydration. No HTTP cache hints. SSE pinned to instance. |
| **Frontend** | 45 | 91 % client; 0 `loading.tsx`; 1 Server Action; 5 Suspenses; bundle unmeasured. |

### Top performance bottlenecks (ranked)

1. **`recordCartSale` N+1** — every POS sale, 10–20× pool pressure per cart.
2. **91 % client + no streaming** — every navigation.
3. **38 self-fetching components** — every re-mount.
4. **`logActivity` synchronous** — every mutation.
5. **DB pool = 10** — first concurrency wall (you'll see it under 30 RPS).
6. **Cron serial fan-out** — first cron-induced incident.
7. **Offset pagination** — silent O(n) reads.
8. **No bundle budget** — TTI drift will not be detected.

**Performance Score: 55 / 100.**

---

## 9. Scalability Audit

| Tenants | Likely failure mode | Mitigation runway |
|---|---|---|
| 10 (today) | None | — |
| 100 | Pool exhaustion on first concurrent POS spike; `insights` slow. | Connection pool + first cache wins. |
| 1,000 | Cron timeouts; activity_logs ballooning; SSE fan-out; uploads-on-bind-mount becomes incident. | Queue offload + S3 uploads + cursor pagination + read replica. |
| 10,000 | Single Postgres write-pressure; Redis hotkeys; per-tenant cache bust storm; cron incomplete in window. | Multi-tenant sharding decision; per-tenant cache namespacing already correct (`t:<tid>`); separate worker fleet. |
| 100,000 | Single-region Postgres unsustainable; WhatsApp webhook fan-in saturates one process; PDF generation in-process under web load. | Sharded DB / Citus / a true multi-cluster strategy; queue everything; PDF microservice; CDN for static + uploads. |

**First bottleneck**: DB pool + N+1 (≤ 100 tenants).
**Second bottleneck**: cron serialisation + activity_logs growth + uploads on bind mount (≤ 1,000 tenants).
**Eventual bottleneck**: single Postgres + single Redis + single deployment (~10K tenants).

**Scalability Score: 50 / 100.**

---

## 10. Maintainability Audit

| Signal | Score | Notes |
|---|---|---|
| Naming + layout | 85 | Predictable, conventional, one alias `@/*`. |
| "Why" comments | 90 | Best-in-class in the codebase. |
| File sizes | 45 | Three god files; ten files >500 lines. |
| Testing | 30 | 1.7 % test:src ratio. Isolation suite excellent. |
| Onboarding | 70 | README + `PROJECT.md` + `task.md` cover most of what a new engineer needs in <1 day. |
| Predictability | 75 | Once you've seen one route, you've seen most. |
| Bus factor | 50 | One author. No `CONTRIBUTING.md`. |
| Lint discipline | 50 | 32 `eslint-disable`, lint non-gating in CI. |

**Maintainability Score: 65 / 100.**

---

## 11. Technical Debt Audit

| Debt | Cost-to-fix | Cost-of-deferring |
|---|---|---|
| God modules (`operations.ts`, `SaleForm.tsx`, `settings/page.tsx`) | 1 week | Velocity drag on every sales/settings feature |
| 7 direct-DB routes | ½ day | RLS-bypass bug class; audit churn |
| N+1 in `recordCartSale` | 1 day | Pool pressure at every cart |
| `logActivity` synchronous | 1 week (incl queue) | DB write amplification on every mutation |
| Offset pagination | 1 week | Silent O(n) reads → invisible failure mode |
| 0 `loading.tsx` / 1 Server Action | 2 weeks | Wasted Next 16 features; user-perceived slowness |
| Uploads on host bind mount | 1 week | First horizontal scale step impossible |
| 1.7 % test coverage | 2–4 weeks | Cannot safely refactor; can't catch regressions |
| Co-located worker + HTTP | 1 week | Operational coupling |
| Sentry init outside `instrumentation.ts` | 2 hours | Late-attached errors during boot |
| Manual cron deploy | 1 week | Can't add a second cron without re-deploying |
| No bundle budget | ½ day | TTI drift will not be detected |
| `style-src 'unsafe-inline'` | 1–2 weeks (Tailwind 4 workaround) | Lower XSS impact analysis ceiling |
| Two WhatsApp paths | 2 days | New engineer breaks the wrong one |
| No request-ID + log correlation | 2 days | Slow incident triage |

**Technical Debt Score (lower is worse): 55 / 100** — material, identified, mostly fixable.

---

## 12. Code Improvement Templates

For each finding above the templates take the same shape:

### Template C-1: Fix `recordCartSale` N+1

**Current state** — per-line product + attribute fetch inside one transaction:
```ts
// lib/repo/operations.ts (today)
for (const line of lines) {
  const [p] = await tx.select().from(products).where(...).limit(1);   // 1 query
  const attrs = await loadAttributeSnapshot(tx, tenantId, line.productId);  // 1+ queries
  // ...
}
```

**Recommended**:
```ts
const ids = lines.map(l => l.productId);
const prods = await tx.select().from(products)
  .where(and(eq(products.tenantId, tenantId), inArray(products.id, ids)));
const byId = new Map(prods.map(p => [p.id, p]));

const attrs = await loadAttributeSnapshotsBulk(tx, tenantId, ids);   // one IN()
for (const line of lines) {
  const p = byId.get(line.productId);
  if (!p) throw new DomainError("PRODUCT_NOT_FOUND", 400, { productId: line.productId });
  // ...
}
```

Benefits — **Perf**: 5–10× POS latency reduction at large carts. **Reliability**: tighter transaction = less lock window.
Effort — **1 day** (incl. integration test on the cart route).
Risk — **Medium**: POS hot path; cover with a sale-flow test first.

---

### Template C-2: Convert direct-DB routes

**Current**:
```ts
// app/api/insights/staff-performance/route.ts (today)
import { db } from "@/lib/db";
// hand-rolled WHERE tenant_id = ...
const rows = await db.select(...).from(sales).where(eq(sales.tenantId, ctx.tenantId));
```

**Recommended**: move to `lib/repo/insights.ts`:
```ts
export async function listStaffPerformance(tenantId: string, opts: StaffPerfOpts) {
  return withTenant(tenantId, async (tx) => {
    return tx.select(...).from(sales).where(...);
  });
}
```
Route becomes thin: `const data = await listStaffPerformance(ctx.tenantId, opts)`.

Benefits — **Security**: RLS app.tenant_id set; closes a bug class. **Maintainability**: routes are uniformly thin.
Effort — **½ day** across 7 routes.
Risk — **Low**.

---

### Template C-8: Replace Arabic exceptions with codes

**Current**:
```ts
throw new Error(`المنتج "${p.name}" لا ينتمي لهذا الفرع — لا يمكن بيعه من هنا`);
```

**Recommended**:
```ts
export class DomainError extends Error {
  constructor(
    public code: string,
    public httpStatus = 400,
    public detail?: Record<string, unknown>,
  ) { super(code); }
}

throw new DomainError("PRODUCT_WRONG_BRANCH", 400, { productId: p.id, productName: p.name });
```

Route maps `code → user-facing dictionary string`. UI shows the localised string; logs see `code` + `detail`.

Benefits — **Reliability**: 4xx not 5xx. **UX**: helpful error. **Observability**: Sentry stops flagging user errors.
Effort — **½ day** to introduce class + migrate operations.ts.
Risk — **Low**.

---

### Template C-3: Move uploads to S3-compatible object storage

**Current**: `lib/uploads.ts` writes to `./uploads/`.
**Recommended**: factor a `Storage` interface; implementations `LocalFsStorage` (dev) and `S3Storage` (prod, AWS / Cloudflare R2 / MinIO). Wire via env. Serve through a signed URL endpoint that re-checks tenant ownership.

Benefits — **Scalability**: horizontal scale becomes possible. **Reliability**: durability moves from one host to many.
Effort — **1 week**.
Risk — **Medium**: file-serving route changes.

---

### Template H-6: Queue `logActivity` via BullMQ

**Current**: `logActivity({...})` runs synchronously in every route.
**Recommended**:
```ts
// lib/queue/activity.ts
export const activityQueue = new Queue("activity", { connection: ... });
export const enqueueActivity = (input: ActivityInput) =>
  activityQueue.add("write", input, { removeOnComplete: 100, removeOnFail: 50 });
```
Replace inline `await logActivity(...)` with `enqueueActivity(...)` (fire-and-forget). Worker drains in `lib/whatsapp/worker-bootstrap` (rename to `workers/`).

Benefits — **Perf**: shaves a write off every mutation. **Reliability**: audit failures decoupled from user request.
Effort — **1 week** (incl. tests + retry policy + DLQ).
Risk — **Medium**: audit ordering — explicitly document that events are eventually-consistent.

---

## 13. Best Practices Audit (scored)

| Principle | Score | Notes |
|---|---|---|
| SOLID | 60 | Three god files break SRP; DIP slips in 7 routes. |
| DRY | 70 | Route auth boilerplate repeats; otherwise OK. |
| KISS | 80 | Patterns are simple. Splash + cookie companion are the most clever bits and they're justified. |
| YAGNI | 70 | `bullmq` + `dexie` underused — premature install. Otherwise pragmatic. |
| SoC | 65 | God components mix concerns. |
| DI | 55 | Mostly direct imports. No DI container; OK at this size, will hurt at multi-storage. |
| DDD | 50 | No bounded-context modules. Domain language good in comments. |
| Clean Architecture | 55 | Concentric layers present in spirit (`app → repo → db`) but god modules violate them. |
| Hexagonal | 40 | No ports/adapters except for WhatsApp. |
| Repository Pattern | 80 | Strong — biggest architectural win. |
| CQRS | 35 | Reads and writes mix in the same repo functions. Acceptable today; insights/admin/sales would benefit from a read model. |
| Event-Driven | 25 | BullMQ installed, barely used. The codebase has obvious event seams (sale, return, expense, leave) and treats them all synchronously. |
| 12-Factor | 65 | Config via env, stateless processes (except SSE), single codebase. Logs go to stdout (mostly). Backups exist but not declared as a service. Disposability OK. |
| OWASP Top 10 | 78 | See §6. |
| Next.js 16 | 50 | Unused: Server Components by default, streaming, `loading.tsx`, Server Actions, Cache Components. |
| React 19 | 60 | Hydration discipline strong, `useEffect` use overgrown. |
| TypeScript | 80 | Strict, minimal `any`, single types module. Zod / Drizzle schemas not co-derived. |
| PostgreSQL | 75 | RLS forced + role separation + 75 CHECK constraints + 205 indexes. No partitioning, no pg_stat_statements, no read replicas. |

---

## 14. Refactoring Blueprint

### Phase 1 — Critical fixes (sprint 1–2; ~2 weeks, 1 engineer)

| # | Item | Effort | Risk | Dep | ROI |
|---|---|---|---|---|---|
| 1.1 | Replace Arabic exceptions with `DomainError` codes (C-8) | 0.5 d | Low | — | High (UX + perf observability) |
| 1.2 | Fix `recordCartSale` N+1 + cron N+1 (C-1) | 1 d | Med | 1.1 | Very high (POS latency) |
| 1.3 | Convert 7 direct-DB routes to repo (C-2) | 0.5 d | Low | — | High (security) |
| 1.4 | Wire `pg_stat_statements` + Grafana dashboard | 1 d | Low | — | Very high (visibility) |
| 1.5 | Add `loading.tsx` per segment + `error.tsx` per surface | 0.5 d | Low | — | High (perceived perf) |
| 1.6 | Add request ID via middleware + propagate to logger | 0.5 d | Low | — | High (incident response) |
| 1.7 | Bundle analyser + budget guardrail | 0.5 d | Low | — | Med |
| 1.8 | Move Sentry init into `instrumentation.ts` | 0.25 d | Low | — | Med |

**Phase 1 ROI**: closes one security class, fixes the worst perf path, unlocks Next 16 streaming, lights up DB observability. Two weeks, one engineer.

---

### Phase 2 — High-value improvements (sprint 3–6; ~6 weeks, 2 engineers)

| # | Item | Effort | Risk | Dep | ROI |
|---|---|---|---|---|---|
| 2.1 | Split `operations.ts` → `sales.ts` / `returns.ts` / `expenses.ts` | 1 d | Low | — | High (velocity) |
| 2.2 | Extract `useCart()` + sub-components from `SaleForm.tsx` | 3 d | Med | 2.4 | High (velocity) |
| 2.3 | Per-tab dynamic import on `app/settings/page.tsx` + SC shell | 2 d | Med | 2.4 | High (perf) |
| 2.4 | Playwright POS golden-path coverage | 3 d | Low | — | Very high (safety net) |
| 2.5 | Adopt RSC + streaming on dashboard, customers list, sales list, insights | 4 d | Med | 1.5 | High |
| 2.6 | Cursor pagination on sales / customers / products / activity_logs | 3 d | Med | 2.1 | High (scale) |
| 2.7 | Queue `logActivity` via BullMQ + DLQ + retry policy | 5 d | Med | 1.4 | High |
| 2.8 | Cache Components for read-mostly views (`use cache`/`cacheTag`) | 3 d | Low | 2.5 | High |
| 2.9 | Per-tenant API rate limit middleware | 2 d | Low | — | High (security + scale) |
| 2.10 | Move uploads to S3-compatible storage behind a `Storage` interface | 5 d | Med | — | Very high (scale) |
| 2.11 | Replace `console.*` with `logger.*` everywhere; lint rule | 2 d | Low | — | High (incident) |
| 2.12 | Co-derive zod schemas from Drizzle (`drizzle-zod`) — close the route ↔ repo drift gap | 3 d | Low | 2.1 | Med |

**Phase 2 ROI**: reaches 1,000-tenant readiness. Velocity unblocked. Observable. Streaming. Storage detached.

---

### Phase 3 — Architecture modernisation (sprint 7–12; ~3 months, 2–3 engineers)

| # | Item | Effort | Risk | Dep | ROI |
|---|---|---|---|---|---|
| 3.1 | Extract `lib/services/` for cross-cutting flows (sale + shift + wallet + notify + activity + digest) | 2 w | Med | 2.1, 2.7 | High |
| 3.2 | Move BullMQ worker to its own container; mod imported by both runners | 1 w | Low | 2.7 | Med |
| 3.3 | Convert mutating form submissions to Server Actions | 2 w | Med | 2.5 | Med |
| 3.4 | Introduce a payments strategy (`PaymentMethodHandler`) — ready for Paymob day-1 | 1 w | Low | — | Med |
| 3.5 | Hexagonal port/adapter for mailer + WhatsApp + storage + Sentry | 2 w | Low | 2.10 | Med |
| 3.6 | Replace ad-hoc state machine in cash-shifts with explicit FSM | 1 w | Low | 2.1 | Med |
| 3.7 | CSP `style-src` strict via Tailwind 4 nonce hook | 1–2 w | High | — | Med (security) |
| 3.8 | Push test coverage to ≥30 % via repo-layer unit tests + Playwright | 3 w | Low | 2.4 | Very high |
| 3.9 | Move admin to `apps/admin` (separate Next.js project) | 2 w | Med | 3.5 | Med |
| 3.10 | Introduce data-classification annotations + PDPL deletion pipeline | 1 w | Low | — | High (compliance) |

**Phase 3 ROI**: codebase reaches what Staff-engineer-led work looks like. Compliance ready. Test net trustable.

---

### Phase 4 — Scale to 10,000 tenants (Q2-Q3 of year 2)

| # | Item | Effort | Risk | Dep | ROI |
|---|---|---|---|---|---|
| 4.1 | Postgres read replica + read-only routing for insights / admin sales / digest | 2 w | Med | 1.4 | Very high |
| 4.2 | Partition `activity_logs` + `sales` by month (PARTITION BY RANGE created_at) | 2 w | Med | 4.1 | High |
| 4.3 | Connection pooler (PgBouncer in transaction mode); pool size ≥ 200 | 1 w | Med | 4.1 | Very high |
| 4.4 | Multi-replica web tier behind ALB; sticky for SSE OR Redis pub/sub bridge | 1 w | Med | 2.10 | Very high |
| 4.5 | Dedicated worker fleet (BullMQ) with explicit per-queue concurrency | 1 w | Low | 3.2 | High |
| 4.6 | Cron tasks scattered into per-tenant jobs on the queue (no more serial fan-out) | 2 w | Med | 4.5 | Very high |
| 4.7 | Per-tenant rate limits; tenant-level quota enforcement | 1 w | Low | 2.9 | High |
| 4.8 | Move PDF generation into a microservice | 1 w | Low | — | Med |
| 4.9 | Off-site backup + cross-region replication of the WAL | 2 w | Med | 1.4 | Very high |
| 4.10 | Blue/green or canary deploys with automatic rollback on health-check failure | 2 w | High | 4.4 | Very high |

**Phase 4 ROI**: confidently serve 10K active tenants with single-digit-minute MTTR.

---

### Phase 5 — Scale to 100,000 tenants (year 3)

| # | Item | Effort | Risk | Dep | ROI |
|---|---|---|---|---|---|
| 5.1 | Tenant sharding decision — Citus / per-region clusters / co-tenant pools | 2 mo | High | 4.x | Required |
| 5.2 | Multi-region deployment with regional Postgres + global control plane | 2 mo | High | 5.1 | Required |
| 5.3 | Object storage CDN for receipts + uploads + assets | 1 mo | Med | 2.10 | Very high |
| 5.4 | Search index for sales / inventory / customers (Postgres FTS or Meilisearch / Typesense) | 1 mo | Med | 4.2 | Very high |
| 5.5 | Tenant-isolated noisy-neighbour controls (per-tenant pool limits, query timeouts) | 3 w | Med | 4.3 | High |
| 5.6 | Per-tenant cost model + observability (tagged logs + spans) | 1 mo | Low | 4.x | Required for pricing |
| 5.7 | Disaster-recovery plan: RTO ≤ 1 h, RPO ≤ 5 min — drilled quarterly | 2 mo | High | 4.9 | Required |
| 5.8 | Schema evolution discipline (online migrations + ghost tables) | 1 mo | Med | 4.2 | High |
| 5.9 | Multi-AZ Redis cluster + read-from-replica for cache | 1 mo | Med | — | High |
| 5.10 | Edge runtime for read-only public endpoints (`/api/plans`, marketing) | 1 mo | Low | — | Med |

**Phase 5 ROI**: actual SaaS, actual platform team, actual on-call.

---

## 15. Production Hardening Report

| Control | State | Score |
|---|---|---|
| Disaster recovery (RTO/RPO documented) | **No RTO/RPO defined.** Restore drill documented in `task.md`. | 35 |
| Backup strategy | Daily pg_dump, 14 daily + 8 weekly, atomic write + size sanity check, off-site via optional hook. **Default deploy is on-host only.** | 55 |
| Restore strategy | Documented + idempotent + `RESTORE_CONFIRM=1` safety gate. Not regularly drilled. | 65 |
| Monitoring | `/healthz` (uptime), `/readyz` (DB + Redis + 1 s timeout). No metrics export. | 50 |
| Observability | Sentry configured, scrubbed. No tracing across requests. No request-ID propagation. | 45 |
| Tracing | Sentry traces sampler at 10 %. No domain spans. | 35 |
| Logging | Structured logger exists. 51 % of log sites use `console.*`. No log correlation. | 50 |
| Alerting | None documented. Sentry alerts presumably set externally. | 30 |
| Deployment safety | Multi-stage Docker, standalone build, runs as `nextjs` UID 1001. No managed pipeline. | 55 |
| Rollback strategy | None documented. Only `pg_dump` restore on a side DB. | 25 |
| Zero-downtime deploy | Single-instance compose deploy — no story. | 30 |
| Blue/green | Not configured; nginx template ready to flip upstream. | 35 |
| Canary | Not configured. | 25 |
| Per-tenant noisy-neighbour controls | None. | 25 |

**Production Hardening Score: 40 / 100.** Backups + healthz + readyz + Docker hardening + Sentry are the floor. Everything above that floor is a working assumption rather than a tested control.

---

## 16. Future Failure Analysis

### 1 month out

- **Pool exhaustion under concurrent POS load.** First 5+ concurrent cashiers + a cron tick + an insights query → write blocks. Symptom: random 500s, no obvious cause without `pg_stat_activity` inspection.
- **N+1 in cart sales becomes visible.** Slow POS reports from large carts; cashier frustration.
- **First `unsafe-inline` exploit theory in CSP report-only.** Someone files a report; you have to defer until the Tailwind 4 nonce path lands.
- **WhatsApp send rate-limited 30/min/tenant** — a Black Friday catalog blast trips it.

### 6 months out

- **`activity_logs` crosses 10 GB on the largest tenant.** Insights and admin sales overview slow markedly.
- **Cron runs cross the 5-minute mark** — orchestrator (compose? Vercel? whatever) times out a tick. Digest stops sending without a clear cause.
- **First incident requires log correlation across two routes.** Postmortem finds neither log line carries a request ID.
- **First "delete this customer's data" request lands.** PDPL clock is running; no scrub job.
- **Uploads folder grows past disk allocation.** Single-host failure mode.

### 1 year out

- **Single Postgres has 1+ TB of `sales` rows.** No partitioning means VACUUM bloat and seq-scan misery on insights.
- **Single Node process is the bottleneck for SSE notifications + cron + HTTP + worker.** First HA-redesign conversation.
- **Second engineer onboards.** `SaleForm.tsx` + `settings/page.tsx` cost a week each to ramp on.
- **First DR drill in anger.** Restore on a host shell, no RTO target, no measurement.
- **Auth.js v5 leaves beta with breaking changes; the upgrade is a quarter of work.**
- **Sentry traffic exceeds your sample budget.** Quality of alerting degrades.

### 3 years out

- **You either sharded by then or you have an incident report titled "tenant X's report took down everyone".**
- **The two paths in `lib/whatsapp/` and `lib/whatsapp.ts` are 18 months apart** — Green API legacy users still depend on it; nobody on the team has touched it in months.
- **Insights reports require a separate data warehouse.** OLAP queries on the OLTP DB are no longer tenable.
- **Compliance requires SOC 2.** Lack of structured logs + missing tracing + 0 alerting runbook becomes the gating audit finding.
- **`recordCartSale` Arabic exceptions** were the cause of 5+ "POS suddenly broken" tickets.

### Hidden technical debt (under-documented today)

- **`shop_settings` 5-min cache** assumes one writer per tenant — fine until you ship a mobile app or a webhook updates it.
- **`tenant_members.permissions` is a string array** — adding/removing permissions silently re-writes the array; no audit of permission changes per-key.
- **Branch context is mostly cookie-driven** — clearing cookies on logout works; sharing a session between two devices in different branches is undefined behaviour.
- **Cash-shift `auto-close` cuts at "yesterday in tenant timezone"** — DST transitions in non-Egypt timezones (future expansion) will misfire.
- **JWT cache (60 s)** means a revoked permission still works for up to 60 s — documented in code, not in user-facing copy.

### Architectural dead ends to watch

- **Per-tenant Green API instance** — does not horizontally scale beyond ~thousands of tenants without a queue + worker fleet.
- **Catalog "snapshot at sale time"** — works because catalogs are small. At 100K products per tenant, snapshotting per line gets expensive.
- **Single `tenants` row + `tenant_members`** — fine for one-shop, one-team. The day someone wants a franchise hierarchy you'll regret it.

### Future security concerns

- **Recovery codes hashed with bcrypt cost 10** — fine today, dated in 3 years.
- **`SECRET_KEY` is the master key for every WhatsApp token at rest.** No documented rotation. Mass re-encryption job needed.
- **No anomaly detection on failed logins** beyond per-IP / per-email rate limits.
- **No detection of cross-tenant data exfil via owner accounts.** Owner can read everything for one tenant — by design — but you have no audit alert for "owner exported 100K customer rows in one shot".

### Future performance concerns

- **PDF generation in-process** under web load on a single Node process. The day you ship "send receipts to 1,000 customers" you'll OOM the web tier.
- **Insights computed on the OLTP** — first quarter that someone runs a 30-day report you'll see a 30-second p95 on that endpoint.
- **No CDN strategy** — every receipt/static asset hits Node.

---

## 17. Engineering Scorecard

| Dimension | Score |
|---|---|
| Security | **78** |
| Architecture | **65** |
| SOLID | **60** |
| Clean Code | **68** |
| Performance | **55** |
| Scalability | **50** |
| Reliability | **62** |
| Maintainability | **65** |
| Type Safety | **80** |
| Testing | **35** |
| Production Readiness | **40** |
| Observability | **45** |
| Compliance (PDPL/GDPR) | **55** |
| Documentation (internal) | **80** |
| Incident readiness | **40** |
| **OVERALL** | **59 / 100** |

### Engineering level placement

- **Above Senior** in: security primitives, tenant-isolation discipline, hydration debugging, "why" comments.
- **At Senior** in: TypeScript hygiene, code conventions, file layout, error handling shape.
- **Below Staff** in: god files, testing depth, Next 16 fluency, observability.
- **Below Principal** in: scale story, disaster recovery, multi-region readiness, on-call posture.

**Codebase currently sits at: Senior+ (an early Staff trajectory).** With the Phase 1 + Phase 2 refactors, it would credibly read as Staff.

---

## 18. CTO Summary

> *"What do I have, what does it cost me, what do I need to decide this quarter?"*

### What you have

A multi-tenant POS / inventory / ERP SaaS that already does the structurally hard things right: forced row-level security, role-separated DB users, HMAC-verified webhooks, encrypted secrets, idempotent POS endpoints, opportunistic Redis cache, structured Auth.js with 2FA and recovery codes, daily encrypted backups with retention, a clean repo layer, and an unusually candid engineering changelog. It is a credibly senior-engineer-led product.

### What it costs you

You are paying three taxes that compound:

1. **Frontend tax** — 91 % of components are client; no streaming; one Server Action; six 1,000+ line files. Every UI feature lands slower than it should and every page is slower than it should be.
2. **Operational tax** — no managed deploy, no rollback, no canary, no per-tenant rate limits, no tracing, half the logs in `console.*`. First incident over 30 minutes will be a long one.
3. **Scale tax** — single Postgres / single Redis / single Node / uploads on host disk / serial cron / N+1 POS. Painful at 100 tenants, broken at 1,000.

### What to decide this quarter

**Decision 1 — Will you ship Phase 1 (2 weeks, one engineer) immediately?**
   It closes one security class, fixes the POS hot path, lights up DB observability, and stops user errors from looking like server failures. There is no reason to delay.

**Decision 2 — Are you going to 1,000 tenants this year?**
   If yes, fund Phase 2 (6 weeks, 2 engineers): worker fleet, S3 uploads, Server Components on the heavy reads, cursor pagination, per-tenant rate limits, replacement of `console.*`. After Phase 2 the codebase can sustain 1K tenants without re-architecture.

**Decision 3 — When do you want this to look like a Staff-engineer codebase?**
   Phase 3 (≈3 months, 2-3 engineers): split the god files, extract a service layer, push testing to ≥30 %, formalise the storage / mailer / WhatsApp adapter ports, harden CSP. This is the work that future engineers will thank you for.

**Decision 4 — When does multi-region / sharding research start?**
   Not yet. Start the *research* — not the build — at 1,000 tenants. Build at 5,000.

### What I would not do

- **Do not** rewrite anything from scratch. The bones are good.
- **Do not** move off Next.js / Drizzle / Postgres. They are the right tools.
- **Do not** start microservices. The repo layer is the boundary you'd be paying for; you already have it.

### What I would do tomorrow

- Two-pager out from the team: *the Phase 1 list, the dates, and the dashboard you'll watch on Monday morning to know if it worked*.
- Hire (or carve out from existing team) one engineer to do Phase 1 + Phase 2 over the next eight weeks.
- Schedule the first DR drill. Measure your actual RTO. Whatever number comes back, write it down — you now have a baseline.

**Final position**: This is a buy, not a sell. Spend on the next-quarter refactors before you spend on growth. Velocity returns immediately.
