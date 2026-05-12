// Client-side shapes for the inbox. Mirrored from the API routes; kept
// local so an API contract change is a compile error here rather than
// silent drift.

export type ConversationFilter = "all" | "unread" | "archived";

export interface ConversationDTO {
  id: string;
  phoneNumber: string;
  displayName: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: "inbound" | "outbound" | null;
  unreadCount: number;
  windowExpiresAt: string | null;
  archivedAt: string | null;
}

export interface ConversationDetailDTO extends ConversationDTO {
  windowOpen: boolean;
  createdAt: string;
  updatedAt: string;
}

export type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed" | null;

export interface MessageDTO {
  id: string;
  direction: "inbound" | "outbound";
  metaMessageId: string | null;
  clientMessageId: string | null;
  messageType: string;
  textBody: string | null;
  mediaId: string | null;
  mediaMimeType: string | null;
  mediaFilename: string | null;
  status: MessageStatus;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  receivedAt: string | null;
  createdAt: string;
}
