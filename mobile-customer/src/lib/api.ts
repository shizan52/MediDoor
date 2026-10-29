// Same as the website's API client. Kept self-contained so the mobile
// app and the website can evolve independently. See
// `frontend/src/lib/api.ts` for the original.
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type Role = "customer" | "pharmacy" | "rider";

const ACCESS_KEY = "medidoor_access";
const REFRESH_KEY = "medidoor_refresh";
const ROLE_KEY = "medidoor_role";

function readEither(key: string): string | null {
  if (typeof window === "undefined") return null;
  const fromSession = window.sessionStorage.getItem(key);
  if (fromSession) return fromSession;
  const fromLocal = window.localStorage.getItem(key);
  if (fromLocal) window.sessionStorage.setItem(key, fromLocal);
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
  access: () => readEither(ACCESS_KEY),
  refresh: () => readEither(REFRESH_KEY),
  role: () => readEither(ROLE_KEY) as Role | null,
};

let refreshInflight: Promise<string | null> | null = null;

/** Pull the CURATED, user-facing message out of a FastAPI error body.
 *  `{"detail": {"message": "..."}}` → the message (these are intentional
 *  Bangla strings). `{"detail": "..."}` string form is usually an internal
 *  English sentence (e.g. "Only customers have an order history"), so we do
 *  NOT surface it raw — the caller falls back to a clean status message. */
function curatedDetail(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { detail?: { message?: string } | string };
    const d = parsed.detail;
    if (d && typeof d === "object" && d.message) return d.message;
  } catch {}
  return null;
}

function apiErrorMessage(status: number, text: string): string {
  // Never dump a raw "API 403: {json}" at the user. Every branch returns a
  // clean, human sentence (Bangla) or a curated backend message.
  if (status === 401) return "আপনার লগইন সেশন শেষ হয়ে গেছে — আবার login করুন।";
  if (status === 403) return curatedDetail(text) || "এই কাজটির জন্য সঠিক account দিয়ে login করা দরকার।";
  if (status === 423) return curatedDetail(text) || "এই কথোপকথন আপাতত বন্ধ।";
  if (status === 429) return "AI limit শেষ। Profile থেকে quota renew করুন বা পরের মাসে আবার ব্যবহার করুন।";
  if (status >= 500) return "সার্ভারে সাময়িক সমস্যা হচ্ছে — একটু পরে আবার চেষ্টা করুন।";
  return curatedDetail(text) || "কিছু একটা সমস্যা হয়েছে — আবার চেষ্টা করুন।";
}

/** Session died and could not be refreshed. Clear it and bounce to /login so
 *  a stale/expired token never leaves the user stranded on a raw error with
 *  no way back to login. Guarded so it fires once and never loops on /login. */
function forceReloginRedirect(): void {
  if (typeof window === "undefined") return;
  session.clear();
  const path = window.location.pathname + window.location.search;
  if (window.location.pathname.startsWith("/login")) return;
  window.location.assign(`/login?next=${encodeURIComponent(path)}`);
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
      setTimeout(() => { refreshInflight = null; }, 0);
    }
  })();
  return refreshInflight;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const doFetch = async (token: string | null) => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetch(`${API_URL}${path}`, { ...init, headers });
  };

  let token = session.access();
  let res = await doFetch(token);
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
      // Refresh failed → the token is dead. Clear it and send the user to
      // login instead of throwing a raw 401 they can't recover from.
      forceReloginRedirect();
    }
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(apiErrorMessage(res.status, text));
  }
  return res.json() as Promise<T>;
}

export function googleLoginUrl(role: Role): string {
  // The `app` param tells the backend to bounce back to *this* app's
  // /auth/callback after Google succeeds — without it the user lands
  // on the website (port 3000) and can't continue inside the mobile app.
  return `${API_URL}/api/auth/google/login?role=${role}&app=mobile-customer`;
}

export async function uploadImage(blob: Blob): Promise<string> {
  const fd = new FormData();
  const ext = blob.type === "image/png" ? "png" : "jpg";
  fd.append("file", blob, `upload.${ext}`);
  const headers: HeadersInit = {};
  const token = session.access();
  if (token) (headers as Record<string, string>).Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}/api/upload`, { method: "POST", body: fd, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { url: string };
  return data.url;
}

/**
 * Resolve any backend-served image (relative `/uploads/...` or full URL)
 * into a fully qualified URL the mobile app can render. Necessary because
 * `next/image unoptimized` still needs an absolute URL when the backend
 * returns a relative path like `/uploads/abc.jpg`.
 */
export function resolveMediaUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) return url;
  if (url.startsWith("/")) return `${API_URL}${url}`;
  return `${API_URL}/${url}`;
}
