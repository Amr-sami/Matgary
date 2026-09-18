// Shared business logic — imported by BOTH apps/web and apps/mobile.
//
// What belongs here: zod schemas, the permission model, money/cart maths, the
// Egyptian phone normaliser, formatting helpers, notification event types.
//
// What must NEVER be here: anything importing `next/*`, React DOM, React
// Native, Tailwind classes, or a database client. If it cannot run in both a
// Next server component and a Hermes JS engine, it does not belong.
//
// Migration is deliberate and incremental (doc 06 §11): move one module at a
// time with `git mv`, re-point the web imports, and let tsc prove nothing broke.
export * from "./money/cart-math";
export * from "./escpos";
