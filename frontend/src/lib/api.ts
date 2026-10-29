export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export const PHARMACY_APP_URL = trimTrailingSlash(
  process.env.NEXT_PUBLIC_PHARMACY_URL ?? "http://localhost:3200"
);

export const RIDER_APP_URL = trimTrailingSlash(
  process.env.NEXT_PUBLIC_RIDER_URL ?? "http://localhost:3300"
);

export type Role = "customer" | "pharmacy" | "rider";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Resolve any backend-served media path into a fully-qualified URL.
 * Absolute (http/https/data) URLs pass through unchanged; a relative
 * `/uploads/...` path (as returned by the storefront API for admin-uploaded
 * product images) is prefixed with the API origin so it loads from the
 * backend instead of 404-ing against the website origin. Mirrors the
 * customer mobile app's `resolveMediaUrl` for identical behaviour.
 */
export function resolveMediaUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) return url;
  if (url.startsWith("/")) return `${API_URL}${url}`;
  return `${API_URL}/${url}`;
}

export function roleAppOrigin(role: Role): string | null {
  if (role === "pharmacy") return PHARMACY_APP_URL;
  if (role === "rider") return RIDER_APP_URL;
  return null;
}

function isCurrentOrigin(origin: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URL(origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function roleAppCallbackUrl(role: Role, hash: string): string | null {
  const origin = roleAppOrigin(role);
  if (!origin || isCurrentOrigin(origin)) return null;
  return `${origin}/auth/callback#${hash.replace(/^#/, "")}`;
}

const ACCESS_KEY = "medidoor_access";
const REFRESH_KEY = "medidoor_refresh";
const ROLE_KEY = "medidoor_role";

/**
 * Tab-isolated session storage with a localStorage hand-off.
 *
 * Why: VS Code's Simple Browser, multi-tab dev sessions, and Playwright contexts
 * all share `localStorage` across tabs on the same origin. If tab A logs in as
 * customer, tab B's pharmacy session gets silently overwritten and starts
 * spamming 403s or redirecting to /login. To prevent that, every tab keeps
 * its **own** copy of the tokens in `sessionStorage`. We still mirror writes
 * into `localStorage` so that a brand-new tab can pick up an existing login
 * (read once, then promote into sessionStorage and stop watching localStorage).
 */
function readEither(key: string): string | null {
  if (typeof window === "undefined") return null;
  const fromSession = window.sessionStorage.getItem(key);
  if (fromSession) return fromSession;
  const fromLocal = window.localStorage.getItem(key);
  if (fromLocal) {
    // Promote into this tab's sessionStorage so future cross-tab writes don't
    // corrupt us. (Other tabs keep using their own sessionStorage copy.)
    window.sessionStorage.setItem(key, fromLocal);
  }
  return fromLocal;
}

function writeBoth(key: string, value: string) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(key, value);
  window.localStorage.setItem(key, value);
}

function removeBoth(key: string) {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(key);
  window.localStorage.removeItem(key);
}

export const session = {
  save(access: string, refresh: string, role: Role) {
    writeBoth(ACCESS_KEY, access);
    writeBoth(REFRESH_KEY, refresh);
    writeBoth(ROLE_KEY, role);
  },
  clear() {
    removeBoth(ACCESS_KEY);
    removeBoth(REFRESH_KEY);
    removeBoth(ROLE_KEY);
  },
  access(): string | null {
    return readEither(ACCESS_KEY);
  },
  refresh(): string | null {
    return readEither(REFRESH_KEY);
  },
  role(): Role | null {
    return readEither(ROLE_KEY) as Role | null;
  },
};

/**
 * Try to refresh the access token using the stored refresh token.
 * Returns the new access token, or null if refresh failed.
 *
 * Multiple concurrent 401s share the same in-flight refresh promise so we
 * only hit /api/auth/refresh once per token expiry.
 */
let refreshInflight: Promise<string | null> | null = null;

/** Curated user-facing message from a FastAPI error body. Only the object
 *  form `{"detail": {"message": "..."}}` is surfaced (those are intentional
 *  Bangla strings). The string form `{"detail": "..."}` is usually an internal
 *  English sentence (e.g. "Only customers have an order history") — never
 *  shown raw; the caller falls back to a clean status message. */
function curatedDetail(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { detail?: { message?: string } | string };
    const d = parsed.detail;
    if (d && typeof d === "object" && d.message) return d.message;
  } catch {}
  return null;
}

function apiErrorMessage(status: number, text: string): string {
  // Never dump a raw "API 403: {json}" at the user — every branch is clean.
  if (status === 401) return "আপনার লগইন সেশন শেষ হয়ে গেছে — আবার login করুন।";
  if (status === 403) return curatedDetail(text) || "এই কাজটির জন্য সঠিক account দিয়ে login করা দরকার।";
  if (status === 423) return curatedDetail(text) || "এই কথোপকথন আপাতত বন্ধ।";
  if (status === 429) return "এই মাসের free AI limit শেষ। পরের মাসের ১ তারিখে quota আবার reset হবে (এখনই reset করতে payment লাগবে — শীঘ্রই আসছে)।";
  // Server-side / gateway errors (502/503/504) — show something a user can
  // act on instead of a raw "API 503: ..." dump.
  if (status >= 500) return "সার্ভারে সাময়িক সমস্যা হচ্ছে। একটু পরে আবার চেষ্টা করুন।";
  return curatedDetail(text) || "কিছু একটা সমস্যা হয়েছে — আবার চেষ্টা করুন।";
}

async function tryRefreshAccessToken(): Promise<string | null> {
  if (refreshInflight) return refreshInflight;
  const r = session.refresh();
  if (!r) return null;
  refreshInflight = (async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: r }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { access_token?: string; refresh_token?: string };
      if (!data.access_token) return null;
      const role = session.role();
      session.save(data.access_token, data.refresh_token ?? r, (role ?? "customer") as Role);
      return data.access_token;
    } catch {
      return null;
    } finally {
      // Allow next refresh attempt after this one resolves.
      setTimeout(() => { refreshInflight = null; }, 0);
    }
  })();
  return refreshInflight;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const doFetch = async (token: string | null) => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    try {
      return await fetch(`${API_URL}${path}`, { ...init, headers });
    } catch {
      // A network-level failure (offline, DNS, or a 5xx returned by the
      // gateway without CORS headers) rejects with a bare "Failed to fetch".
      // Replace it with a friendly, actionable message.
      throw new Error("সার্ভারের সাথে সংযোগ করা যাচ্ছে না। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।");
    }
  };

  let token = session.access();
  let res = await doFetch(token);

  // Auto-refresh once on 401 (skip when calling refresh itself).
  if (
    res.status === 401 &&
    token &&
    !path.startsWith("/api/auth/refresh") &&
    !path.startsWith("/api/auth/logout")
  ) {
    const fresh = await tryRefreshAccessToken();
    if (fresh) {
      token = fresh;
      res = await doFetch(token);
    } else {
      // Refresh failed → wipe session so the UI shows logged-out state.
      session.clear();
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(apiErrorMessage(res.status, text));
  }
  return res.json() as Promise<T>;
}

export function googleLoginUrl(role: Role): string {
  // Always send app=website — mobile apps are APKs, not web-deployed.
  // Rider/pharmacy dashboards live on the main website at /rider and /pharmacy.
  const params = new URLSearchParams({ role, app: "website" });
  return `${API_URL}/api/auth/google/login?${params.toString()}`;
}

/** DEBUG-only. Hits the backend dev-login endpoint and saves the token pair. */
export async function devLogin(
  gmail: string,
  role: Role,
): Promise<{ access_token: string; refresh_token: string }> {
  const res = await fetch(`${API_URL}/api/auth/dev-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gmail, role }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`dev-login ${res.status}: ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
  };
  session.save(data.access_token, data.refresh_token, role);
  return data;
}

/**
 * Upload a cropped image blob. Pass a sensitive `kind`
 * (prescription | nid | license | birth_certificate | student_id) to store it
 * privately — the returned URL is then a protected `/api/files/raw/...` link
 * that only an authorised viewer can open (see `secureFileUrl`).
 */
export async function uploadImage(blob: Blob, kind?: SensitiveKind): Promise<string> {
  const fd = new FormData();
  const ext = blob.type === "image/png" ? "png" : "jpg";
  fd.append("file", blob, `upload.${ext}`);
  if (kind) fd.append("kind", kind);
  const headers: HeadersInit = {};
  const token = session.access();
  if (token) (headers as Record<string, string>).Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}/api/upload`, {
    method: "POST",
    body: fd,
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { url: string };
  return data.url;
}

/** Upload an arbitrary attachment (image / PDF) and report its mime back. */
export async function uploadAttachment(file: File): Promise<{ url: string; mime: string | null }> {
  const fd = new FormData();
  fd.append("file", file, file.name || "attachment");
  const headers: HeadersInit = {};
  const token = session.access();
  if (token) (headers as Record<string, string>).Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}/api/upload`, { method: "POST", body: fd, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { url: string; mime?: string | null };
  return { url: data.url, mime: data.mime ?? file.type ?? null };
}

export type SensitiveKind =
  | "prescription"
  | "nid"
  | "license"
  | "birth_certificate"
  | "student_id";

/** True if a URL points at a protected (private) file that needs a grant. */
export function isProtectedFileUrl(url: string | null | undefined): boolean {
  return !!url && url.includes("/api/files/raw/");
}

const _grantCache = new Map<string, { url: string; ts: number }>();

/**
 * Resolve a stored file URL into something a browser <img> can load.
 * Public URLs are returned unchanged. Protected `/api/files/raw/...` URLs are
 * exchanged (with the caller's auth) for a short-lived signed URL. Grants are
 * cached briefly so repeated renders don't spam the endpoint.
 */
export async function secureFileUrl(url: string | null | undefined): Promise<string> {
  if (!url) return "";
  if (!isProtectedFileUrl(url)) return url;
  if (url.includes("sig=")) return url;
  const cached = _grantCache.get(url);
  if (cached && Date.now() - cached.ts < 4 * 60 * 1000) return cached.url;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = session.access();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}/api/files/grant`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ref: url }),
  });
  if (!res.ok) throw new Error(`file grant ${res.status}`);
  const data = (await res.json()) as { url: string };
  _grantCache.set(url, { url: data.url, ts: Date.now() });
  return data.url;
}
