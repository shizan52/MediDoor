import { api, session } from "@/lib/api";

/* ------------------------------ Types ------------------------------ */

export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type OpeningHourEntry = {
  open: string;   // "HH:MM"
  close: string;  // "HH:MM"
  closed: boolean;
};

export type OpeningHours = Record<DayKey, OpeningHourEntry>;

export type SubscriptionTier = "A" | "B" | "C";

export type TierRules = {
  impressions_per_50: number;
  rx_offers_out_of_4: number;
  badge: string;
  label: string;
};

export type VerificationStatus =
  | "pending"
  | "verified"
  | "mismatch"
  | "not_found"
  | "expired"
  | "error";

export type DgdaRecord = {
  dgda_id?: string;
  division?: string;
  district?: string;
  pharmacy_name?: string;
  license_no?: string;
  pharmacy_code?: string;
  issue_date?: string;
  valid_until?: string;
  valid_until_iso?: string | null;
  is_expired?: boolean;
  owner_name?: string;
  drug_seller_name?: string;
  address?: string;
  drug_seller_code?: string;
};

export type VerificationInfo = {
  status: VerificationStatus;
  message: string | null;
  mismatch_fields: string[];
  dgda_record: DgdaRecord | null;
  checked_at: string | null;
  attempts: number;
};

export type VerificationDetail = VerificationInfo & {
  submitted: {
    pharmacy_name: string;
    owner_name: string;
    pharmacy_license_no: string;
    pharmacist_name: string | null;
    pharmacist_reg_no: string | null;
  };
};

export type PharmacyMe = {
  id: string;
  pharmacy_name: string;
  owner_name: string;
  business_name: string;
  pharmacy_license_no: string;
  pharmacy_license_doc_url: string | null;
  pharmacist_name: string | null;
  pharmacist_reg_no: string | null;
  banner_photo_url: string | null;
  address: string | null;
  phone_number: string | null;
  lat: number | null;
  lng: number | null;
  rating: number;
  rating_count: number;
  delivery_base_fee: number;
  delivery_per_km_fee: number;
  is_verified: boolean;
  description: string | null;
  opening_hours: OpeningHours;
  is_published: boolean;
  is_blocked: boolean;
  block_notice: string | null;
  blocked_at: string | null;
  blocked_by: string | null;
  closed_until: string | null;
  subscription_tier: SubscriptionTier;
  tier_rules: TierRules;
  is_open_now: boolean;
  verification: VerificationInfo;
};

export type PharmacyUpdate = Partial<{
  pharmacy_name: string;
  business_name: string;
  owner_name: string;
  description: string | null;
  address: string | null;
  phone_number: string | null;
  lat: number | null;
  lng: number | null;
  banner_photo_url: string | null;
  pharmacy_license_doc_url: string | null;
  delivery_base_fee: number;
  delivery_per_km_fee: number;
  opening_hours: OpeningHours;
  is_published: boolean;
  subscription_tier: SubscriptionTier;
}>;

export type PharmacyMedicine = {
  id: string;
  name: string;
  short_description: string | null;
  description: string | null;
  /** Primary AI-assigned category (back-compat). */
  category: string;
  /** Full set of AI-assigned categories — medicine appears under each on the customer side. */
  categories: string[];
  image_url: string | null;
  price: number;
  stock: number;
  is_active: boolean;
  prescription_required?: boolean;
  approval_status?: "approved" | "pending" | "rejected";
  approval_category?: string | null;
  approval_reason?: string | null;
  approval_reviewed_at?: string | null;
  approval_reviewed_by_admin?: boolean;
  created_at: string | null;
};

export type MedicineInput = {
  name: string;
  /** Mandatory — backend rejects publish without an image. */
  image_url: string;
  /** Optional — if blank the AI vision moderator will generate one. */
  short_description?: string | null;
  price: number;
  stock: number;
  is_active?: boolean;
  prescription_required?: boolean;
  // NOTE: `category` is no longer accepted from the client — the AI vision
  // moderator picks one or more categories on every publish/edit.
};

export type OrderStatus =
  | "pending" | "confirmed" | "packaging" | "ready"
  | "dispatched" | "delivered" | "rejected" | "cancelled";

export type OrderItem = {
  medicine_id: string;
  name: string;
  qty: number;
  price: number;
  image_url?: string | null;
};

export type OrderMessage = {
  id: string;
  sender_role: "customer" | "pharmacy" | "rider" | "system";
  body: string;
  preset_key: string | null;
  created_at: string | null;
};

export type PharmacyOrder = {
  id: string;
  pharmacy_id: string;
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  delivery_lat: number | null;
  delivery_lng: number | null;
  items: OrderItem[];
  prescription_url: string | null;
  note: string | null;
  subtotal: number;
  delivery_fee: number;
  total: number;
  status: OrderStatus;
  rejection_reason: string | null;
  accepted_rider_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  messages?: OrderMessage[];
};

export type PharmacyAnalytics = {
  by_status: Record<OrderStatus, { count: number; total: number }>;
  lifetime_revenue: number;
  this_month_revenue: number;
  rejected_count: number;
  cancelled_count: number;
  delivered_count: number;
  pending_count: number;
  inventory_total: number;
  inventory_active: number;
  top_products: { name: string; qty: number; revenue: number }[];
  since: string | null;
};

export type PharmacyCategory = {
  id: string;
  name: string;
  short_description: string | null;
  sort_order: number;
};

export type CategoryInput = {
  name: string;
  short_description?: string | null;
  sort_order?: number;
};

export type PresetCategory = {
  name: string;
  short_description: string | null;
  group?: string | null;
};

export type AiNotification = {
  id: string;
  kind: string;
  title: string;
  body_bn: string;
  payload: Record<string, unknown> | null;
  is_read: boolean;
  created_at: string | null;
};

export type PharmacyAdminMessage = {
  id: string;
  direction: "admin_to_pharmacy" | "pharmacy_to_admin";
  body: string;
  attachment_url: string | null;
  attachment_mime: string | null;
  is_read: boolean;
  created_at: string | null;
};

/* ------------------------------ API ------------------------------ */

export const pharmacyApi = {
  me: () => api<PharmacyMe>("/api/pharmacy/me"),

  update: (patch: PharmacyUpdate) =>
    api<PharmacyMe>("/api/pharmacy/me", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  closeToday: () =>
    api<PharmacyMe>("/api/pharmacy/me/close-today", { method: "POST" }),

  openNow: () =>
    api<PharmacyMe>("/api/pharmacy/me/open-now", { method: "POST" }),

  listMedicines: () =>
    api<{ items: PharmacyMedicine[]; total: number }>(
      "/api/pharmacy/me/medicines"
    ),

  createMedicine: (m: MedicineInput) =>
    api<PharmacyMedicine>("/api/pharmacy/me/medicines", {
      method: "POST",
      body: JSON.stringify(m),
    }),

  updateMedicine: (id: string, m: Partial<MedicineInput>) =>
    api<PharmacyMedicine>(`/api/pharmacy/me/medicines/${id}`, {
      method: "PATCH",
      body: JSON.stringify(m),
    }),

  deleteMedicine: (id: string) =>
    fetch(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api/pharmacy/me/medicines/${id}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${session.access() ?? ""}`,
        },
      }
    ).then((r) => {
      if (!r.ok) throw new Error(`Delete failed: ${r.status}`);
    }),

  listPresetCategories: (q?: string) =>
    api<{ items: PresetCategory[] }>(
      `/api/pharmacy/categories/presets${q ? `?q=${encodeURIComponent(q)}` : ""}`
    ),

  /** Search the global category catalogue (debounced typeahead). */
  searchCategoryCatalogue: (q: string) =>
    api<{ items: PresetCategory[] }>(
      `/api/pharmacy/categories/presets?q=${encodeURIComponent(q)}&limit=20`
    ),

  /** MediAI inbox — platform → pharmacy advice messages. */
  listNotifications: () =>
    api<{ items: AiNotification[]; unread: number }>(
      "/api/pharmacy/me/notifications"
    ),

  markNotificationRead: (id: string) =>
    api<{ ok: boolean }>(`/api/pharmacy/me/notifications/${id}/read`, {
      method: "POST",
    }),

  markAllNotificationsRead: () =>
    api<{ ok: boolean }>("/api/pharmacy/me/notifications/read-all", {
      method: "POST",
    }),

  adminThread: () =>
    api<{ items: PharmacyAdminMessage[] }>("/api/pharmacy/me/admin-thread"),

  adminThreadUnread: () =>
    api<{ unread: number }>("/api/pharmacy/me/admin-thread/unread"),

  sendAdminMessage: (payload: {
    body?: string;
    attachment_url?: string | null;
    attachment_mime?: string | null;
  }) =>
    api<PharmacyAdminMessage>("/api/pharmacy/me/admin-thread", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  listCategories: () =>
    api<{ items: PharmacyCategory[] }>("/api/pharmacy/me/categories"),

  createCategory: (c: CategoryInput) =>
    api<PharmacyCategory>("/api/pharmacy/me/categories", {
      method: "POST",
      body: JSON.stringify(c),
    }),

  updateCategory: (id: string, c: Partial<CategoryInput>) =>
    api<PharmacyCategory>(`/api/pharmacy/me/categories/${id}`, {
      method: "PATCH",
      body: JSON.stringify(c),
    }),

  deleteCategory: (id: string) =>
    fetch(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api/pharmacy/me/categories/${id}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${session.access() ?? ""}`,
        },
      }
    ).then(async (r) => {
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(t || `Delete failed: ${r.status}`);
      }
    }),

  listOrders: (status?: OrderStatus) =>
    api<{ items: PharmacyOrder[] }>(
      `/api/pharmacy/me/orders${status ? `?status=${status}` : ""}`
    ),

  confirmOrder: (id: string) =>
    api<PharmacyOrder>(`/api/pharmacy/me/orders/${id}/confirm`, {
      method: "POST",
    }),

  rejectOrder: (id: string, reason: string) =>
    api<PharmacyOrder>(`/api/pharmacy/me/orders/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  setOrderStatus: (id: string, status: OrderStatus) =>
    api<PharmacyOrder>(`/api/pharmacy/me/orders/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),

  postMessage: (id: string, body: string, preset_key?: string) =>
    api<PharmacyOrder>(`/api/pharmacy/me/orders/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, preset_key }),
    }),

  dispatchRiders: (id: string) =>
    api<{ offers_sent: number; order: PharmacyOrder }>(
      `/api/pharmacy/me/orders/${id}/dispatch`,
      { method: "POST" }
    ),

  analytics: () => api<PharmacyAnalytics>("/api/pharmacy/me/analytics"),

  /** DGDA verification status (poll endpoint for the dashboard gate). */
  verification: () =>
    api<VerificationDetail>("/api/pharmacy/me/verification"),

  /** Resubmit corrected pharmacy_name / owner_name / license_no / pharmacist for re-verification. */
  resubmitVerification: (payload: {
    pharmacy_name: string;
    owner_name: string;
    pharmacy_license_no: string;
    pharmacist_name: string;
    pharmacist_reg_no: string;
  }) =>
    api<PharmacyMe>("/api/pharmacy/me/verify-resubmit", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** Re-run verification with the SAME stored values (used by the Retry button). */
  retryVerification: () =>
    api<PharmacyMe>("/api/pharmacy/me/verify-retry", { method: "POST" }),
};

export const DAYS: { key: DayKey; label: string }[] = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
];

export const TIER_INFO: Record<SubscriptionTier, {
  label: string;
  badge: string;
  impressions: string;
  rx_offers: string;
  blurb: string;
  color: string;
}> = {
  C: {
    label: "C — Basic",
    badge: "Verified",
    impressions: "10 / 50 customer impressions",
    rx_offers: "1 / 4 prescription offers",
    blurb: "Entry plan. Map-এ \"Verified\" badge দেখায়। নতুন pharmacy-র জন্য ideal।",
    color: "from-slate-500 to-slate-700",
  },
  B: {
    label: "B — Pro",
    badge: "Verified Pro",
    impressions: "20 / 50 customer impressions",
    rx_offers: "2 / 4 prescription offers",
    blurb: "Mid-tier — দ্বিগুণ visibility আর double prescription offer।",
    color: "from-emerald-500 to-emerald-700",
  },
  A: {
    label: "A — Premium",
    badge: "Verified Pro+",
    impressions: "30 / 50 customer impressions",
    rx_offers: "3 / 4 prescription offers",
    blurb: "Top tier — সবচেয়ে বেশি visibility, premium badge।",
    color: "from-amber-500 to-orange-600",
  },
};
