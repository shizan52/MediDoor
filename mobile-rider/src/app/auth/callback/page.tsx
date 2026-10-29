"use client";

/**
 * OAuth callback for the rider mobile app. Reads tokens from the URL hash,
 * persists them, and routes:
 *   - non-rider role → /login?msg=wrong-role
 *   - unregistered rider → website /register/rider (registration form lives on web)
 *   - registered rider → next URL or /
 *
 * Backend redirect format:
 *   {MOBILE_RIDER_URL}/auth/callback#access=…&refresh=…&role=…&registered=…
 */
import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { session, WEBSITE_URL, type Role } from "@/lib/api";

function CallbackInner() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);
    const access = params.get("access");
    const refresh = params.get("refresh");
    const role = (params.get("role") as Role | null) ?? "rider";
    const registeredRaw = params.get("registered");
    const registered = registeredRaw === "1" || registeredRaw === "true";

    if (!access || !refresh) {
      setError("Login response থেকে token পেলাম না।");
      return;
    }

    session.save(access, refresh, role);

    let next: string | null = null;
    try {
      next = window.sessionStorage.getItem("medidoor_post_login_next");
      window.sessionStorage.removeItem("medidoor_post_login_next");
    } catch { /* ignore */ }

    if (role !== "rider") {
      session.clear();
      router.replace(`/login?msg=wrong-role`);
      return;
    }

    if (!registered) {
      // Rider registration form (NID + photo + bike info) lives on website.
      params.set("handoff", "register");
      window.location.href = `${WEBSITE_URL}/auth/callback#${params.toString()}`;
      return;
    }

    router.replace(next || "/");
  }, [router]);

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {error ? (
        <p className="text-sm text-rose-500">{error}</p>
      ) : (
        <>
          <Loader2 size={28} className="animate-spin text-brand-500" />
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Signing you in…
          </p>
        </>
      )}
    </div>
  );
}

export default function CallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackInner />
    </Suspense>
  );
}
