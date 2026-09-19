// Moved to packages/domain so the mobile app scrubs Sentry events with the
// exact same denylist the web does (doc 06 §2.11 / §10.2). This shim keeps
// existing "@/lib/sentry/scrub" imports compiling; new code should import
// from "@matgary/domain/observability/scrub" directly.
export * from "@matgary/domain/observability/scrub";
