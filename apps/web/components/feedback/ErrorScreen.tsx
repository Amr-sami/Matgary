import type { ReactNode } from "react";

interface ErrorScreenProps {
  illustration: ReactNode;
  title: string;
  description?: string;
  /** Primary + secondary CTAs (already-rendered <button>/<Link>). */
  actions?: ReactNode;
  /** Tiny technical detail (e.g. error.digest). Not shown when omitted. */
  hint?: string;
}

/**
 * Centered, full-height error / empty layout. Used by 404, error
 * boundaries, forbidden screens, and offline state. Keeps the brand
 * voice consistent — illustration on top, headline, supporting copy,
 * actions row.
 */
export function ErrorScreen({
  illustration,
  title,
  description,
  actions,
  hint,
}: ErrorScreenProps) {
  return (
    <div className="min-h-[70vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-5">
        <div className="mx-auto w-56 sm:w-64">{illustration}</div>
        <h1 className="font-display font-extrabold text-2xl sm:text-3xl text-text-primary leading-tight">
          {title}
        </h1>
        {description && (
          <p className="text-text-secondary text-base leading-relaxed">{description}</p>
        )}
        {actions && (
          <div className="flex flex-col sm:flex-row items-center justify-center gap-2 pt-2">
            {actions}
          </div>
        )}
        {hint && (
          <p
            dir="ltr"
            className="text-xs text-text-secondary/70 font-mono pt-4 truncate"
            title={hint}
          >
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
