"use client";

/**
 * OAuth return handler. Reads tokens from the URL hash, persists them, and:
 *   - bounces non-pharmacy roles back to /login with msg=wrong-role
 *   - deep-links new pharmacy accounts to the website's /register/pharmacy
 *   - sends already-registered pharmacy accounts to /
 *
 * Backend redirect format:
 *   {MOBILE_PHARMACY_URL}/auth/callback#access=…&refresh=…&role=…&registered=…
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
    const role = (params.get("role") as Role | null) ?? "pharmacy";
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

    // Only `pharmacy` accounts may use this app — others get bounced.
    if (role !== "pharmacy") {
      session.clear();
      router.replace(`/login?msg=wrong-role`);
      return;
    }

    if (!registered) {
      // New pharmacy — collect profile in-app on the mobile register screen.
      router.replace("/register/pharmacy");
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
