"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import QRCode from "qrcode";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { ShieldCheck } from "@/lib/icons";

function DeleteTenantCard({ isOwner }: { isOwner: boolean }) {
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
          SLUG_MISMATCH: "اسم المتجر لا يطابق",
          Forbidden: "غير مسموح",
        };
        setError(map[body.error ?? ""] ?? "تعذر التحديد");
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
      <p className="text-sm font-medium text-danger">حذف المتجر نهائياً</p>
      <p className="text-xs text-text-secondary">
        يحذف كل البيانات (المنتجات، المبيعات، الموظفين، السجلات) بعد فترة سماح ٣٠ يوماً. يمكنك التراجع خلالها.
      </p>
      {scheduledAt ? (
        <div className="space-y-2 bg-danger/5 rounded-lg p-3">
          <p className="text-xs text-text-secondary">
            موعد الحذف: <span dir="ltr" className="font-mono">{new Date(scheduledAt).toISOString().slice(0, 10)}</span>
          </p>
          <Button variant="secondary" onClick={cancel} loading={busy}>إلغاء الحذف</Button>
        </div>
      ) : (
        <>
          <p className="text-xs text-text-secondary">للتأكيد، اكتب اسم المتجر (slug) كما يظهر في عنوان تسجيل الدخول:</p>
          <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="my-store" dir="ltr" />
          {error && <p className="text-xs text-danger">{error}</p>}
          <Button variant="secondary" onClick={schedule} loading={busy} disabled={!slug.trim()}>
            بدء عملية الحذف (٣٠ يوماً)
          </Button>
        </>
      )}
    </div>
  );
}

// H03 — /account/security. Owner-only enrolment + management UI for TOTP 2FA.
// Manual-secret entry path (no QR rendering in v1; mobile authenticator apps
// accept either a pasted secret or a tapped otpauth:// link).

type Status = "loading" | "off" | "enrolling" | "on" | "showingCodes";

interface EnrollmentPreview {
  secret: string;
  otpauthUri: string;
}

export default function SecurityPage() {
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
    // Probe initial state via the session — the JWT carries no 2FA flag so
    // we'd ideally fetch /api/account/me. For v1, lean on a tiny lookup.
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
      if (!res.ok) throw new Error("تعذر بدء التفعيل");
      const p = (await res.json()) as EnrollmentPreview;
      setPreview(p);
      // Render the otpauth:// URI as a QR data URI so phones can scan it.
      // 256 px is enough for any reasonable camera; margin=1 keeps the
      // quiet zone narrow so it fits nicely on a card.
      try {
        const dataUri = await QRCode.toDataURL(p.otpauthUri, {
          width: 256,
          margin: 1,
          errorCorrectionLevel: "M",
        });
        setQrDataUri(dataUri);
      } catch {
        setQrDataUri(null); // fall back to manual paste only
      }
      setStatus("enrolling");
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطأ غير متوقع");
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
        setError(body.error === "INVALID_TOTP" ? "الرمز غير صحيح" : "تعذر التفعيل");
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
          BAD_PASSWORD: "كلمة المرور غير صحيحة",
          INVALID_TOTP: "الرمز غير صحيح",
          NOT_ENROLLED: "2FA غير مفعلة",
        };
        setError(map[body.error ?? ""] ?? "تعذر التعطيل");
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
          BAD_PASSWORD: "كلمة المرور غير صحيحة",
          INVALID_TOTP: "الرمز غير صحيح",
        };
        setError(map[body.error ?? ""] ?? "تعذر التجديد");
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
      <AppShell title="الأمان">
        <div className="p-8 text-center text-text-secondary">…</div>
      </AppShell>
    );
  }

  if (!isOwner) {
    return (
      <AppShell title="الأمان">
        <div className="max-w-xl mx-auto p-8 text-center">
          <p className="text-text-secondary">المصادقة الثنائية متاحة لمالك المتجر فقط في هذه النسخة.</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="الأمان">
    <div className="max-w-xl mx-auto p-6 space-y-6">
      <header className="flex items-center gap-3">
        <ShieldCheck className="w-7 h-7 text-accent" />
        <div>
          <h1 className="text-2xl font-bold text-text-primary">المصادقة الثنائية (2FA)</h1>
          <p className="text-sm text-text-secondary">
            طبقة حماية إضافية فوق كلمة السر — تطبيق المصادقة على هاتفك يولّد رمزاً من 6 أرقام يتغير كل 30 ثانية.
          </p>
        </div>
      </header>

      {error && (
        <p className="bg-danger-light text-danger px-4 py-2 rounded-lg text-sm">{error}</p>
      )}

      {status === "off" && (
        <div className="bg-white rounded-2xl border border-border p-6 space-y-4">
          <p className="text-text-secondary text-sm">
            الحالة الحالية: <span className="text-text-primary font-medium">معطلة</span>
          </p>
          <Button onClick={startEnroll} loading={busy}>تفعيل المصادقة الثنائية</Button>
        </div>
      )}

      {status === "enrolling" && preview && (
        <div className="bg-white rounded-2xl border border-border p-6 space-y-4">
          <p className="text-sm text-text-secondary">
            1) افتح تطبيق المصادقة على هاتفك (Google Authenticator / Microsoft Authenticator / Authy)، ثم اختر "إضافة حساب → مسح الكود":
          </p>
          {qrDataUri && (
            <div className="flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrDataUri}
                alt="QR للمصادقة الثنائية"
                width={256}
                height={256}
                className="rounded-lg border border-border bg-white p-2"
              />
            </div>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-text-secondary hover:text-text-primary">
              لا يمكنك مسح الكود؟ أدخله يدوياً
            </summary>
            <div className="mt-3 space-y-2">
              <p className="text-xs text-text-secondary">
                في تطبيق المصادقة، اختر "إضافة حساب → إدخال يدوي" والصق هذا المفتاح:
              </p>
              <div className="font-mono text-center bg-bg-main rounded-lg p-3 select-all" dir="ltr">
                {preview.secret.match(/.{1,4}/g)?.join(" ")}
              </div>
              <p className="text-xs text-text-secondary">
                أو على نفس الجهاز، اضغط الرابط لإضافة الحساب مباشرة:
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
            2) أدخل الرمز المكوّن من 6 أرقام الذي يعرضه التطبيق الآن:
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
            <Button variant="secondary" onClick={() => setStatus("off")} disabled={busy}>إلغاء</Button>
            <Button onClick={confirmEnroll} loading={busy} disabled={code.length !== 6}>تأكيد التفعيل</Button>
          </div>
        </div>
      )}

      {status === "showingCodes" && (
        <div className="bg-white rounded-2xl border border-border p-6 space-y-4">
          <p className="text-sm text-text-primary font-medium">
            احفظ هذه الرموز الاحتياطية في مكان آمن — لن تظهر مرة أخرى. كل رمز يصلح لمرة واحدة فقط ويفتح حسابك إذا فقدت هاتفك.
          </p>
          <div className="font-mono bg-bg-main rounded-lg p-3 grid grid-cols-2 gap-2 text-center" dir="ltr">
            {recoveryCodes.map((c) => (
              <span key={c} className="select-all">{c}</span>
            ))}
          </div>
          <Button onClick={() => setStatus("on")}>فهمت، حفظتها</Button>
        </div>
      )}

      {(status === "on" || status === "off") && <DeleteTenantCard isOwner={isOwner} />}

      {(status === "on" || status === "off") && (
        <div className="bg-white rounded-2xl border border-border p-6 space-y-3">
          <p className="text-sm font-medium">تنزيل نسخة من بيانات متجرك</p>
          <p className="text-xs text-text-secondary">
            ملف JSON يحتوي كل الجداول التابعة لهذا المتجر (المنتجات، المبيعات، الموظفين، السجلات…). يتم تحميله مباشرة على جهازك.
          </p>
          <Button
            variant="secondary"
            onClick={async () => {
              setExporting(true);
              try {
                const res = await fetch("/api/account/export", { method: "POST" });
                if (!res.ok) {
                  setError("تعذر التنزيل. حاول مرة أخرى لاحقاً.");
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
            تنزيل البيانات
          </Button>
        </div>
      )}

      {(status === "on" || status === "off") && (
        <div className="bg-white rounded-2xl border border-border p-6 space-y-3">
          <p className="text-sm font-medium">تسجيل خروج من جميع الأجهزة</p>
          <p className="text-xs text-text-secondary">
            ينهي كل جلسات هذا الحساب فوراً، بما في ذلك الجلسة الحالية. مفيد إذا فقدت جهازاً أو شككت في تسريب حسابك.
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
            تسجيل الخروج من كل مكان
          </Button>
        </div>
      )}

      {status === "on" && (
        <>
          <div className="bg-white rounded-2xl border border-border p-6 space-y-4">
            <p className="text-sm text-text-secondary">2FA الحالة الحالية: <span className="text-success font-medium">مفعّلة</span></p>
            <div className="space-y-3 pt-2">
              <p className="text-sm font-medium">تجديد الرموز الاحتياطية</p>
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} placeholder="كلمة المرور الحالية" autoComplete="current-password" />
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="رمز التطبيق (6 أرقام)" maxLength={6} dir="ltr" inputMode="numeric" autoComplete="one-time-code" />
              <Button onClick={regenerate} loading={busy}>تجديد الرموز</Button>
            </div>
          </div>
          <div className="bg-white rounded-2xl border border-border p-6 space-y-4">
            <p className="text-sm font-medium text-danger">تعطيل المصادقة الثنائية</p>
            <p className="text-xs text-text-secondary">
              يضعف حماية حسابك. لا تفعل ذلك إلا إذا كنت متأكداً.
            </p>
            <Button variant="secondary" onClick={disable} loading={busy} disabled={!password || code.length !== 6}>
              تعطيل (يستخدم نفس كلمة المرور + الرمز أعلاه)
            </Button>
          </div>
        </>
      )}
    </div>
    </AppShell>
  );
}
