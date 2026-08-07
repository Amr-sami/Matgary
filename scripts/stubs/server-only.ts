// `server-only` is a build-time guard, not a runtime library. Next's compiler
// resolves the bare specifier itself and fails the build if a Client Component
// pulls in a module that imports it. It is deliberately NOT a package.json
// dependency, so nothing outside Next can resolve it — which is why any CLI
// tool run through tsx dies at `import "server-only"` the moment it reaches
// lib/logger.ts, lib/demo/clone-tenant.ts, or any of the other ~10 modules
// that carry the guard.
//
// scripts/seed-demo-template.ts hits exactly that: it imports @/lib/repo/tasks
// → repo/notifications → notifications/events → lib/logger.
//
// tsconfig.scripts.json maps the specifier here so the seed and maintenance
// scripts can import the same lib/ modules the app does. Empty on purpose —
// the guard means nothing outside a React Server Components graph, and the
// real enforcement still happens during `next build`, which never sees this
// file (tsconfig.json excludes scripts/).
export {};
