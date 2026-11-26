"use client";

import { useSession } from "next-auth/react";
import { useSettings } from "@/components/settings-context";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export function Greeting() {
  const { data: session, status } = useSession();
  const { settings } = useSettings();
  const dict = useDictionary();
  const t = dict.app.dashboard;

  if (status === "loading" || !session?.user) {
    return <div className="h-9" aria-hidden />;
  }

  const role = session.user.role;
  const isOwner = role === "owner";
  const target = isOwner
    ? settings.shopName?.trim() || session.user.name || ""
    : session.user.name || "";

  return (
    <div>
      <h1 className="text-2xl font-bold text-text-primary">
        {t.greeting.replace("{name}", target)}
      </h1>
      <p className="text-sm text-text-secondary mt-1">
        {isOwner ? t.greetingOwner : t.greetingStaff}
      </p>
    </div>
  );
}
