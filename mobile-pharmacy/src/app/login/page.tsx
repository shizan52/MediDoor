"use client";

/**
 * Mobile pharmacy login screen — visually unified with the customer
 * mobile login (3D gyroscope hero, brand blobs, glass CTA card) but
 * pre-set to the `pharmacy` OAuth role.
 */
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { googleLoginUrl, session, WEBSITE_URL } from "@/lib/api";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { MobileLoginHero } from "@/components/mobile-login-hero";

const ROLE_LABELS: Record<string, string> = {
  customer: "Customer",
  pharmacy: "Pharmacy",
  rider: "Rider",
};

/** Friendly Bangla copy for backend `/login?error=` bounces (OAuth failures,
 *  role mismatches). Mirrors the website's login-screen messages so the same
 *  failure reads the same everywhere. */
function loginErrorMessage(
  error: string | null,
  have: string | null,
  want: string | null,
): string | null {
  if (!error) return null;
  if (error === "role_mismatch") {
    const haveLabel = ROLE_LABELS[have ?? ""] ?? "অন্য role";
    const wantLabel = ROLE_LABELS[want ?? ""] ?? "এই role";
    return (
      `এই Gmail-টি ইতিমধ্যে ${haveLabel} হিসেবে registered — ` +
      `${wantLabel} হিসেবে ঢোকা যাবে না (একটি Gmail-এ একটাই role)। ` +
      `${haveLabel} app/section ব্যবহার করুন, অথবা আলাদা Gmail দিয়ে চেষ্টা করুন।`
    );
  }
  if (error.startsWith("oauth_error")) {
    return "Login সম্পূর্ণ হয়নি — সম্ভবত আগের একটা অসমাপ্ত login ছিল। আবার চেষ্টা করুন, এবার হয়ে যাবে।";
  }
  if (error === "email_not_verified") {
    return "এই Google account-এর email verify করা নেই — Google-এ email verify করে আবার চেষ্টা করুন।";
  }
  return "Login করা যায়নি — একটু পরে আবার চেষ্টা করুন।";
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params?.get("next") || "/";
  const msg = params?.get("msg");
  const loginError = loginErrorMessage(
    params?.get("error") ?? null,
    params?.get("have") ?? null,
    params?.get("want") ?? null,
  );

  // Already logged in (pharmacy) → bounce to next.
  useEffect(() => {
    if (session.access() && session.role() === "pharmacy") router.replace(next);
  }, [router, next]);

  // Stash next so /auth/callback can read it after Google round-trips.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem("medidoor_post_login_next", next);
    } catch { /* ignore */ }
  }, [next]);

  const [submitting, setSubmitting] = useState(false);
  const onGoogle = () => {
    setSubmitting(true);
    window.location.href = googleLoginUrl("pharmacy");
  };

  return (
    <main
      className="relative flex min-h-full flex-col overflow-hidden bg-gradient-to-br from-brand-50 via-white to-brand-100 dark:from-[#070b12] dark:via-[#0b1018] dark:to-[#091622]"
      style={{
        paddingTop: "calc(var(--safe-top) + 12px)",
        paddingBottom: "calc(var(--safe-bottom) + 16px)",
        paddingLeft: "calc(var(--safe-left) + 18px)",
        paddingRight: "calc(var(--safe-right) + 18px)",
      }}
    >
      {/* Brand-tinted blobs — same recipe as the customer mobile login. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-blob absolute -left-24 -top-24 h-64 w-64 rounded-full bg-brand-300/40 blur-3xl" />
        <div className="animate-blob absolute -right-32 top-1/3 h-72 w-72 rounded-full bg-brand-500/30 blur-3xl [animation-delay:-4s]" />
        <div className="animate-blob absolute bottom-12 left-1/3 h-56 w-56 rounded-full bg-brand-200/40 blur-3xl [animation-delay:-8s]" />
      </div>

      {/* Header */}
      <header className="relative z-10 flex items-center justify-between">
        <BrandLogo className="h-7 w-auto" />
        <ThemeToggle />
      </header>

      {/* Hero — 3D gyroscope card, pharmacy role */}
      <section className="relative z-10 mt-4 flex-1">
        <MobileLoginHero activeRole="pharmacy" />
      </section>

      {/* CTA */}
      <section className="relative z-10 mt-4 space-y-3">
        {msg === "wrong-role" && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50/90 p-3 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            এই account টি pharmacy নয়। MediDoor pharmacy app শুধু pharmacy account-এর জন্য।
          </div>
        )}
        {msg === "register-on-web" && (
          <div className="rounded-2xl border border-sky-300 bg-sky-50/90 p-3 text-xs text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200">
            নতুন pharmacy registration এখন website-এ — আমরা আপনাকে সেখানে নিয়ে যাচ্ছি।
          </div>
        )}
        {loginError && (
          <div className="rounded-2xl border border-rose-300 bg-rose-50/90 p-3 text-xs text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200">
            {loginError}
          </div>
        )}

        <button
          type="button"
          onClick={onGoogle}
          disabled={submitting}
          className="tap flex w-full items-center justify-center gap-2 rounded-full bg-slate-900 py-3.5 text-sm font-semibold text-white shadow-lg shadow-slate-900/20 disabled:opacity-60 dark:bg-white dark:text-slate-900"
        >
          <GoogleG />
          Continue with Google
          <ArrowRight size={16} />
        </button>

        <a
          href={`${WEBSITE_URL}/register/pharmacy`}
          className="tap block text-center text-xs font-semibold text-brand-600 dark:text-brand-300"
        >
          নতুন pharmacy register করব →
        </a>

        <p className="text-center text-[10px] leading-relaxed text-slate-400">
          Login করলে আমাদের{" "}
          <Link href={`${WEBSITE_URL}/`} className="underline">Terms</Link> ও{" "}
          <Link href={`${WEBSITE_URL}/`} className="underline">Privacy</Link> মেনে চলতে সম্মত হচ্ছেন।
        </p>
      </section>
    </main>
  );
}

function GoogleG() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path
        fill="#EA4335"
        d="M12 10.2v3.9h5.5c-.2 1.4-1.6 4.1-5.5 4.1-3.3 0-6-2.7-6-6.2s2.7-6.2 6-6.2c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.9 3 14.7 2 12 2 6.9 2 2.8 6.1 2.8 11.2S6.9 20.4 12 20.4c6.9 0 9.2-4.8 9.2-7.3 0-.5-.1-.9-.1-1.3H12z"
      />
    </svg>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
