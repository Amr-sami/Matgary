/**
 * Shared loading card used as the Suspense fallback for auth pages whose
 * inner content is gated on useSearchParams(). Replaces the bare "…"
 * placeholder we had before — that looked broken on slow networks and
 * gave no indication anything was happening.
 *
 * Server component on purpose so it renders instantly with no client JS.
 */
import { Loader2 } from "@/lib/icons";

export function AuthSuspenseCard() {
  return (
    <div className="w-full bg-white p-4 lg:p-8 lg:rounded-2xl lg:shadow-sm lg:border lg:border-border">
      <div className="flex flex-col items-center justify-center gap-3 py-8 text-text-secondary">
        <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
        <span className="sr-only">Loading</span>
      </div>
    </div>
  );
}
