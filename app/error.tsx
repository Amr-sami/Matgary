"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { ErrorScreen } from "@/components/feedback/ErrorScreen";
import {
  ErrorIllustration,
  OfflineIllustration,
} from "@/components/feedback/illustrations";

interface AppErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Heuristic — many "errors" inside an SPA are actually network blips
 * (fetch failures while offline, dropped tunnels). Show a friendlier
 * "no connection" screen for those instead of the generic crash one.
 */
function looksLikeNetworkError(message: string) {
  const m = message.toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("network") ||
    m.includes("load failed") ||
    m.includes("err_internet_disconnected")
  );
}

export default function AppError({ error, reset }: AppErrorProps) {
  useEffect(() => {
    // Surface to the browser console — easier debugging than the
    // overlay-only stack we'd otherwise see in production.
    console.error("[app/error]", error);
  }, [error]);

  const isNetwork = looksLikeNetworkError(error.message ?? "");

  return (
    <ErrorScreen
      illustration={isNetwork ? <OfflineIllustration /> : <ErrorIllustration />}
      title={isNetwork ? "لا يوجد اتصال بالإنترنت" : "حدث خطأ غير متوقع"}
      description={
        isNetwork
          ? "تعذر الوصول إلى الخادم. تحقق من اتصالك بالإنترنت ثم أعد المحاولة."
          : "نأسف للإزعاج — حدث خطأ أثناء تحميل هذه الصفحة. يمكنك المحاولة مرة أخرى."
      }
      actions={
        <>
          <Button onClick={reset} className="w-full sm:w-auto">
            إعادة المحاولة
          </Button>
          <Link href="/">
            <Button variant="secondary" className="w-full sm:w-auto">
              العودة للرئيسية
            </Button>
          </Link>
        </>
      }
      hint={error.digest}
    />
  );
}
