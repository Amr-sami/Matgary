// Test-only stub for Next.js's `server-only` package. The real package
// throws at build time when imported from a client bundle; under vitest
// there is no client bundle to guard, so the import becomes a no-op.
// Aliased in vitest.config.ts.

export {};
