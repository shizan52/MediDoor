"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  CalendarDays,
  CheckCircle2,
  Clock,
  CreditCard,
  Info,
  Loader2,
  LogOut,
  Truck,
  Wallet,
  X,
} from "lucide-react";
import { api, session, type Role } from "@/lib/api";
import { rider as riderApi } from "@/lib/rider";
import { BrandLogo } from "@/components/brand-logo";
import { ProfilePhotoEditor } from "@/components/profile-photo-editor";
import { ThemeToggle } from "@/components/theme-toggle";

type RiderProfile = {
  full_name?: string;
  nick_name?: string | null;
  phone_number?: string;
  profile_photo_url?: string | null;
  is_verified?: boolean;
};

type Me = {
  account_id: string;
  gmail: string;
  role: Role;
  is_registered: boolean;
  profile?: RiderProfile | null;
};

type WindowStat = { earnings: number; deliveries: number; active_days: number };
type Earnings = {
  windows: Record<"last_48h" | "week" | "month" | "year" | "lifetime", WindowStat>;
  platform_fee_pct: number;
  platform_fee_due: number;
  currency: string;
};

const WINDOW_LABELS: Record<keyof Earnings["windows"], { title: string; sub: string }> = {
  last_48h: { title: "শেষ ৪৮ ঘণ্টা", sub: "Platform fee হিসাব" },
  week:     { title: "শেষ ৭ দিন", sub: "সাপ্তাহিক ফলাফল" },
  month:    { title: "শেষ ৩০ দিন", sub: "মাসিক আয়" },
  year:     { title: "শেষ ৩৬৫ দিন", sub: "বার্ষিক আয়" },
  lifetime: { title: "মোট", sub: "MediDoor-এ মোট আয়" },
};

export function RiderMyProfilePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [earn, setEarn] = useState<Earnings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    if (!session.access()) {
      router.replace("/login");
      return;
    }
    if (session.role() !== "rider") {
      router.replace("/");
      return;
    }
    (async () => {
      try {
        const [m, e] = await Promise.all([
          api<Me>("/api/auth/me"),
          riderApi.earnings(),
        ]);
        if (m.role !== "rider") {
          router.replace(`/${m.role}`);
          return;
        }
        if (!m.is_registered) {
          router.replace("/register/rider");
          return;
        }
        setMe(m);
        setEarn(e);
      } catch (ex) {
        setError(ex instanceof Error ? ex.message : "Load failed");
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  const reloadEarnings = useCallback(async () => {
    try {
      const e = await riderApi.earnings();
      setEarn(e);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : "Failed to refresh earnings");
    }
  }, []);

  const onLogout = () => {
    setLoggingOut(true);
    void api("/api/auth/logout", { method: "POST" }).catch(() => {});
    session.clear();
    router.replace("/login");
  };

  const onPay = async () => {
    if (!earn || earn.platform_fee_due <= 0) {
      setError("এখন কোনো fee due নেই।");
      return;
    }
    setPaying(true);
    try {
      const r = await riderApi.payPlatformFee(earn.platform_fee_due);
      setOkMsg(`✅ ৳ ${r.amount.toFixed(2)} payment successful.`);
      setPayOpen(false);
      await reloadEarnings();
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : "Payment failed");
    } finally {
      setPaying(false);
    }
  };

  const profile = me?.profile ?? null;
  const displayName =
    profile?.nick_name || profile?.full_name || me?.gmail?.split("@")[0] || "Rider";

  // Persist a new (or removed) profile photo, then refresh local state.
  const onSavePhoto = async (url: string | null) => {
    const updated = await api<Me>("/api/auth/me/rider", {
      method: "PATCH",
      body: JSON.stringify({ profile_photo_url: url }),
    });
    setMe(updated);
    setOkMsg(url ? "প্রোফাইল ছবি আপডেট হয়েছে।" : "প্রোফাইল ছবি সরানো হয়েছে।");
  };

  const pct = earn ? Math.round(earn.platform_fee_pct * 100) : 9;

  return (
    <main className="relative min-h-screen overflow-hidden bg-gradient-to-br from-brand-50 via-white to-brand-100 dark:from-[#070b12] dark:via-[#0b1018] dark:to-[#091622]">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-32 -left-24 h-[420px] w-[420px] rounded-full bg-brand-300/40 blur-3xl animate-blob" />
        <div className="absolute top-1/3 -right-24 h-[460px] w-[460px] rounded-full bg-emerald-300/30 blur-3xl animate-blob [animation-delay:2s]" />
      </div>

      <header className="sticky top-0 z-30 border-b border-black/5 bg-white/70 backdrop-blur dark:border-white/10 dark:bg-[#0b1018]/70">
        <div className="flex w-full items-center gap-3 px-6 py-3 lg:px-10">
          <BrandLogo className="h-9 w-auto" />
          <button
            onClick={() => router.push("/rider")}
            className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-black/10 dark:bg-white/10 dark:text-slate-100 dark:hover:bg-white/20"
          >
            <ArrowLeft size={12} /> ড্যাশবোর্ড
          </button>

          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <button
              onClick={onLogout}
              disabled={loggingOut}
              className="inline-flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-black/10 disabled:opacity-60 dark:bg-white/10 dark:text-slate-100 dark:hover:bg-white/20"
            >
              {loggingOut ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />} {loggingOut ? "লগআউট হচ্ছে…" : "লগআউট"}
            </button>
          </div>
        </div>
      </header>

      <div className="px-6 py-6 lg:px-10">
        {/* alerts */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="mb-4 flex items-start gap-2 rounded-2xl border border-red-300/60 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-200"
            >
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              <p className="flex-1">{error}</p>
              <button onClick={() => setError(null)}><X size={14} /></button>
            </motion.div>
          )}
          {okMsg && (
            <motion.div
              initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="mb-4 flex items-start gap-2 rounded-2xl border border-emerald-300/60 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-200"
            >
              <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
              <p className="flex-1">{okMsg}</p>
              <button onClick={() => setOkMsg(null)}><X size={14} /></button>
            </motion.div>
          )}
        </AnimatePresence>

        {loading && <p className="opacity-70">লোড হচ্ছে…</p>}

        {!loading && me && (
          <div className="grid gap-6 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
            {/* ---------------- Left: identity card ---------------- */}
            <motion.div
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
              className="h-fit overflow-hidden rounded-3xl border border-black/5 bg-white/80 shadow-xl backdrop-blur dark:border-white/10 dark:bg-white/5"
            >
              <div className="flex items-center gap-4 p-5">
                <ProfilePhotoEditor
                  photoUrl={profile?.profile_photo_url}
                  displayName={displayName}
                  onSave={onSavePhoto}
                  className="h-16 w-16"
                  rounded="rounded-2xl"
                  ringClassName="ring-2 ring-brand-400/40"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-bold text-slate-900 dark:text-slate-100">
                    {displayName}
                  </p>
                  <p className="truncate text-xs text-slate-600 dark:text-slate-400">
                    {me.gmail}
                  </p>
                  {profile?.is_verified && (
                    <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                      <BadgeCheck size={10} /> ভেরিফাইড
                    </span>
                  )}
                </div>
              </div>
              <div className="border-t border-black/5 px-5 py-3 text-xs text-slate-700 dark:border-white/10 dark:text-slate-300">
                <p className="mb-1 flex items-center gap-2">
                  <Truck size={12} className="opacity-60" />
                  ফোন: <span className="font-medium">{profile?.phone_number || "—"}</span>
                </p>
                <p className="flex items-center gap-2">
                  <Wallet size={12} className="opacity-60" />
                  কারেন্সি: <span className="font-medium">BDT</span>
                </p>
              </div>
            </motion.div>

            {/* ---------------- Right: payment + stats ---------------- */}
            <div className="space-y-6">
              {/* Platform fee due */}
              <motion.div
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                className="overflow-hidden rounded-3xl border border-brand-200 bg-gradient-to-br from-brand-500 to-emerald-600 p-6 text-white shadow-xl dark:border-brand-500/30"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-white/80">
                      Platform fee বকেয়া
                    </p>
                    <p className="mt-1 text-4xl font-extrabold tabular-nums">
                      ৳ {earn?.platform_fee_due?.toFixed(2) ?? "0.00"}
                    </p>
                    <p className="mt-2 max-w-md text-xs leading-relaxed text-white/90">
                      MediDoor প্রতি ৪৮ ঘণ্টার আয় থেকে <b>{pct}%</b> platform fee রাখে।
                      গত ৪৮ ঘণ্টায় আপনার আয় ছিল{" "}
                      <b>৳ {earn?.windows.last_48h.earnings.toFixed(2) ?? "0.00"}</b>{" "}
                      ({earn?.windows.last_48h.deliveries ?? 0} ডেলিভারি) — তাই এই fee বকেয়া।
                    </p>
                  </div>
                  <button
                    onClick={() => setPayOpen(true)}
                    disabled={!earn || earn.platform_fee_due <= 0}
                    className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-bold text-brand-700 shadow-lg transition hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <CreditCard size={16} /> এখন pay করুন
                  </button>
                </div>
                <div className="mt-4 flex items-center gap-2 rounded-2xl bg-white/15 px-3 py-2 text-xs text-white/90 backdrop-blur">
                  <Info size={14} className="flex-shrink-0" />
                  <p>
                    এই fee শেষ ৪৮ ঘণ্টার আয়ের {pct}% — প্রতি ডেলিভারির পর স্বয়ংক্রিয়ভাবে হিসাব হয়।
                  </p>
                </div>
              </motion.div>

              {/* Income breakdown */}
              <motion.div
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                className="rounded-3xl border border-black/5 bg-white/80 p-5 shadow-xl backdrop-blur dark:border-white/10 dark:bg-white/5"
              >
                <div className="mb-4 flex items-center gap-2">
                  <CalendarDays size={16} className="text-brand-600 dark:text-brand-400" />
                  <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                    MediDoor আয়
                  </h2>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {(Object.keys(WINDOW_LABELS) as Array<keyof Earnings["windows"]>).map((k) => {
                    const w = earn?.windows[k] ?? { earnings: 0, deliveries: 0, active_days: 0 };
                    const meta = WINDOW_LABELS[k];
                    const accent = k === "last_48h"
                      ? "border-brand-300 bg-brand-50/70 dark:border-brand-500/30 dark:bg-brand-500/10"
                      : "border-black/5 bg-white/60 dark:border-white/10 dark:bg-white/5";
                    return (
                      <div
                        key={k}
                        className={`rounded-2xl border p-4 ${accent}`}
                      >
                        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                          {meta.title}
                        </p>
                        <p className="mt-1 text-2xl font-extrabold tabular-nums text-slate-900 dark:text-slate-100">
                          ৳ {w.earnings.toFixed(2)}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300">
                          <span className="inline-flex items-center gap-1">
                            <Truck size={11} /> {w.deliveries} ডেলিভারি
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Clock size={11} /> {w.active_days} সক্রিয় দিন
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                          {meta.sub}
                        </p>
                      </div>
                    );
                  })}
                </div>

                {earn && earn.windows.lifetime.deliveries === 0 && (
                  <p className="mt-4 rounded-2xl border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200">
                    এখনও কোনো delivery complete হয়নি। প্রথম delivery complete হলেই এখানে আপনার income দেখা যাবে।
                  </p>
                )}
              </motion.div>
            </div>
          </div>
        )}
      </div>

      {/* ---------------- Pay modal ---------------- */}
      <AnimatePresence>
        {payOpen && earn && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
            onClick={() => !paying && setPayOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm rounded-3xl border border-black/5 bg-white p-6 shadow-2xl dark:border-white/10 dark:bg-[#0f1722]"
            >
              <div className="mb-2 flex items-center gap-2">
                <CreditCard className="text-brand-600 dark:text-brand-400" size={18} />
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  Payment confirm
                </h3>
              </div>
              <p className="text-sm text-slate-700 dark:text-slate-300">
                আপনি MediDoor platform-কে নিচের amount pay করতে চাইছেন:
              </p>
              <div className="my-4 rounded-2xl bg-brand-50 p-4 text-center dark:bg-brand-500/10">
                <p className="text-xs font-semibold uppercase tracking-wider text-brand-700 dark:text-brand-300">
                  Amount
                </p>
                <p className="mt-1 text-3xl font-extrabold text-brand-700 tabular-nums dark:text-brand-200">
                  ৳ {earn.platform_fee_due.toFixed(2)}
                </p>
                <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">
                  শেষ ৪৮ ঘণ্টার আয়ের {pct}% (৳ {earn.windows.last_48h.earnings.toFixed(2)})
                </p>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Note: এটা mock payment confirmation। Real bKash/Nagad gateway integration শীঘ্রই আসছে।
              </p>
              <div className="mt-5 flex gap-2">
                <button
                  onClick={() => setPayOpen(false)}
                  disabled={paying}
                  className="flex-1 rounded-full border border-black/10 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-white/10"
                >
                  বাতিল
                </button>
                <button
                  onClick={onPay}
                  disabled={paying}
                  className="flex-1 rounded-full bg-brand-500 px-4 py-2 text-sm font-bold text-white shadow-md shadow-brand-500/30 hover:bg-brand-600 disabled:opacity-50"
                >
                  {paying ? "Processing…" : "Confirm করে pay"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
