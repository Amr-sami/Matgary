"use client";

import { InputHTMLAttributes, forwardRef, useState } from "react";
import { Eye, EyeOff } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useOptionalDictionary } from "@/components/i18n/DictionaryProvider";

interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  error?: string;
}

/**
 * Password field with a show/hide toggle so users can verify what they're
 * typing — the #1 cause of "incorrect credentials" with hand-typed passwords.
 */
const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, label, error, ...props }, ref) => {
    const [visible, setVisible] = useState(false);
    // PasswordInput is also used on logged-in /account/security which sits
    // outside the [lang] tree (no DictionaryProvider). Fall back to Arabic
    // there to keep parity with the rest of the logged-in surface.
    const dict = useOptionalDictionary();
    const t = dict?.common ?? {
      showPassword: "إظهار كلمة السر",
      hidePassword: "إخفاء كلمة السر",
      show: "إظهار",
      hide: "إخفاء",
    };
    return (
      <div className="w-full">
        {label && (
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            {label}
          </label>
        )}
        <div
          className={cn(
            "flex items-center gap-1 bg-white border border-border rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-accent",
            error && "border-danger focus-within:ring-danger",
          )}
        >
          <input
            ref={ref}
            type={visible ? "text" : "password"}
            className={cn(
              "flex-1 px-4 py-2.5 bg-transparent text-text-primary placeholder:text-text-secondary focus:outline-none",
              className,
            )}
            {...props}
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className="px-3 py-2.5 text-text-secondary hover:text-accent transition-colors"
            tabIndex={-1}
            aria-label={visible ? t.hidePassword : t.showPassword}
            title={visible ? t.hide : t.show}
          >
            {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        {error && <p className="mt-1 text-sm text-danger">{error}</p>}
      </div>
    );
  },
);

PasswordInput.displayName = "PasswordInput";

export { PasswordInput };
