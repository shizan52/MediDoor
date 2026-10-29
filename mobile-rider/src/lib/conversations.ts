// Verbatim port of mobile-pharmacy/src/lib/conversations.ts so the rider app
// can render the shared 3-party chat with the same preset/payload semantics.
import { api } from "@/lib/api";

export type ConversationSenderRole = "customer" | "pharmacy" | "rider" | "system";
export type MessageVisibility = "all" | "customer_rider" | "customer_pharmacy" | "pharmacy_rider" | "customer_only";

export type ConversationSummary = {
  id: string;
  pharmacy_id: string;
  pharmacy_name: string;
  pharmacy_avatar: string | null;
  customer_account_id: string;
  customer_name: string;
  customer_avatar: string | null;
  rider_id: string | null;
  rider_name: string | null;
  rider_avatar: string | null;
  rider_phone: string | null;
  last_message_at: string | null;
  customer_last_read_at: string | null;
  pharmacy_last_read_at: string | null;
  rider_last_read_at: string | null;
  blocked_at: string | null;
  block_reason: string | null;
  block_category: string | null;
  flag_count: number;
  created_at: string | null;
  last_message_preview?: string;
  last_sender_role?: ConversationSenderRole | null;
  unread_count?: number;
  rider_read_only?: boolean;
  rider_archive_until?: string | null;
  rider_message_cutoff?: string | null;
};

export type OrderLineItem = {
  medicine_id?: string | null;
  name: string;
  qty: number;
  unit_price: number;
  image_url?: string | null;
  prescription_required?: boolean;
};

export type OrderPayload = {
  items: OrderLineItem[];
  subtotal: number;
  delivery_fee: number;
  total: number;
  note?: string | null;
  delivery_address?: string | null;
  delivery_lat?: number | null;
  delivery_lng?: number | null;
};

export type ConversationMessage = {
  id: string;
  conversation_id: string;
  sender_role: ConversationSenderRole;
  body: string;
  attachment_url: string | null;
  preset_key: string | null;
  payload: OrderPayload | null;
  visibility: MessageVisibility;
  moderation_risk: "low" | "medium" | "high" | null;
  moderation_category: string | null;
  moderation_reason: string | null;
  was_blocked: boolean;
  created_at: string | null;
};

export type ConversationTrack = {
  conversation_id: string;
  order_id: string | null;
  status: string | null;
  pharmacy: { id: string | null; name: string | null; address: string | null; lat: number | null; lng: number | null; phone: string | null; banner_photo_url?: string | null };
  customer: { name: string | null; address: string | null; lat: number | null; lng: number | null; phone: string | null; profile_photo_url?: string | null };
  rider: { name: string | null; lat: number | null; lng: number | null; phone: string | null; last_seen_at: string | null } | null;
  now: string;
};

export type SendMessageInput = {
  body?: string;
  attachment_url?: string | null;
  preset_key?: string | null;
  payload?: OrderPayload | null;
  visibility?: MessageVisibility;
};

export const conversationsApi = {
  list: () => api<ConversationSummary[]>("/api/conversations"),
  messages: (conversation_id: string) =>
    api<ConversationMessage[]>(`/api/conversations/${conversation_id}/messages`),
  send: (conversation_id: string, payload: SendMessageInput) =>
    api<ConversationMessage>(`/api/conversations/${conversation_id}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  markSeen: (conversation_id: string) =>
    api<{ ok: boolean; side: string; at: string }>(
      `/api/conversations/${conversation_id}/seen`,
      { method: "POST" },
    ),
  track: (conversation_id: string) =>
    api<ConversationTrack>(`/api/conversations/${conversation_id}/track`),
};

/** Preset keys for the in-chat order workflow (mirrors website). */
export const ORDER_PRESETS = {
  request: "order_request",
  quote: "pharmacy_quote",
  confirm: "order_confirm",
  reject: "order_reject",
  status_preparing: "order_status_preparing",
  status_on_the_way: "order_status_on_the_way",
  status_delivered: "order_status_delivered",
  rating_submitted: "order_rating_submitted",
  delay: "order_delay",
  call_rider: "call_rider",
  rider_joined: "rider_joined",
  handed_over: "handed_over",
  delivery_complete: "delivery_complete",
} as const;

export function formatBDT(value: number): string {
  if (!Number.isFinite(value)) return "৳ 0";
  return `৳ ${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function summariseOrder(payload: OrderPayload | null | undefined): string {
  if (!payload || !payload.items?.length) return "";
  const head = payload.items
    .slice(0, 3)
    .map((it) => `${it.name} ×${it.qty}`)
    .join(", ");
  const more =
    payload.items.length > 3 ? `, +${payload.items.length - 3} more` : "";
  return `${head}${more} — ${formatBDT(payload.total)}`;
}
