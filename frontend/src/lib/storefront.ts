/**
 * Storefront types + helpers used by the customer-facing pages.
 * No auth required — everything is public.
 */
import { API_URL, session } from "@/lib/api";

function authHeaders(): HeadersInit {
  const token = session.access();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function storefrontError(res: Response, label: string): Promise<Error> {
  const text = await res.text();
  // Surface any structured backend message (423 banned/blocked, 400
  // location_required, 403 out_of_range, …) as its Bengali text.
  try {
    const parsed = JSON.parse(text) as { detail?: { message?: string } | string };
    if (parsed.detail && typeof parsed.detail === "object" && parsed.detail.message) return new Error(parsed.detail.message);
    if (typeof parsed.detail === "string") return new Error(parsed.detail);
  } catch {}
  return new Error(`${label} ${res.status}`);
}

export type StorefrontPharmacy = {
  id: string;
  name: string;
  business_name?: string | null;
  banner_photo_url?: string | null;
  address?: string | null;
  phone_number?: string | null;
  rating: number;
  rating_count: number;
  is_verified: boolean;
  lat?: number | null;
  lng?: number | null;
  distance_km?: number | null;
  delivery_fee: number;
};

export type StorefrontMedicine = {
  id: string;
  name: string;
  short_description?: string | null;
  /** Primary category (back-compat). */
  category: string;
  /** Full set of categories the AI assigned to this medicine. */
  categories?: string[];
  image_url?: string | null;
  price: number;
  stock: number;
  prescription_required?: boolean;
  pharmacy: {
    id: string;
    name: string;
    rating: number;
    rating_count?: number;
    is_verified: boolean;
  };
  distance_km?: number | null;
  delivery_fee: number;
};

export type CategoryCount = { name: string; count: number; short_description?: string | null };

export type NearbyResponse = {
  items: StorefrontMedicine[];
  total: number;
  categories: CategoryCount[];
  pharmacy_count: number;
  radius_km: number;
  user_lat: number | null;
  user_lng: number | null;
};

export type PharmacyDetail = {
  pharmacy: StorefrontPharmacy;
  categories: { name: string; short_description?: string | null; items: StorefrontMedicine[] }[];
  total_medicines: number;
};

export type ReverseGeocode = {
  address: string | null;
  address_bn?: string | null;
  area?: string | null;
  city?: string | null;
  country: string;
  /** Ready-made written place name from the backend — never coordinates. */
  label?: string | null;
  source: "barikoi" | "osm" | "fallback";
};

export async function fetchNearby(opts: {
  lat?: number | null;
  lng?: number | null;
  radius_km?: number;
  q?: string;
  category?: string;
}): Promise<NearbyResponse> {
  const params = new URLSearchParams();
  if (opts.lat != null) params.set("lat", String(opts.lat));
  if (opts.lng != null) params.set("lng", String(opts.lng));
  params.set("radius_km", String(opts.radius_km ?? 5));
  if (opts.q) params.set("q", opts.q);
  if (opts.category) params.set("category", opts.category);
  const res = await fetch(`${API_URL}/api/storefront/nearby?${params.toString()}`, { headers: authHeaders() });
  if (!res.ok) throw await storefrontError(res, "storefront");
  return res.json();
}

export async function fetchPharmacy(
  id: string,
  opts: { lat?: number | null; lng?: number | null } = {}
): Promise<PharmacyDetail> {
  const params = new URLSearchParams();
  if (opts.lat != null) params.set("lat", String(opts.lat));
  if (opts.lng != null) params.set("lng", String(opts.lng));
  const url = `${API_URL}/api/storefront/pharmacy/${id}${
    params.toString() ? `?${params.toString()}` : ""
  }`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw await storefrontError(res, "pharmacy");
  return res.json();
}

export async function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocode> {
  const res = await fetch(`${API_URL}/api/geo/reverse?lat=${lat}&lng=${lng}`);
  if (!res.ok) throw new Error(`geo ${res.status}`);
  return res.json();
}

// v2 — bumped to invalidate stale Banani-default coords saved by older builds.
// Old key (`medidoor_user_location`) is auto-cleaned on load.
const LOC_KEY = "medidoor_user_location_v2";
const LEGACY_LOC_KEYS = ["medidoor_user_location"];

export type StoredLocation = {
  lat: number;
  lng: number;
  label: string;
  ts: number;
};

// Older builds stored the label as raw "lat, lng" coordinates whenever the
// reverse-geocode failed — those bare numbers read like an IP address.
// Rewrite any coordinate-shaped label to the friendly Bangla placeholder so
// every consumer of userLocation shows clean text.
const COORDS_LABEL = /^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/;

export const userLocation = {
  load(): StoredLocation | null {
    if (typeof window === "undefined") return null;
    try {
      // one-time migration: drop any legacy key so the new fallback applies
      for (const k of LEGACY_LOC_KEYS) {
        if (localStorage.getItem(k) !== null) localStorage.removeItem(k);
      }
      const raw = localStorage.getItem(LOC_KEY);
      const loc = raw ? (JSON.parse(raw) as StoredLocation) : null;
      if (loc && (!loc.label || COORDS_LABEL.test(loc.label))) {
        return { ...loc, label: "আপনার অবস্থান" };
      }
      return loc;
    } catch {
      return null;
    }
  },
  save(loc: StoredLocation) {
    if (typeof window === "undefined") return;
    localStorage.setItem(LOC_KEY, JSON.stringify(loc));
  },
  clear() {
    if (typeof window === "undefined") return;
    localStorage.removeItem(LOC_KEY);
    for (const k of LEGACY_LOC_KEYS) localStorage.removeItem(k);
  },
};

/**
 * Decode the role claim out of a JWT access token without verifying signature.
 * Returns null if the token is malformed.
 */
function roleFromJwt(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json) as { role?: string };
    return typeof claims.role === "string" ? claims.role : null;
  } catch {
    return null;
  }
}

/**
 * Open a chat thread with a pharmacy, optionally pre-filling the input
 * with a draft message about a specific medicine.
 *
 * Behavior:
 *  - Logged-out users  → redirected to /login?role=customer.
 *  - Logged-in non-customers (pharmacy/rider) → redirected to /login?role=customer
 *    with a hint message, since one gmail = one role and only customers can
 *    start conversations (backend returns 403 otherwise). The role is read
 *    from the JWT itself (not localStorage) because tabs/sessions can write
 *    a stale `medidoor_role` value while the access token is still valid.
 *  - Logged-in customers → fires `medidoor-open-chat` so the MessengerDock
 *    creates / reuses the conversation and opens the panel with the prefill.
 */
export function requestPharmacyChat(opts: {
  pharmacy_id: string;
  prefill?: string;
}) {
  if (typeof window === "undefined") return;
  const access = session.access();
  if (!access) {
    // Soft prompt via the global LoginGate instead of a hard redirect,
    // so the user keeps their place on the page.
    window.dispatchEvent(
      new CustomEvent("medidoor-require-login", {
        detail: {
          feature: "Pharmacy-র সাথে chat / order",
          message:
            "এই pharmacy-র সাথে chat করতে বা order place করতে শুধু একবার login করতে হবে। তারপর আপনি সব ব্যবহার করতে পারবেন।",
          role: "customer",
        },
      }),
    );
    return;
  }
  // Trust the JWT claim, not the role hint (which other tabs may have overwritten).
  const tokenRole = roleFromJwt(access);
  if (tokenRole && tokenRole !== "customer") {
    window.location.href = "/login?role=customer&msg=customer-only";
    return;
  }
  window.dispatchEvent(
    new CustomEvent("medidoor-open-chat", {
      detail: { pharmacy_id: opts.pharmacy_id, prefill: opts.prefill },
    }),
  );
}

/** Build a Bengali "I want to buy this" prefill. */
export function buyPrefill(name: string, price: number): string {
  return `Hi, আমি "${name}" কিনতে চাই (৳${price.toFixed(0)})। Stock + delivery confirm করতে পারবেন?`;
}

/** Build a Bengali "tell me about this" prefill. */
export function inquiryPrefill(name: string): string {
  return `Hi, "${name}" সম্পর্কে একটু জানতে চাই — dosage / use / availability।`;
}

/**
 * Format a distance in km with sensible precision:
 *  - exact 0 (same location)            → "এখানেই"
 *  - < 1 km                              → meters ("45 m")
 *  - 1–10 km                             → 2-decimal km ("1.23 km")
 *  - >= 10 km                            → 1-decimal km ("12.3 km")
 */
export function fmtDistance(km: number | null | undefined): string {
  if (km == null) return "";
  if (km === 0) return "এখানেই";
  if (km < 1) return `${Math.max(1, Math.round(km * 1000))} m`;
  if (km < 10) return `${km.toFixed(2)} km`;
  return `${km.toFixed(1)} km`;
}
