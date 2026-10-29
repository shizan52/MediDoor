// Same API client shape as `mobile-customer` and the website. Kept
// self-contained so each app can evolve independently.
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export const WEBSITE_URL =
  process.env.NEXT_PUBLIC_WEBSITE_URL ?? "http://localhost:3000";

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
      session.save(data.access_token, data.refresh_token ?? r, (role ?? "pharmacy") as Role);
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
      session.clear();
    }
  }
  if (!res.ok) {
    const text = await res.text();
    let message = text || `API ${res.status}`;
    let detail: unknown = null;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      detail = parsed.detail;
      if (typeof parsed.detail === "string") message = parsed.detail;
      if (parsed.detail && typeof parsed.detail === "object" && "message" in parsed.detail) {
        message = String((parsed.detail as { message?: unknown }).message || message);
      }
    } catch {}
    const err = new Error(message) as Error & { status?: number; detail?: unknown };
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res.json() as Promise<T>;
}

/**
 * Send the user to Google OAuth and ask the backend to redirect
 * back into THIS app (port 3200) after login. Backend honours
 * `app=mobile-pharmacy` via its APP_TARGETS allow-list.
 */
export function googleLoginUrl(role: Role = "pharmacy"): string {
  return `${API_URL}/api/auth/google/login?role=${role}&app=mobile-pharmacy`;
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

/** Resolve `/uploads/...` (relative) → absolute URL the mobile app can render. */
export function resolveMediaUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) return url;
  if (url.startsWith("/")) return `${API_URL}${url}`;
  return `${API_URL}/${url}`;
}
