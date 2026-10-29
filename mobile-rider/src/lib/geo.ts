// Lightweight geo helpers — only what the rider app needs (reverse-geocode +
// route polyline + distance/duration formatters + Barikoi style URL +
// polyline decoder). Mirrors a subset of `frontend/src/lib/geo.ts`.
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

/**
 * Decode an encoded polyline (precision 5, the default Barikoi/OSRM uses)
 * into [lat, lng] pairs. Tiny implementation — no library needed.
 */
export function decodePolyline(encoded: string, precision: number = 5): Array<[number, number]> {
  const factor = Math.pow(10, precision);
  let index = 0, lat = 0, lng = 0;
  const coords: Array<[number, number]> = [];
  while (index < encoded.length) {
    let result = 0, shift = 0, b: number;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;
    result = 0; shift = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
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

export type ReverseGeocodeResult = {
  address: string | null;
  address_bn?: string | null;
  area?: string | null;
  city?: string | null;
  district?: string | null;
  /** Ready-made written place name from the backend — never coordinates. */
  label?: string | null;
  lat: number;
  lng: number;
};

/**
 * "23.70123, 90.36789" style text is NOT a location label — users read those
 * bare numbers as an IP address. Every UI label goes through this guard.
 */
export const COORDS_LABEL_RE = /^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/;

export const GENERIC_LOCATION_LABEL = "আপনার অবস্থান";

/** Best written place name for a reverse-geocode result — never coordinates. */
export function friendlyLocationLabel(
  geo?: Partial<ReverseGeocodeResult> | null,
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
 * device (the rider's phone) locates while logged in, and reused by GPS-less
 * devices until a newer save replaces it. Mirrors `frontend/src/lib/geo.ts`.
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

export type RouteResult = {
  geometry: string;
  distance_m: number;
  duration_s: number;
};

export const geoApi = {
  reverse: (lat: number, lng: number) =>
    fetch(`${API_URL}/api/geo/reverse?lat=${lat}&lng=${lng}`)
      .then((r) => r.json() as Promise<ReverseGeocodeResult>),

  route: (
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
  ) =>
    fetch(
      `${API_URL}/api/geo/route?from_lat=${from.lat}&from_lng=${from.lng}&to_lat=${to.lat}&to_lng=${to.lng}`,
    ).then((r) => r.json() as Promise<RouteResult>),
};

export function formatDistance(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "—";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

export function formatDuration(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "—";
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Build a Google Maps deep-link for a coordinate (or fall back to an
 * address text query). Used by every offer/active card so the rider can
 * jump into Maps for turn-by-turn navigation.
 */
export function googleMapsLink(
  lat?: number | null,
  lng?: number | null,
  addressFallback?: string | null,
): string | null {
  if (lat != null && lng != null) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }
  if (addressFallback) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressFallback)}`;
  }
  return null;
}

/**
 * Best-effort high-accuracy single fix. Mirrors the helper in
 * `frontend/src/lib/geo.ts` so the rider can quickly grab a precise
 * location before going online.
 */
/**
 * Pin-point policy: a fix coarser than this many metres (IP/coarse-WiFi
 * lookups on GPS-less devices) is NOT a real location — reject it and tell
 * the rider to use a mobile / GPS-capable device.
 */
export const MAX_FIX_ACCURACY_M = 1000;

export function getPreciseLocation(opts: {
  desiredAccuracyM?: number;
  bestEffortAfterMs?: number;
  timeoutMs?: number;
} = {}): Promise<{ lat: number; lng: number; accuracy: number }> {
  const desired = opts.desiredAccuracyM ?? 25;
  const bestEffort = opts.bestEffortAfterMs ?? 12_000;
  const timeout = opts.timeoutMs ?? 22_000;

  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error(LOCATION_DEVICE_UNAVAILABLE_MESSAGE));
      return;
    }
    let best: { lat: number; lng: number; accuracy: number } | null = null;
    let resolved = false;
    let watchId: number | null = null;
    let bestEffortTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (bestEffortTimer) clearTimeout(bestEffortTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    const finish = (val?: { lat: number; lng: number; accuracy: number }) => {
      if (resolved) return;
      const candidate = val ?? best;
      resolved = true;
      cleanup();
      // Pin-point gate: never hand back an IP/coarse-network fix.
      if (candidate && candidate.accuracy <= MAX_FIX_ACCURACY_M) resolve(candidate);
      else reject(new Error(LOCATION_DEVICE_UNAVAILABLE_MESSAGE));
    };
    const fail = (err: unknown) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(new Error(locationErrorMessage(err)));
    };
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const fix = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? 9999,
        };
        if (!best || fix.accuracy < best.accuracy) best = fix;
        if (fix.accuracy <= desired) finish(fix);
      },
      (err) => {
        if (best) finish();
        else fail(err);
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout },
    );
    bestEffortTimer = setTimeout(() => { if (best) finish(); }, bestEffort);
    hardTimer = setTimeout(() => finish(), timeout);
  });
}
