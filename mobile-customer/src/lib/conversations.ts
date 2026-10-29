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
  // Enrichment from /api/conversations list endpoint:
  last_message_preview?: string;
  last_sender_role?: ConversationSenderRole | null;
  unread_count?: number;
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
  // loc = customer's live location; the backend enforces the 5 km connect
  // radius when starting a NEW conversation (existing threads always open).
  start: (pharmacy_id: string, loc?: { lat: number; lng: number } | null) =>
    api<ConversationSummary>("/api/conversations", {
      method: "POST",
      body: JSON.stringify(
        loc ? { pharmacy_id, lat: loc.lat, lng: loc.lng } : { pharmacy_id },
      ),
    }),
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
  ratePharmacy: (pharmacy_id: string, stars: number) =>
    api<{ id: string; rating: number; rating_count: number }>(
      `/api/pharmacy/${pharmacy_id}/rate`,
      { method: "POST", body: JSON.stringify({ stars }) },
    ),
  /** Customer answers an `ai_question_for_customer` row. The backend marks the
   *  parent question answered and posts the customer's reply to the asker side
   *  as a normal customer message (sender_role=customer, payload.ai_proxy=true). */
  aiProxyAnswer: (conversation_id: string, parent_question_id: string, answer: string) =>
    api<ConversationMessage>(`/api/conversations/${conversation_id}/ai-proxy-answer`, {
      method: "POST",
      body: JSON.stringify({ parent_question_id, answer }),
    }),
};

/** "৳1,234" — Bangla taka prefix + en-IN grouping. */
export function formatBDT(n: number | null | undefined): string {
  const v = Number(n) || 0;
  return `৳${v.toLocaleString("en-IN")}`;
}

/** preset_key strings recognised by the backend conversation workflow. */
export const ORDER_PRESETS = {
  request: "order_request",
  quote: "pharmacy_quote",
  confirm: "order_confirm",
  reject: "order_reject",
  delay: "order_delay",
  status_preparing: "order_status_preparing",
  status_on_the_way: "order_status_on_the_way",
  status_delivered: "order_status_delivered",
  call_rider: "call_rider",
  rider_joined: "rider_joined",
  handed_over: "handed_over",
  delivery_complete: "delivery_complete",
  rating_submitted: "order_rating_submitted",
  ai_intro: "ai_prescription_intro",
} as const;
