"use client";

import { useEffect } from "react";

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Last-resort error boundary — runs when the root layout itself fails
 * (so the SettingsProvider, fonts, etc. are unavailable). Keep this
 * dependency-free: no app components, no Tailwind utilities that
 * depend on globals.css being loaded.
 */
export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    console.error("[global-error]", error);
  }, [error]);

  return (
    <html lang="ar" dir="rtl">
      <body
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          background: "#fff",
          color: "#1A1A1A",
          padding: "1.5rem",
          margin: 0,
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <svg
            viewBox="0 0 240 200"
            width="200"
            height="160"
            style={{ marginInline: "auto", display: "block" }}
            aria-hidden
          >
            <ellipse cx="120" cy="180" rx="95" ry="8" fill="#E7E6FC" />
            <path
              d="M120 30 L205 165 L35 165 Z"
              fill="#E7E6FC"
              stroke="#1203E3"
              strokeWidth="6"
              strokeLinejoin="round"
            />
            <rect x="113" y="70" width="14" height="55" rx="7" fill="#1203E3" />
            <circle cx="120" cy="143" r="8" fill="#1203E3" />
          </svg>
          <h1
            style={{
              fontSize: "1.5rem",
              fontWeight: 800,
              margin: "1.25rem 0 0.5rem",
            }}
          >
            تعذر تحميل التطبيق
          </h1>
          <p
            style={{
              color: "#6B6B6B",
              fontSize: "0.95rem",
              lineHeight: 1.6,
              margin: "0 0 1.5rem",
            }}
          >
            حدث خطأ جذري في تشغيل التطبيق. أعد تحميل الصفحة. إن استمرت
            المشكلة، تواصل مع الدعم.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              display: "inline-block",
              background: "#1203E3",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "0.625rem 1.25rem",
              fontSize: "0.95rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            إعادة المحاولة
          </button>
          {error.digest && (
            <p
              dir="ltr"
              style={{
                marginTop: "1rem",
                fontSize: "0.7rem",
                color: "#999",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
              }}
            >
              {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
