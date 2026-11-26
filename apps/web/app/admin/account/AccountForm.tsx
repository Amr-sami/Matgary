"use client";

import { useState } from "react";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface Props {
  initialEmail: string;
  initialDisplayName: string;
  role: string;
  lastLoginAt: string | null;
}

export function AccountForm({
  initialEmail,
  initialDisplayName,
  role,
  lastLoginAt,
}: Props) {
  const dict = useDictionary();
  const t = dict.app.admin.account;
  const [email, setEmail] = useState(initialEmail);
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [currentPassword, setCurrentPassword] = useState("");
  const [status, setStatus] = useState<{ type: "ok" | "err"; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const emailChanged = email !== initialEmail;
  const displayChanged = displayName !== initialDisplayName;
  const dirty = emailChanged || displayChanged;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    if (emailChanged && !currentPassword) {
      setStatus({ type: "err", msg: t.errors.needPassword });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const body: Record<string, string> = {};
      if (displayChanged) body.displayName = displayName.trim();
      if (emailChanged) {
        body.email = email.trim();
        body.currentPassword = currentPassword;
      }
      const res = await fetch("/api/admin/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus({
          type: "err",
          msg: mapError(j.error, t.errors),
        });
        return;
      }
      setStatus({ type: "ok", msg: t.saved });
      setCurrentPassword("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          {t.emailLabel}
        </label>
        <input
          type="email"
          dir="ltr"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          {t.displayNameLabel}
        </label>
        <input
          type="text"
          dir="auto"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {emailChanged && (
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            {t.currentPasswordForEmail}
          </label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      )}

      <div className="text-xs text-text-secondary space-y-0.5">
        <p>
          {t.roleLabel}: {role}
        </p>
        {lastLoginAt && (
          <p>
            {t.lastLoginLabel}: {new Date(lastLoginAt).toLocaleString()}
          </p>
        )}
      </div>

      {status && (
        <p
          className={`text-xs rounded-md px-3 py-2 ${
            status.type === "ok"
              ? "bg-success-light text-success"
              : "bg-danger-light text-danger"
          }`}
        >
          {status.msg}
        </p>
      )}

      <button
        type="submit"
        disabled={!dirty || saving}
        className="h-9 px-4 rounded-lg bg-accent text-white text-sm font-semibold hover:bg-accent/90 disabled:opacity-50"
      >
        {saving ? t.saving : t.save}
      </button>
    </form>
  );
}

interface ErrorsT {
  needPassword: string;
  wrongPassword: string;
  generic: string;
}

function mapError(code: string | undefined, errors: ErrorsT): string {
  switch (code) {
    case "NEED_PASSWORD":
      return errors.needPassword;
    case "WRONG_CURRENT":
      return errors.wrongPassword;
    default:
      return errors.generic;
  }
}
