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
    lower.includes("time limit")
  ) {
    return LOCATION_DEVICE_UNAVAILABLE_MESSAGE;
  }
  return message || LOCATION_DEVICE_UNAVAILABLE_MESSAGE;
}

export function canTrackLocationOnThisDevice(): boolean {
  return typeof navigator !== "undefined" && !!navigator.geolocation;
}

/**
 * Pin-point policy: a fix coarser than this many metres (IP/coarse-WiFi
 * lookups on GPS-less devices) is NOT a real location — reject it and tell
 * the user to use a mobile / GPS-capable device. The shop location set here
 * becomes the pharmacy's PERMANENT platform coordinates for every 5 km
 * distance check, so a coarse fix would corrupt the whole storefront.
 */
export const MAX_FIX_ACCURACY_M = 1000;

/**
 * Best-effort high-accuracy single fix via watchPosition — mirrors
 * `frontend/src/lib/geo.ts:getPreciseLocation`. `getCurrentPosition` returns
 * the first CACHED fix (often a coarse Wi-Fi/IP lookup); this waits for GPS
 * to converge and rejects anything coarser than MAX_FIX_ACCURACY_M.
 */
export function getPreciseLocation(opts: {
  desiredAccuracyM?: number;
  bestEffortAfterMs?: number;
  timeoutMs?: number;
} = {}): Promise<{ lat: number; lng: number; accuracy: number }> {
  const desired = opts.desiredAccuracyM ?? 25;
  const bestEffort = opts.bestEffortAfterMs ?? 12_000;
  const timeout = opts.timeoutMs ?? 22_000;

  return new Promise((resolve, reject) => {
    if (!canTrackLocationOnThisDevice()) {
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