"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { session, type Role } from "@/lib/api";

/**
 * Backend redirects here as:
 *   /auth/callback#access=...&refresh=...&role=...&registered=0|1
 *
 * We persist tokens to localStorage then route the user to either
 * the registration page (if profile incomplete) or the role's home.
 *
 * Mobile apps (mobile-rider, mobile-pharmacy, mobile-customer) are APKs
 * and not web-deployed. All login/redirect logic is handled here on the
 * main website. Rider → /rider, Pharmacy → /pharmacy, Customer → /.
 */
export default function AuthCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    const access = params.get("access");
    const refresh = params.get("refresh");
    const role = params.get("role") as Role | null;
    const registered = params.get("registered") === "1";

    if (!access || !refresh || !role) {
      router.replace("/login?error=missing_userinfo");
      return;
    }

    session.save(access, refresh, role);

    // Honor a ?next= path that was stashed when the user was redirected
    // to /login by the LoginGate. Only applies when the profile is
    // already complete (else we still need to finish registration).
    let next: string | null = null;
    try {
      const stashed = window.sessionStorage.getItem("medidoor_post_login_next");
      window.sessionStorage.removeItem("medidoor_post_login_next");
      if (stashed && stashed.startsWith("/")) next = stashed;
    } catch { /* ignore */ }

    if (!registered) {
      router.replace(`/register/${role}`);
    } else if (next) {
      router.replace(next);
    } else if (role === "customer") {
      // Customers go straight to the public landing/storefront.
      router.replace("/");
    } else {
      // Rider → /rider, Pharmacy → /pharmacy (dashboards on main website).
      router.replace(`/${role}`);
    }
  }, [router]);

  return (
    <main className="grid min-h-screen place-items-center">
      <div className="text-center">
        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
        <p className="mt-4 text-sm opacity-70">Signing you in…</p>
      </div>
    </main>
  );
}
