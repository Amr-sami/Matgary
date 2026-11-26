"use client";

import { Suspense, useCallback, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { AppShell } from "@/components/layout/AppShell";
import { Toast } from "@/components/ui/Toast";
import { can } from "@/lib/permissions";
import { ConversationList } from "@/components/whatsapp/ConversationList";
import {
  ThreadView,
  type ThreadViewHandle,
} from "@/components/whatsapp/ThreadView";
import { MessageCircle } from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export default function WhatsAppInboxPage() {
  return (
    <Suspense fallback={null}>
      <WhatsAppInboxPageInner />
    </Suspense>
  );
}

function WhatsAppInboxPageInner() {
  const dict = useDictionary();
  const t = dict.app.whatsappInbox;
  const { data: session, status } = useSession();
  const principal = session?.user
    ? {
        role: session.user.role,
        permissions: session.user.permissions,
      }
    : null;
  const allowed = can(principal, "manage_whatsapp");

  const router = useRouter();
  const searchParams = useSearchParams();
  const activeId = searchParams.get("c");

  const [toast, setToast] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const [listRefreshTick, setListRefreshTick] = useState(0);
  const bumpListRefresh = useCallback(() => {
    setListRefreshTick((n) => n + 1);
  }, []);

  const threadRef = useRef<ThreadViewHandle | null>(null);

  const setActiveId = (id: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("c", id);
    else params.delete("c");
    router.replace(`/whatsapp${params.toString() ? "?" + params.toString() : ""}`);
  };

  if (status === "loading") {
    return (
      <AppShell title={t.title}>
        <div className="text-center py-12 text-text-secondary">
          {t.loading}
        </div>
      </AppShell>
    );
  }

  if (!allowed) {
    return (
      <AppShell title={t.title}>
        <div className="max-w-5xl mx-auto">
          <div className="bg-bg-card border border-border rounded-xl p-8 text-center text-text-secondary">
            {t.notAllowed}
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title={t.title}>
      <div className="max-w-6xl mx-auto h-[calc(100dvh-9rem)]">
        <div className="h-full grid md:grid-cols-[340px_1fr] gap-3">
          <div
            className={
              activeId ? "hidden md:block h-full" : "block h-full"
            }
          >
            <ConversationList
              activeId={activeId}
              onSelect={setActiveId}
              refreshSignal={listRefreshTick}
            />
          </div>
          <div
            className={
              activeId ? "block h-full" : "hidden md:flex h-full items-center justify-center"
            }
          >
            {activeId ? (
              <ThreadView
                key={activeId}
                ref={threadRef}
                conversationId={activeId}
                onBack={() => setActiveId(null)}
                onChanged={bumpListRefresh}
                onError={(message) => setToast({ type: "error", message })}
              />
            ) : (
              <div className="text-center text-text-secondary">
                <MessageCircle className="w-12 h-12 mx-auto mb-3 opacity-40" />
                <p className="text-sm">{t.selectHint}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}
    </AppShell>
  );
}
