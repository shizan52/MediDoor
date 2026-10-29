"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { session, type Role } from "@/lib/api";

/**
 * Reads the OAuth result from the URL hash, persists it, then routes the
 * user to the page they originally wanted (`medidoor_post_login_next` from
 * sessionStorage) or `/` by default.
 *
 * Backend redirect format (matches the website):
 *   {FRONTEND_URL}/auth/callback#access=…&refresh=…&role=…&registered=…
 */
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
    const role = (params.get("role") as Role | null) ?? "customer";
    // Backend sends "1" / "0" — accept "true" too for forward compat.
    const registeredRaw = params.get("registered");
    const registered = registeredRaw === "1" || registeredRaw === "true";

    if (!access || !refresh) {
      setError("Login response থেকে token পেলাম না।");
      return;
    }

    // Only `customer` accounts get to use this app. Check BEFORE saving the
    // session — persisting a pharmacy/rider token here would let the wrong
    // role slip past the login screen's session check.
    if (role !== "customer") {
      session.clear();
      router.replace(`/login?msg=customer-only`);
      return;
    }

    session.save(access, refresh, role);

    let next: string | null = null;
    try {
      next = window.sessionStorage.getItem("medidoor_post_login_next");
      window.sessionStorage.removeItem("medidoor_post_login_next");
    } catch {
      /* ignore */
    }

    if (!registered) {
      // New customer — collect profile in-app on the mobile register screen.
      router.replace("/register/customer");
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
