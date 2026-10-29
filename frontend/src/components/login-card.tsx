"use client";

import { motion, AnimatePresence } from "framer-motion";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Pill, Store, Bike } from "lucide-react";
import { googleLoginUrl, type Role } from "@/lib/api";

// DNA helix is client-only (uses three.js / WebGL).
const DnaHelix = dynamic(
  () => import("@/components/dna-helix").then((m) => m.DnaHelix),
  { ssr: false, loading: () => <div className="h-20 w-20" /> }
);

type RoleDef = {
  id: Role;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
};

const ROLES: RoleDef[] = [
  { id: "customer", label: "Customer", hint: "ঘরে বসে medicine অর্ডার করুন", icon: Pill },
  { id: "pharmacy", label: "Pharmacy", hint: "নিজের pharmacy run করুন",        icon: Store },
  { id: "rider",    label: "Rider",    hint: "deliver করুন, আয় করুন",          icon: Bike },
];

type Props = {
  initialError?: string | null;
  initialNotice?: string | null;
  /** Controlled selection — when null, no role chosen yet. */
  role: Role | null;
  onRoleChange: (r: Role) => void;
};

export function LoginCard({ initialError, initialNotice, role, onRoleChange }: Props) {
  const [loading, setLoading] = useState(false);

  const onContinue = () => {
    if (!role) return;
    setLoading(true);
    window.location.href = googleLoginUrl(role);
  };

  return (
    <div className="w-full max-w-md">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="glass rounded-3xl p-8 shadow-2xl shadow-brand-900/10"
      >
        <div className="flex items-center gap-3">
          <DnaHelix className="h-20 w-20 shrink-0" />
          <div>
            <h1 className="text-3xl font-bold tracking-tight leading-tight">
              Welcome to MediDoor
            </h1>
            <p className="mt-1 text-sm opacity-70">
              {role
                ? "Sign in with Google. নতুন হলে selected role-এ account খুলবে — পুরোনো account হলে সেই role নির্বাচন করুন (ভুল role দিলে login হবে না)।"
                : "প্রথমে আপনি কে সেটা নির্বাচন করুন।"}
            </p>
          </div>
        </div>

        <div className="mt-6">
          <p className="text-xs font-medium uppercase tracking-wider opacity-60 mb-2">
            I am a
          </p>
          <div className="grid grid-cols-3 gap-2 rounded-2xl bg-black/5 dark:bg-white/5 p-1">
            {ROLES.map((r) => {
              const Icon = r.icon;
              const active = role === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onRoleChange(r.id)}
                  className="relative rounded-xl py-2.5 text-sm font-medium transition"
                >
                  {active && (
                    <motion.span
                      layoutId="role-pill"
                      className="absolute inset-0 rounded-xl bg-brand-500 shadow-lg shadow-brand-500/30"
                      transition={{ type: "spring", stiffness: 500, damping: 32 }}
                    />
                  )}
                  <span
                    className={`relative z-10 flex items-center justify-center gap-1.5 ${
                      active ? "text-white" : "opacity-70"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {r.label}
                  </span>
                </button>
              );
            })}
          </div>

          <AnimatePresence mode="wait">
            {role && (
              <motion.p
                key={role}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 0.7, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2 }}
                className="mt-2 text-xs"
              >
                {ROLES.find((r) => r.id === role)?.hint}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {initialError && (
          <div className="mt-4 rounded-xl border border-red-300/50 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {humanError(initialError)}
          </div>
        )}

        {initialNotice && (
          // N11 — render as plain text (no dangerouslySetInnerHTML) so a notice
          // can never inject HTML/script, even if a future caller wires user
          // input into it.
          <div className="mt-4 rounded-xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            {initialNotice}
          </div>
        )}

        <button
          type="button"
          onClick={onContinue}
          disabled={loading || !role}
          className="mt-6 group flex w-full items-center justify-center gap-3 rounded-2xl bg-white dark:bg-white/95 px-5 py-3.5 font-medium text-gray-800 shadow-lg ring-1 ring-black/5 transition hover:shadow-xl hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0 disabled:cursor-not-allowed"
        >
          <GoogleIcon className="h-5 w-5" />
          {loading
            ? "Redirecting…"
            : role
            ? `Continue with Google as ${roleLabel(role)}`
            : "Select a role first"}
        </button>

        <p className="mt-6 text-center text-xs opacity-60">
          By continuing you agree to MediDoor&apos;s Terms &amp; Privacy Policy.
        </p>
      </motion.div>

      <p className="mt-4 text-center text-xs opacity-60">
        একটি Gmail-এ একটাই role থাকতে পারে। পরে role পরিবর্তন করতে support-এর সাথে যোগাযোগ করুন।
      </p>
    </div>
  );
}

function roleLabel(r: Role) {
  return r.charAt(0).toUpperCase() + r.slice(1);
}

function humanError(code: string) {
  // OAuth-exchange failures arrive as "oauth_error:<reason>".
  if (code.startsWith("oauth_error:")) {
    const reason = code.slice("oauth_error:".length);
    if (reason === "mismatching_state" || reason === "csrf_warning")
      return "নিরাপত্তা যাচাই (session) মেলেনি — সম্ভবত cookie/সময়ের সমস্যা। অনুগ্রহ করে আবার একবার চেষ্টা করুন।";
    if (reason === "access_denied")
      return "Google sign-in বাতিল হয়েছে। আবার চেষ্টা করুন।";
    return "Google sign-in সম্পূর্ণ হয়নি। আবার চেষ্টা করুন।";
  }
  switch (code) {
    case "email_not_verified":
      return "আপনার Google account এর email verified নয়।";
    case "missing_userinfo":
      return "Google থেকে account তথ্য পাওয়া যায়নি।";
    case "google_not_configured":
      return "Google sign-in এখনও পুরোপুরি configured নয় (Client Secret missing)। Backend admin কে বলুন।";
    default:
      return "Sign-in failed. আবার চেষ্টা করুন।";
  }
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 35.5 24 35.5c-6.4 0-11.5-5.1-11.5-11.5S17.6 12.5 24 12.5c2.9 0 5.6 1.1 7.6 2.9l5.7-5.7C33.7 6.5 29.1 4.5 24 4.5 13.2 4.5 4.5 13.2 4.5 24S13.2 43.5 24 43.5 43.5 34.8 43.5 24c0-1.2-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c2.9 0 5.6 1.1 7.6 2.9l5.7-5.7C33.7 6.9 29.1 5 24 5 16.3 5 9.7 9 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 43.5c5 0 9.6-1.9 13-5l-6-5.1c-2 1.4-4.4 2.2-7 2.2-5.3 0-9.7-3.1-11.3-7.5l-6.5 5C9.5 39.5 16.2 43.5 24 43.5z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4-4 5.3l6 5.1c-.4.4 6.7-4.9 6.7-14.4 0-1.2-.1-2.3-.4-3.5z" />
    </svg>
  );
}
