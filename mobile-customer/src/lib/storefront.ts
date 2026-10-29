import { API_URL, session } from "@/lib/api";

function authHeaders(): HeadersInit {
  const token = session.access();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function storefrontError(res: Response, label: string): Promise<Error> {
  const text = await res.text();
  if (res.status === 423) {
    try {
      const parsed = JSON.parse(text) as { detail?: { message?: string } | string };
      if (parsed.detail && typeof parsed.detail === "object" && parsed.detail.message) return new Error(parsed.detail.message);
      if (typeof parsed.detail === "string") return new Error(parsed.detail);
    } catch {}
  }
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
  category: string;
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
  /** Ready-made written place name from the backend — never coordinates. */
  label?: string | null;
  area?: string | null;
  city?: string | null;
  country: string;
  source: "barikoi" | "fallback";
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
  const url = `${API_URL}/api/storefront/pharmacy/${id}${params.toString() ? `?${params}` : ""}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw await storefrontError(res, "pharmacy");
  return res.json();
}

export async function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocode> {
  const res = await fetch(`${API_URL}/api/geo/reverse?lat=${lat}&lng=${lng}`);
  if (!res.ok) throw new Error(`geo ${res.status}`);
  return res.json();
}

const LOC_KEY = "medidoor_user_location_v2";
const LEGACY_LOC_KEYS = ["medidoor_user_location"];

export type StoredLocation = { lat: number; lng: number; label: string; ts: number };

// Older builds stored the label as raw "lat, lng" coordinates whenever the
// reverse-geocode failed — those bare numbers read like an IP address.
// Rewrite any coordinate-shaped label to the friendly Bangla placeholder so
// every consumer of userLocation shows clean text.
const COORDS_LABEL = /^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/;

export const userLocation = {
  load(): StoredLocation | null {
    if (typeof window === "undefined") return null;
    try {
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
};

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
 * Mobile-app version of `requestPharmacyChat`.
 *  - Logged out → push to /login with a `next=` hint so we resume here.
 *  - Logged in non-customer → push to /login with role hint (one gmail = one role).
 *  - Logged in customer → store the prefill in sessionStorage and navigate
 *    to `/chats/new?pharmacy_id=...` which materialises the conversation.
 */
export function requestPharmacyChat(
  router: { push: (url: string) => void },
  opts: { pharmacy_id: string; prefill?: string }
) {
  if (typeof window === "undefined") return;
  const access = session.access();
  const next = `/chats/new?pharmacy_id=${encodeURIComponent(opts.pharmacy_id)}`;
  if (!access) {
    router.push(`/login?role=customer&next=${encodeURIComponent(next)}`);
    return;
  }
  const tokenRole = roleFromJwt(access);
  if (tokenRole && tokenRole !== "customer") {
    router.push(`/login?role=customer&msg=customer-only`);
    return;
  }
  if (opts.prefill) {
    try {
      window.sessionStorage.setItem(
        `medidoor_chat_prefill_${opts.pharmacy_id}`,
        opts.prefill,
      );
    } catch {
      /* sessionStorage might be blocked */
    }
  }
  router.push(next);
}

export const buyPrefill = (name: string, price: number) =>
  `Hi, আমি "${name}" কিনতে চাই (৳${price})। Stock + delivery confirm করতে পারবেন?`;

export const inquiryPrefill = (name: string) =>
  `Hi, "${name}" সম্পর্কে একটু জানতে চাই — dosage / use / availability।`;

export function fmtDistance(km: number | null | undefined): string {
  if (km == null) return "";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}
