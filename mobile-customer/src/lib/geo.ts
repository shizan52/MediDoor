/**
 * Geo client — talks to /api/geo/* (which proxy Barikoi v2).
 *
 * Also exports the Barikoi map style URL used by `<MediMap />` for tiles.
 * The key is exposed via NEXT_PUBLIC_BARIKOI_KEY. In production restrict
 * the key to your origin in the Barikoi dashboard.
 */
import { API_URL, session } from "@/lib/api";

export const BARIKOI_KEY = process.env.NEXT_PUBLIC_BARIKOI_KEY ?? "";
export const BARIKOI_STYLE_URL = BARIKOI_KEY
  ? `https://map.barikoi.com/styles/osm-liberty/style.json?key=${BARIKOI_KEY}`
  : null;

export const LOCATION_DEVICE_UNAVAILABLE_MESSAGE =
  "আপনার এই device-এ location track করা যাচ্ছে না। যে device-এ location track করা যায়, যেমন আপনার mobile, সেই device দিয়ে login করুন; আমরা location নিয়ে নেব।";

export const LOCATION_PERMISSION_MESSAGE =
  "Location permission বন্ধ আছে। Browser-এর address bar বা settings থেকে এই site-এর location Allow করুন। যদি এই device-এ location track না হয়, mobile দিয়ে login করুন; আমরা location নিয়ে নেব।";

export function locationErrorMessage(error?: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "number"
      ? error.code
      : null;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const lower = message.toLowerCase();
  if (code === 1 || lower.includes("denied") || lower.includes("permission")) {
    return LOCATION_PERMISSION_MESSAGE;
  }
  if (
    code === 2 ||
    code === 3 ||
    lower.includes("unsupported") ||
    lower.includes("not supported") ||
    lower.includes("unavailable") ||
    lower.includes("no fix") ||
    lower.includes("timeout") ||
    lower.includes("time limit") ||
    lower.includes("could not acquire")
  ) {
    return LOCATION_DEVICE_UNAVAILABLE_MESSAGE;
  }
  return message || LOCATION_DEVICE_UNAVAILABLE_MESSAGE;
}

export function canTrackLocationOnThisDevice(): boolean {
  return typeof navigator !== "undefined" && !!navigator.geolocation;
}

/** Default centre = Banani circle, Dhaka — matches seed pharmacies. */
export const DEFAULT_CENTER = { lat: 23.7937, lng: 90.4066 };

export type ReverseAddress = {
  address: string | null;
  address_bn?: string | null;
  area?: string | null;
  area_bn?: string | null;
  city?: string | null;
  city_bn?: string | null;
  district?: string | null;
  sub_district?: string | null;
  post_code?: string | null;
  division?: string | null;
  country: string;
  location_type?: string | null;
  /** Ready-made written place name from the backend — never coordinates. */
  label?: string | null;
  lat: number;
  lng: number;
  source: "barikoi" | "osm" | "fallback";
};

/**
 * "23.70123, 90.36789" style text is NOT a location label — users read those
 * bare numbers as an IP address. Every UI label goes through this guard.
 */
export const COORDS_LABEL_RE = /^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/;

export const GENERIC_LOCATION_LABEL = "আপনার অবস্থান";

/**
 * Best written place name for a reverse-geocode result ("Gorachand Das Road,
 * Barishal" style). Prefers the backend's `label`, then address / area+city /
 * Bengali address — and NEVER returns raw coordinates.
 */
export function friendlyLocationLabel(
  geo?: Partial<ReverseAddress> | null,
  fallback: string = GENERIC_LOCATION_LABEL,
): string {
  const candidates = [
    geo?.label,
    geo?.address,
    [geo?.area, geo?.city].filter(Boolean).join(", "),
    geo?.address_bn,
  ];
  for (const c of candidates) {
    const text = (c ?? "").trim();
    if (text && !COORDS_LABEL_RE.test(text)) return text;
  }
  return fallback;
}

/* ------------------------------------------------------------------------- */
/* Saved location (server-side, per account)                                  */
/* ------------------------------------------------------------------------- */

export type SavedLocation = {
  role: "customer" | "pharmacy" | "rider";
  lat: number;
  lng: number;
  label: string;
  updated_at: string | null;
  source: "saved" | "ping" | "shop";
};

/**
 * Server-persisted "last known location" — captured whenever a GPS-capable
 * device (the user's phone) runs Locate-me while logged in, and reused by
 * GPS-less devices until a newer save replaces it.
 */
export const savedLocationApi = {
  /** null = not logged in / nothing saved yet. Never throws. */
  async get(): Promise<SavedLocation | null> {
    const access = session.access();
    if (!access) return null;
    try {
      const r = await fetch(`${API_URL}/api/geo/me/location`, {
        headers: { Authorization: `Bearer ${access}` },
      });
      if (!r.ok) return null;
      return (await r.json()) as SavedLocation;
    } catch {
      return null;
    }
  },
  /** Fire-and-forget persist of a fresh device fix. Never throws. */
  async save(lat: number, lng: number, accuracyM?: number): Promise<SavedLocation | null> {
    const access = session.access();
    if (!access) return null;
    try {
      const r = await fetch(`${API_URL}/api/geo/me/location`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
        body: JSON.stringify({ lat, lng, accuracy_m: accuracyM ?? null }),
      });
      if (!r.ok) return null;
      return (await r.json()) as SavedLocation;
    } catch {
      return null;
    }
  },
};

export type AutocompletePlace = {
  id: number | null;
  address: string;
  area?: string | null;
  city?: string | null;
  district?: string | null;
  sub_district?: string | null;
  sub_area?: string | null;
  post_code?: string | number | null;
  type?: string | null;
  sub_type?: string | null;
  lat: number | null;
  lng: number | null;
};

export type RouteResponse = {
  geometry: string | null;
  distance_m: number | null;
  duration_s: number | null;
  from: [number, number]; // [lng, lat]
  to: [number, number];
  source: "barikoi" | "fallback";
};

export type PharmacyMarker = {
  id: string;
  name: string;
  business_name?: string | null;
  address?: string | null;
  phone?: string | null;
  lat: number;
  lng: number;
  rating: number;
  rating_count: number;
  is_verified: boolean;
  is_open: boolean;
  banner_photo_url?: string | null;
};

export type TrackResponse = {
  order_id: string;
  status: string;
  pharmacy: { id: string | null; name: string | null; lat: number | null; lng: number | null; address: string | null; banner_photo_url?: string | null };
  customer: { name: string; address: string; lat: number | null; lng: number | null; profile_photo_url?: string | null };
  rider: { name: string | null; lat: number | null; lng: number | null; last_seen_at: string | null } | null;
  now: string;
};

export const geoApi = {
  async reverse(lat: number, lng: number): Promise<ReverseAddress> {
    const r = await fetch(`${API_URL}/api/geo/reverse?lat=${lat}&lng=${lng}`);
    if (!r.ok) throw new Error(`reverse ${r.status}`);
    return r.json();
  },
  async autocomplete(q: string, opts: { city?: string; limit?: number } = {}): Promise<AutocompletePlace[]> {
    const params = new URLSearchParams({ q });
    if (opts.city) params.set("city", opts.city);
    if (opts.limit) params.set("limit", String(opts.limit));
    const r = await fetch(`${API_URL}/api/geo/autocomplete?${params}`);
    if (!r.ok) throw new Error(`autocomplete ${r.status}`);
    const data = await r.json();
    return data.items ?? [];
  },
  async route(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<RouteResponse> {
    const params = new URLSearchParams({
      from_lat: String(from.lat),
      from_lng: String(from.lng),
      to_lat: String(to.lat),
      to_lng: String(to.lng),
    });
    const r = await fetch(`${API_URL}/api/geo/route?${params}`);
    if (!r.ok) throw new Error(`route ${r.status}`);
    return r.json();
  },
  async pharmacies(loc?: { lat: number; lng: number } | null): Promise<PharmacyMarker[]> {
    // With a location the server filters pins to the 5 km connect radius —
    // the customer's map only shows the world they can actually order from.
    const params = new URLSearchParams();
    if (loc) {
      params.set("lat", String(loc.lat));
      params.set("lng", String(loc.lng));
    }
    const qs = params.toString();
    const r = await fetch(`${API_URL}/api/geo/pharmacies${qs ? `?${qs}` : ""}`);
    if (!r.ok) throw new Error(`pharmacies ${r.status}`);
    const data = await r.json();
    return data.items ?? [];
  },
  async track(orderId: string): Promise<TrackResponse> {
    const access = session.access();
    const r = await fetch(`${API_URL}/api/geo/track/${orderId}`, {
      headers: access ? { Authorization: `Bearer ${access}` } : {},
    });
    if (!r.ok) throw new Error(`track ${r.status}`);
    return r.json();
  },
};

/**
 * Decode an encoded polyline (precision 5, the default Barikoi/OSRM uses)
 * into [lat, lng] pairs. Tiny implementation — no library needed.
 */
export function decodePolyline(encoded: string, precision: number = 5): Array<[number, number]> {
  const factor = Math.pow(10, precision);
  let index = 0,
    lat = 0,
    lng = 0;
  const coords: Array<[number, number]> = [];
  while (index < encoded.length) {
    let result = 0,
      shift = 0,
      b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;
    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

/** Convert decoded polyline to GeoJSON LineString (lng,lat order). */
export function polylineToGeoJSON(encoded: string): GeoJSON.Feature<GeoJSON.LineString> {
  const coords = decodePolyline(encoded).map(([lat, lng]) => [lng, lat]);
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: coords },
  };
}

export function formatDistance(meters: number | null | undefined): string {
  if (meters == null) return "";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

/* ------------------------------------------------------------------------- */
/* High-accuracy geolocation                                                  */
/* ------------------------------------------------------------------------- */

export type PreciseFix = {
  lat: number;
  lng: number;
  accuracy: number; // metres (1-σ)
  source: "gps" | "network";
  timestamp: number;
};

/**
 * Pin-point policy: a fix coarser than this many metres (IP/coarse-WiFi
 * lookups on GPS-less devices are typically 2–50 km off) is NOT a real
 * location. We reject it and tell the user to sign in from a mobile /
 * GPS-capable device — the platform's 5 km connect radius is meaningless
 * with a multi-km error bar.
 */
export const MAX_FIX_ACCURACY_M = 1000;

export type PreciseOptions = {
  /** Accept the first sample whose accuracy is below this many metres. Default 25. */
  desiredAccuracyM?: number;
  /** Hard ceiling — if no sample arrives within this many ms, reject. Default 20 000. */
  timeoutMs?: number;
  /** After this many ms, accept the best sample so far even if above threshold. Default 12 000. */
  bestEffortAfterMs?: number;
  /** Optional progress callback (each new GPS sample). */
  onProgress?: (fix: PreciseFix) => void;
  /** Optional AbortSignal to cancel early. */
  signal?: AbortSignal;
};

/**
 * Acquire a pin-point location using `watchPosition`.
 *
 * `getCurrentPosition` returns the FIRST cached fix the browser has — usually
 * a coarse Wi-Fi/IP lookup that can be 100s of metres off. Real GPS hardware
 * needs a few seconds to converge. This helper subscribes via `watchPosition`,
 * keeps the most-accurate sample, **waits for accuracy to stabilise** (two
 * consecutive samples within 5 m of each other), and resolves as soon as
 * accuracy is good enough (or hands back the best-effort fix when
 * `bestEffortAfterMs` elapses).
 *
 * Always passes `enableHighAccuracy: true, maximumAge: 0` so the browser is
 * forced to ask the OS for a fresh fix.
 */
export function getPreciseLocation(opts: PreciseOptions = {}): Promise<PreciseFix> {
  const desired = opts.desiredAccuracyM ?? 20;
  const hardTimeout = opts.timeoutMs ?? 25_000;
  const softTimeout = Math.min(opts.bestEffortAfterMs ?? 15_000, hardTimeout);

  return new Promise<PreciseFix>((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error(LOCATION_DEVICE_UNAVAILABLE_MESSAGE));
      return;
    }

    let best: PreciseFix | null = null;
    let prev: PreciseFix | null = null;
    let stableCount = 0;
    let watchId: number | null = null;
    let softTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const cleanup = () => {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      if (softTimer) clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
      watchId = null;
      softTimer = null;
      hardTimer = null;
    };

    const finish = (fix: PreciseFix) => {
      if (settled) return;
      // Pin-point gate: never hand back an IP/coarse-network fix — the
      // caller shows the "mobile/GPS device দিয়ে login করুন" message instead.
      if (fix.accuracy > MAX_FIX_ACCURACY_M) {
        fail(new Error(LOCATION_DEVICE_UNAVAILABLE_MESSAGE));
        return;
      }
      settled = true;
      cleanup();
      resolve(fix);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new Error("Geolocation aborted."));
        return;
      }
      opts.signal.addEventListener("abort", () => fail(new Error("Geolocation aborted.")));
    }

    // Tiny haversine for stability check.
    const distM = (a: PreciseFix, b: PreciseFix) => {
      const R = 6371000;
      const toRad = (x: number) => (x * Math.PI) / 180;
      const dLat = toRad(b.lat - a.lat);
      const dLng = toRad(b.lng - a.lng);
      const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(s));
    };

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const fix: PreciseFix = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? 9999,
          // Heuristic: <100 m almost always means real GPS; coarse fixes are usually 500-5000 m.
          source: (pos.coords.accuracy ?? 9999) < 100 ? "gps" : "network",
          timestamp: pos.timestamp,
        };
        if (!best || fix.accuracy < best.accuracy) best = fix;
        try { opts.onProgress?.(fix); } catch { /* ignore */ }

        // Stability: 2+ samples within 5 m AND accuracy under threshold.
        if (prev && distM(prev, fix) < 5 && fix.accuracy <= desired) {
          stableCount += 1;
          if (stableCount >= 1) { finish(fix); return; }
        } else {
          stableCount = 0;
        }
        prev = fix;

        // Single-sample early exit when accuracy is excellent.
        if (fix.accuracy <= Math.max(10, desired / 2)) finish(fix);
      },
      (err) => {
        // PERMISSION_DENIED (1) is fatal. Other errors: keep waiting unless we
        // never got any fix at all.
        if (err.code === 1) fail(new Error(LOCATION_PERMISSION_MESSAGE));
        else if (!best) {
          // Don't bail immediately — give the watch another chance until soft timeout.
        }
      },
      { enableHighAccuracy: true, timeout: hardTimeout, maximumAge: 0 },
    );

    softTimer = setTimeout(() => {
      if (best) finish(best);
      // else: keep waiting until hardTimeout for a first fix.
    }, softTimeout);

    hardTimer = setTimeout(() => {
      if (best) finish(best);
      else fail(new Error(LOCATION_DEVICE_UNAVAILABLE_MESSAGE));
    }, hardTimeout);
  });
}
