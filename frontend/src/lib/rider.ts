import { api } from "./api";

export type RiderOffer = {
  id: string;
  order_id: string;
  payout_amount: number;
  distance_km: number;
  status: string;
  offered_at: string | null;
  pickup?: {
    pharmacy_id: string;
    name: string;
    address: string | null;
    lat: number | null;
    lng: number | null;
    phone: string | null;
    banner_photo_url?: string | null;
  } | null;
  drop?: {
    name: string;
    address: string | null;
    phone: string | null;
    lat?: number | null;
    lng?: number | null;
    profile_photo_url?: string | null;
  } | null;
  total?: number | null;
};

export type RiderOrder = {
  id: string;
  pharmacy_id: string;
  customer_account_id: string;
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  delivery_lat: number | null;
  delivery_lng: number | null;
  customer_profile_photo_url?: string | null;
  status: string;
  total: number;
  delivery_fee: number;
  note: string | null;
  created_at: string | null;
  conversation_id: string | null;
  pickup?: {
    pharmacy_id: string;
    name: string;
    address: string | null;
    lat: number | null;
    lng: number | null;
    phone: string | null;
    banner_photo_url?: string | null;
  } | null;
};

export type RiderOrderMessage = {
  id: string;
  sender_role: "customer" | "pharmacy" | "rider" | "system";
  body: string;
  preset_key: string | null;
  created_at: string | null;
};

export type EarningsWindow = { earnings: number; deliveries: number; active_days: number };
export type EarningsResponse = {
  windows: Record<"last_48h" | "week" | "month" | "year" | "lifetime", EarningsWindow>;
  platform_fee_pct: number;
  platform_fee_due: number;
  currency: string;
};

export const rider = {
  // accuracy_m lets the backend reject coarse (non-GPS) fixes — a rider
  // must be on a real GPS device to go online.
  ping: (lat: number, lng: number, accuracy_m?: number) =>
    api<{ ok: boolean; code?: string; message?: string }>("/api/rider/me/ping", {
      method: "POST",
      body: JSON.stringify(
        accuracy_m != null ? { lat, lng, accuracy_m } : { lat, lng },
      ),
    }),

  offers: () => api<{ items: RiderOffer[] }>("/api/rider/offers"),

  accept: (offer_id: string) =>
    api<{ ok: boolean; order_id: string }>(
      `/api/rider/offers/${offer_id}/accept`,
      { method: "POST" },
    ),

  activeOrders: () =>
    api<{ items: RiderOrder[] }>("/api/rider/orders/active"),

  messages: (order_id: string) =>
    api<{ items: RiderOrderMessage[] }>(
      `/api/rider/orders/${order_id}/messages`,
    ),

  sendMessage: (order_id: string, body: string, preset_key?: string) =>
    api<{ ok: boolean }>(`/api/rider/orders/${order_id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, preset_key }),
    }),

  pickedUp: (order_id: string) =>
    api<{ ok: boolean }>(`/api/rider/orders/${order_id}/picked-up`, {
      method: "POST",
    }),

  delivered: (order_id: string) =>
    api<{ ok: boolean }>(`/api/rider/orders/${order_id}/delivered`, {
      method: "POST",
    }),

  earnings: () =>
    api<{
      windows: Record<
        "last_48h" | "week" | "month" | "year" | "lifetime",
        { earnings: number; deliveries: number; active_days: number }
      >;
      platform_fee_pct: number;
      platform_fee_due: number;
      currency: string;
    }>("/api/rider/me/earnings"),

  payPlatformFee: (amount: number) =>
    api<{ ok: boolean; amount: number; paid_at: string; note?: string }>(
      "/api/rider/me/platform-fee/pay",
      { method: "POST", body: JSON.stringify({ amount }) },
    ),
};

/** App-parity alias — mobile-rider names this client `riderApi`. */
export const riderApi = rider;
