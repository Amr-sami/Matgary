"use client";

import { Check, CheckCircle, Clock, AlertCircle } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { clockTime } from "./format";
import type { MessageDTO } from "./types";

interface Props {
  message: MessageDTO;
}

const TYPE_LABELS: Record<string, string> = {
  image: "[صورة]",
  document: "[مستند]",
  video: "[فيديو]",
  audio: "[ملف صوتي]",
  sticker: "[ملصق]",
  location: "[موقع]",
  button_reply: "[زر]",
  interactive_reply: "[تفاعلي]",
  reaction: "[تفاعل]",
  template: "[قالب]",
  unknown: "[رسالة]",
};

function renderBody(m: MessageDTO): string {
  if (m.textBody && m.textBody.trim().length > 0) return m.textBody;
  return TYPE_LABELS[m.messageType] ?? "[رسالة]";
}

export function MessageBubble({ message: m }: Props) {
  const isOut = m.direction === "outbound";
  const ts = m.receivedAt ?? m.sentAt ?? m.createdAt;

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
        <p>{renderBody(m)}</p>
        <div
          className={cn(
            "flex items-center gap-1 mt-1 text-[10px] tabular-nums",
            isOut ? "text-white/80 justify-end" : "text-text-secondary",
          )}
        >
          {clockTime(ts)}
          {isOut && <StatusIcon m={m} />}
        </div>
        {/* Failure detail on a failed outbound — surfaced so the operator
            understands why a send didn't land. */}
        {isOut && m.status === "failed" && m.failureReason && (
          <p className="mt-1 text-[10px] text-white/90 bg-red-700/40 rounded px-1.5 py-0.5">
            {m.failureReason}
          </p>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ m }: { m: MessageDTO }) {
  // WhatsApp-style: clock = queued; single check = sent; double check =
  // delivered; double check (blue) = read; ! = failed.
  const status = m.status ?? "queued";
  if (status === "queued") {
    return <Clock className="w-3 h-3" aria-label="queued" />;
  }
  if (status === "failed") {
    return <AlertCircle className="w-3 h-3 text-red-200" aria-label="failed" />;
  }
  if (status === "read") {
    return (
      <span className="inline-flex" aria-label="read">
        <Check className="w-3 h-3 -me-1" />
        <Check className="w-3 h-3 text-blue-200" />
      </span>
    );
  }
  if (status === "delivered") {
    return (
      <span className="inline-flex" aria-label="delivered">
        <Check className="w-3 h-3 -me-1" />
        <Check className="w-3 h-3" />
      </span>
    );
  }
  // sent
  return <CheckCircle className="w-3 h-3" aria-label="sent" />;
}
