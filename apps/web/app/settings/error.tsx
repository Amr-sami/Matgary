"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/Button";

export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/settings/error]", error);
  }, [error]);
  return (
    <div className="p-6">
      <h2 className="text-lg font-bold text-text-primary mb-2">
        تعذر تحميل الإعدادات
      </h2>
      <p className="text-sm text-text-secondary mb-4">
        حدث خطأ أثناء تحميل الإعدادات. أعد المحاولة.
      </p>
      <div className="flex gap-2">
        <Button onClick={reset}>إعادة المحاولة</Button>
      </div>
      {error.digest && (
        <p className="mt-4 text-xs text-text-secondary">
          المرجع: <code>{error.digest}</code>
        </p>
      )}
    </div>
  );
}
