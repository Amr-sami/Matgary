"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
// `qrcode` is loaded on-demand inside startEnroll() — the user only ever
// needs it when they tap "Enable 2FA". Keeping it out of the page bundle
// trims ~12 KB gzipped from every visit to /account/security.
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { ShieldCheck } from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

function DeleteTenantCard({ isOwner }: { isOwner: boolean }) {
  const dict = useDictionary();
  const t = dict.app.accountSecurity.delete;
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOwner) return;
    void (async () => {
      const res = await fetch("/api/account/2fa-status"); // dummy ping
      if (!res.ok) return;
    })();
  }, [isOwner]);

  if (!isOwner) return null;
  const schedule = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmSlug: slug.trim() }),
      });
      const body = (await res.json()) as { scheduledAt?: string; error?: string };
      if (!res.ok) {
        const map: Record<string, string> = {
          SLUG_MISMATCH: t.errors.slugMismatch,
          Forbidden: t.errors.forbidden,
        };
        setError(map[body.error ?? ""] ?? t.errors.genericError);
        return;
      }
      setScheduledAt(body.scheduledAt ?? null);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      await fetch("/api/account/delete/cancel", { method: "POST" });
      setScheduledAt(null);
      setSlug("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bg-white rounded-2xl border border-danger/30 p-6 space-y-3">
      <p className="text-sm font-medium text-danger">{t.title}</p>
      <p className="text-xs text-text-secondary">
        {t.intro}
      </p>
      {scheduledAt ? (
        <div className="space-y-2 bg-danger/5 rounded-lg p-3">
          <p className="text-xs text-text-secondary">
            {t.scheduledLabel}{" "}
            <span dir="ltr" className="font-mono">
              {new Date(scheduledAt).toISOString().slice(0, 10)}
            </span>
          </p>
          <Button variant="secondary" onClick={cancel} loading={busy}>{t.cancelButton}</Button>
        </div>
      ) : (
        <>
          <p className="text-xs text-text-secondary">{t.confirmHint}</p>
          <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t.slugPlaceholder} dir="ltr" />
          {error && <p className="text-xs text-danger">{error}</p>}
          <Button variant="secondary" onClick={schedule} loading={busy} disabled={!slug.trim()}>
            {t.startButton}
          </Button>
        </>
      )}
    </div>
  );
}

// H03 — /account/security. Owner-only enrolment + management UI for TOTP 2FA.
type Status = "loading" | "off" | "enrolling" | "on" | "showingCodes";

interface EnrollmentPreview {
  secret: string;
  otpauthUri: string;
}

export default function SecurityPage() {
  const dict = useDictionary();
  const t = dict.app.accountSecurity;
  const { data: session } = useSession();
  const [status, setStatus] = useState<Status>("loading");
  const [preview, setPreview] = useState<EnrollmentPreview | null>(null);
  const [qrDataUri, setQrDataUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/account/2fa-status").catch(() => null);
      if (!res?.ok) {
        setStatus("off");
        return;
      }
      const { enabled } = (await res.json()) as { enabled: boolean };
      setStatus(enabled ? "on" : "off");
    })();
  }, []);

  const isOwner = session?.user?.role === "owner";

  const startEnroll = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/account/2fa/start", { method: "POST" });
      if (!res.ok) throw new Error(t.errors.startFailed);
      const p = (await res.json()) as EnrollmentPreview;
      setPreview(p);
      try {
        const { default: QRCode } = await import("qrcode");
        const dataUri = await QRCode.toDataURL(p.otpauthUri, {
          width: 256,
          margin: 1,
          errorCorrectionLevel: "M",
        });
        setQrDataUri(dataUri);
      } catch {
        setQrDataUri(null);
      }
      setStatus("enrolling");
    } catch (e) {
      setError(e instanceof Error ? e.message : t.errors.unexpected);
    } finally {
      setBusy(false);
    }
  };

  const confirmEnroll = async () => {
    if (!preview) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/account/2fa/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: preview.secret, code }),
      });
      const body = (await res.json()) as { recoveryCodes?: string[]; error?: string };
      if (!res.ok) {
        setError(body.error === "INVALID_TOTP" ? t.errors.badCode : t.errors.enableFailed);
        return;
      }
      setRecoveryCodes(body.recoveryCodes ?? []);
      setStatus("showingCodes");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/account/2fa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, code }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        const map: Record<string, string> = {
          BAD_PASSWORD: t.errors.badPassword,
          INVALID_TOTP: t.errors.badCode,
          NOT_ENROLLED: t.errors.notEnrolled,
        };
        setError(map[body.error ?? ""] ?? t.errors.disableFailed);
        return;
      }
      setStatus("off");
      setPassword("");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/account/2fa/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, code }),
      });
      const body = (await res.json()) as { recoveryCodes?: string[]; error?: string };
      if (!res.ok) {
        const map: Record<string, string> = {
          BAD_PASSWORD: t.errors.badPassword,
          INVALID_TOTP: t.errors.badCode,
        };
        setError(map[body.error ?? ""] ?? t.errors.regenerateFailed);
        return;
      }
      setRecoveryCodes(body.recoveryCodes ?? []);
      setStatus("showingCodes");
      setPassword("");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  if (status === "loading") {
    return (
      <AppShell title={t.title}>
        <div className="p-8 text-center text-text-secondary">…</div>
      </AppShell>
    );
  }

  if (!isOwner) {
    return (
      <AppShell title={t.title}>
        <div className="max-w-xl mx-auto p-8 text-center">
          <p className="text-text-secondary">{t.staffNotice}</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title={t.title}>
    <div className="max-w-xl mx-auto p-6 space-y-6">
      <header className="flex items-center gap-3">
        <ShieldCheck className="w-7 h-7 text-accent" />
        <div>
          <h1 className="text-2xl font-bold text-text-primary">{t.heading}</h1>
          <p className="text-sm text-text-secondary">
            {t.subhead}
          </p>
        </div>
      </header>

      {error && (
        <p className="bg-danger-light text-danger px-4 py-2 rounded-lg text-sm">{error}</p>
      )}

      {status === "off" && (
        <div className="bg-white rounded-2xl border border-border p-6 space-y-4">
          <p className="text-text-secondary text-sm">
            {t.statusOffLine}
            <span className="text-text-primary font-medium">{t.statusOff}</span>
          </p>
          <Button onClick={startEnroll} loading={busy}>{t.enableButton}</Button>
        </div>
      )}

      {status === "enrolling" && preview && (
        <div className="bg-white rounded-2xl border border-border p-6 space-y-4">
          <p className="text-sm text-text-secondary">
            {t.enrollStep1}
          </p>
          {qrDataUri && (
            <div className="flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrDataUri}
                alt={t.qrAlt}
                width={256}
                height={256}
                className="rounded-lg border border-border bg-white p-2"
              />
            </div>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-text-secondary hover:text-text-primary">
              {t.manualSummary}
            </summary>
            <div className="mt-3 space-y-2">
              <p className="text-xs text-text-secondary">
                {t.manualHint}
              </p>
              <div className="font-mono text-center bg-bg-main rounded-lg p-3 select-all" dir="ltr">
                {preview.secret.match(/.{1,4}/g)?.join(" ")}
              </div>
              <p className="text-xs text-text-secondary">
                {t.linkHint}
              </p>
              <a
                href={preview.otpauthUri}
                className="block text-center text-accent underline break-all text-xs"
                dir="ltr"
              >
                {preview.otpauthUri}
              </a>
            </div>
          </details>
          <p className="text-sm text-text-secondary">
            {t.enrollStep2}
          </p>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            maxLength={6}
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
          />
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStatus("off")} disabled={busy}>{t.cancel}</Button>
            <Button onClick={confirmEnroll} loading={busy} disabled={code.length !== 6}>{t.confirmEnroll}</Button>
          </div>
        </div>
      )}

      {status === "showingCodes" && (
        <div className="bg-white rounded-2xl border border-border p-6 space-y-4">
          <p className="text-sm text-text-primary font-medium">
            {t.codesHeading}
          </p>
          <div className="font-mono bg-bg-main rounded-lg p-3 grid grid-cols-2 gap-2 text-center" dir="ltr">
            {recoveryCodes.map((c) => (
              <span key={c} className="select-all">{c}</span>
            ))}
          </div>
          <Button onClick={() => setStatus("on")}>{t.codesUnderstood}</Button>
        </div>
      )}

      {(status === "on" || status === "off") && <DeleteTenantCard isOwner={isOwner} />}

      {(status === "on" || status === "off") && (
        <div className="bg-white rounded-2xl border border-border p-6 space-y-3">
          <p className="text-sm font-medium">{t.export.title}</p>
          <p className="text-xs text-text-secondary">
            {t.export.intro}
          </p>
          <Button
            variant="secondary"
            onClick={async () => {
              setExporting(true);
              try {
                const res = await fetch("/api/account/export", { method: "POST" });
                if (!res.ok) {
                  setError(t.export.error);
                  return;
                }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                const cd = res.headers.get("content-disposition") ?? "";
                const match = cd.match(/filename="([^"]+)"/);
                a.download = match?.[1] ?? "matgary-export.json";
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              } finally {
                setExporting(false);
              }
            }}
            loading={exporting}
          >
            {t.export.button}
          </Button>
        </div>
      )}

      {(status === "on" || status === "off") && (
        <div className="bg-white rounded-2xl border border-border p-6 space-y-3">
          <p className="text-sm font-medium">{t.revoke.title}</p>
          <p className="text-xs text-text-secondary">
            {t.revoke.intro}
          </p>
          <Button
            variant="secondary"
            onClick={async () => {
              setRevoking(true);
              try {
                await fetch("/api/account/sessions/revoke-all", { method: "POST" });
              } finally {
                window.location.href = "/login";
              }
            }}
            loading={revoking}
          >
            {t.revoke.button}
          </Button>
        </div>
      )}

      {status === "on" && (
        <>
          <div className="bg-white rounded-2xl border border-border p-6 space-y-4">
            <p className="text-sm text-text-secondary">
              {t.statusOnLine}
              <span className="text-success font-medium">{t.statusOn}</span>
            </p>
            <div className="space-y-3 pt-2">
              <p className="text-sm font-medium">{t.regenerateHeading}</p>
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t.currentPasswordPlaceholder} autoComplete="current-password" />
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t.codePlaceholder} maxLength={6} dir="ltr" inputMode="numeric" autoComplete="one-time-code" />
              <Button onClick={regenerate} loading={busy}>{t.regenerate}</Button>
            </div>
          </div>
          <div className="bg-white rounded-2xl border border-border p-6 space-y-4">
            <p className="text-sm font-medium text-danger">{t.disableHeading}</p>
            <p className="text-xs text-text-secondary">
              {t.disableHint}
            </p>
            <Button variant="secondary" onClick={disable} loading={busy} disabled={!password || code.length !== 6}>
              {t.disableButton}
            </Button>
          </div>
        </>
      )}
    </div>
    </AppShell>
  );
}
