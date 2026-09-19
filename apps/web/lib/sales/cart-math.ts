// Moved to packages/domain so the mobile POS shares the exact totals logic
// the web books. This shim keeps existing "@/lib/sales/cart-math" imports
// compiling; new code should import from "@matgary/domain" directly.
export * from "@matgary/domain/money/cart-math";
