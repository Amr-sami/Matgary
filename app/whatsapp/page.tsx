"use client";

import { useCallback, useRef, useState } from "react";
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

export default function WhatsAppInboxPage() {
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
  // The active conversation lives in the URL so refresh/back/share all
  // work. `c=<id>` keeps the path stable at /whatsapp.
  const activeId = searchParams.get("c");

  const [toast, setToast] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Refresh signal — bumped by the thread when it sends, archives,
  // marks-read, etc., so the conversation list re-polls immediately
  // instead of waiting for its 10s tick.
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
      <AppShell title="WhatsApp">
        <div className="text-center py-12 text-text-secondary">
          جارٍ التحميل...
        </div>
      </AppShell>
    );
  }

  if (!allowed) {
    return (
      <AppShell title="WhatsApp">
        <div className="max-w-5xl mx-auto">
          <div className="bg-bg-card border border-border rounded-xl p-8 text-center text-text-secondary">
            ليس لديك صلاحية لعرض محادثات واتساب.
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="WhatsApp">
      <div className="max-w-6xl mx-auto h-[calc(100dvh-9rem)]">
        {/* Desktop: list + thread side-by-side. Mobile: stack — show
            list when no conversation is selected, thread when one is. */}
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
                <p className="text-sm">اختر محادثة لعرض الرسائل.</p>
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
