"use client";

/**
 * LoginGate — global, event-driven login prompt.
 *
 * Any client code can ask the user to log in by dispatching:
 *
 *   window.dispatchEvent(new CustomEvent("medidoor-require-login", {
 *     detail: { feature: "Pharmacy chat", next: "/store/abc" }
 *   }));
 *
 * Mounted once in <Providers> so every page (landing, store, pharmacy
 * dashboard, ...) shares the same modal. If the user is already logged in
 * (session.access() truthy) the event is ignored.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, LogIn, Sparkles, X } from "lucide-react";
import { session } from "@/lib/api";

type Detail = {
  feature?: string;
  message?: string;
  next?: string;
  role?: "customer" | "pharmacy" | "rider";
};

export function LoginGate() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Detail>({});
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const handler = (event: Event) => {
      if (typeof window !== "undefined" && session.access()) return;
      const nextDetail = (event as CustomEvent<Detail>).detail || {};
      setDetail(nextDetail);
      setLeaving(false);
      setOpen(true);
    };
    window.addEventListener("medidoor-require-login", handler);
    return () => window.removeEventListener("medidoor-require-login", handler);
  }, []);

  if (!open) return null;

  const role = detail.role || "customer";
  const next = detail.next || (typeof window !== "undefined" ? window.location.pathname + window.location.search : "/");
  const loginHref = `/login?role=${role}&next=${encodeURIComponent(next)}`;

  const close = () => {
    if (!leaving) setOpen(false);
  };

  const goLogin = () => {
    setLeaving(true);
    router.push(loginHref);
  };

  return (
    <div
      className="fixed inset-0 z-[9998] grid place-items-center bg-black/55 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-gate-title"
      onClick={close}
    >
      <div
        className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-white/40 bg-white p-6 shadow-2xl dark:border-white/10 dark:bg-[#0b1018]"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          onClick={close}
          disabled={leaving}
          aria-label="Close"
          className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full bg-black/5 text-black/60 transition hover:bg-black/10 disabled:opacity-50 dark:bg-white/10 dark:text-white/70 dark:hover:bg-white/20"
        >
          <X size={14} />
        </button>

        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-lg shadow-brand-500/40">
          <Sparkles size={20} />
        </div>

        <h2 id="login-gate-title" className="mt-4 text-xl font-bold leading-snug">
          {detail.feature ? `${detail.feature} ব্যবহার করতে login করুন` : "Login করুন"}
        </h2>

        <p className="mt-2 text-sm leading-relaxed opacity-75">
          {detail.message ||
            "MediDoor এর সব feature — pharmacy-র সাথে chat, order, AI medicine search, smart prescription — ব্যবহার করতে শুধু একবার login করতে হবে।"}
        </p>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            onClick={close}
            disabled={leaving}
            className="order-2 inline-flex items-center justify-center rounded-full border border-black/10 bg-white/70 px-4 py-2 text-sm font-medium hover:bg-black/5 disabled:opacity-60 sm:order-1 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
          >
            পরে করব
          </button>
          <button
            onClick={goLogin}
            disabled={leaving}
            className="order-1 inline-flex items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-brand-500 to-brand-600 px-5 py-2 text-sm font-semibold text-white shadow-md shadow-brand-500/30 hover:brightness-110 disabled:opacity-70 sm:order-2"
            autoFocus
          >
            {leaving ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
            {leaving ? "Opening..." : "Login করুন"}
          </button>
        </div>

        <p className="mt-3 text-center text-[11px] opacity-50">
          Account নেই?{" "}
          <button
            onClick={() => {
              setOpen(false);
              router.push(`/register?role=${role}`);
            }}
            disabled={leaving}
            className="font-semibold text-brand-600 hover:underline disabled:opacity-60 dark:text-brand-300"
          >
            Sign up
          </button>
        </p>
      </div>
    </div>
  );
}

export function requireLogin(detail: Detail = {}) {
  if (typeof window === "undefined") return;
  if (session.access()) return;
  window.dispatchEvent(new CustomEvent("medidoor-require-login", { detail }));
}