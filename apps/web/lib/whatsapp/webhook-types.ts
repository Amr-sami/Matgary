// Typed shape of a Meta WhatsApp Cloud API webhook payload.
//
// Intentionally narrow — only the fields Phase 2 reads. The full payload
// is preserved in wa_webhook_events.payload so adding a new field later
// doesn't need a schema change.

export interface MetaWebhookEnvelope {
  object?: string; // 'whatsapp_business_account'
  entry?: MetaWebhookEntry[];
}

export interface MetaWebhookEntry {
  id?: string; // WABA id
  changes?: MetaWebhookChange[];
}

export interface MetaWebhookChange {
  field?: string; // 'messages' | 'message_template_status_update' | ...
  value?: MetaWebhookChangeValue;
}

export interface MetaWebhookChangeValue {
  messaging_product?: string; // 'whatsapp'
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: MetaInboundMessage[];
  statuses?: MetaStatusUpdate[];
  errors?: Array<{
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }>;
  // ── message_template_status_update payload shape ──────────────────────
  // event:
  //   APPROVED | REJECTED | PENDING_DELETION | DELETED | DISABLED |
  //   PAUSED | UNPAUSED | IN_APPEAL | FLAGGED | LOCKED
  // We mirror the wording onto wa_templates.status (lowercased). The
  // change.field on the envelope is 'message_template_status_update'.
  event?: string;
  message_template_id?: string | number;
  message_template_name?: string;
  message_template_language?: string;
  reason?: string;
  // Optional: rejection details / quality update details
  other_info?: { title?: string; description?: string };
}

export interface MetaInboundMessage {
  id: string; // WAMID
  from?: string; // sender phone (E.164 sans +)
  timestamp?: string; // unix seconds, as string
  type?: string; // 'text' | 'image' | 'document' | ...
  text?: { body?: string };
  image?: MetaMediaRef;
  document?: MetaMediaRef;
  video?: MetaMediaRef;
  audio?: MetaMediaRef;
  sticker?: MetaMediaRef;
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  reaction?: { message_id?: string; emoji?: string };
  context?: { from?: string; id?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  contacts?: unknown;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

export interface MetaMediaRef {
  id?: string;
  mime_type?: string;
  filename?: string;
  sha256?: string;
  caption?: string;
}

export interface MetaStatusUpdate {
  id?: string; // WAMID
  status?: string; // 'sent' | 'delivered' | 'read' | 'failed'
  timestamp?: string; // unix seconds, as string
  recipient_id?: string; // customer phone
  conversation?: {
    id?: string;
    origin?: { type?: string };
    expiration_timestamp?: string;
  };
  pricing?: {
    billable?: boolean;
    pricing_model?: string;
    category?: string;
  };
  errors?: Array<{
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }>;
}

/** Logical event kinds the processor knows how to handle. */
export type WaEventType =
  | "message.received"
  | "message.status"
  | "template.status_update"
  | "unknown";

/** One unit of work extracted from a webhook batch. Each item gets its
 *  own row in wa_webhook_events. */
export interface ExtractedEvent {
  providerEventId: string;
  eventType: WaEventType;
  phoneNumberId: string | null;
  wabaId: string | null;
  // The slice of the webhook payload this event represents — not the
  // whole batch. Stored verbatim in wa_webhook_events.payload.
  payload: Record<string, unknown>;
}
