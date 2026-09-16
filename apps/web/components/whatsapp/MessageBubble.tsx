"use client";

import { Check, CheckCircle, Clock, AlertCircle } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { clockTime } from "./format";
import type { MessageDTO } from "./types";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

interface Props {
  message: MessageDTO;
}

export function MessageBubble({ message: m }: Props) {
  const dict = useDictionary();
  const locale = useLocale();
  const typeLabels = dict.app.whatsappInbox.messageTypes;
  const statusLabels = dict.app.whatsappInbox.messageStatus;
  const isOut = m.direction === "outbound";
  const ts = m.receivedAt ?? m.sentAt ?? m.createdAt;
  const body =
    m.textBody && m.textBody.trim().length > 0
      ? m.textBody
      : (typeLabels as Record<string, string>)[m.messageType] ?? typeLabels.unknown;

  return (
    <div
      className={cn(
        "flex w-full",
        isOut ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words",
          isOut
            ? "bg-accent text-white rounded-br-sm"
            : "bg-bg-main text-text-primary rounded-bl-sm",
        )}
      >
        <p dir="auto">{body}</p>
        <div
          className={cn(
            "flex items-center gap-1 mt-1 text-[10px] tabular-nums",
            isOut ? "text-white/80 justify-end" : "text-text-secondary",
          )}
        >
          {clockTime(ts, locale)}
          {isOut && <StatusIcon m={m} statusLabels={statusLabels} />}
        </div>
        {isOut && m.status === "failed" && m.failureReason && (
          <p className="mt-1 text-[10px] text-white/90 bg-red-700/40 rounded px-1.5 py-0.5">
            {m.failureReason}
          </p>
        )}
      </div>
    </div>
  );
}

function StatusIcon({
  m,
  statusLabels,
}: {
  m: MessageDTO;
  statusLabels: { queued: string; sent: string; delivered: string; read: string; failed: string };
}) {
  const status = m.status ?? "queued";
  if (status === "queued") {
    return <Clock className="w-3 h-3" aria-label={statusLabels.queued} />;
  }
  if (status === "failed") {
    return <AlertCircle className="w-3 h-3 text-red-200" aria-label={statusLabels.failed} />;
  }
  if (status === "read") {
    return (
      <span className="inline-flex" aria-label={statusLabels.read}>
        <Check className="w-3 h-3 -me-1" />
        <Check className="w-3 h-3 text-blue-200" />
      </span>
    );
  }
  if (status === "delivered") {
    return (
      <span className="inline-flex" aria-label={statusLabels.delivered}>
        <Check className="w-3 h-3 -me-1" />
        <Check className="w-3 h-3" />
      </span>
    );
  }
  return <CheckCircle className="w-3 h-3" aria-label={statusLabels.sent} />;
}
