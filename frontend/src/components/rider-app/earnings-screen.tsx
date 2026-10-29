"use client";

/**
 * Rider earnings dashboard — 1:1 port of mobile-rider/src/app/earnings/page.tsx.
 *
 * Five rolling windows from /api/rider/me/earnings:
 *   last_48h | week | month | year | lifetime
 *
 * Plus the current platform-fee due (mock-paid via the modal Pay button).
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, CalendarDays, CheckCircle2, Clock, CreditCard, Info,
  Loader2, TrendingUp, Truck, Wallet, X,
} from "lucide-react";
import { session } from "@/lib/api";
import { riderApi, type EarningsResponse } from "@/lib/rider";
import { MobileHeader } from "@/components/rider-app/mobile-header";

const WINDOW_LABELS: Record<keyof EarningsResponse["windows"], { title: string; sub: string; icon: typeof Clock }> = {
  last_48h: { title: "Last 48 hours", sub: "Rolling window for platform fee", icon: Clock },
  week:     { title: "Last 7 days",   sub: "Weekly performance",              icon: CalendarDays },
  month:    { title: "Last 30 days",  sub: "Monthly income",                  icon: TrendingUp },
  year:     { title: "Last 365 days", sub: "Yearly income",                   icon: TrendingUp },
  lifetime: { title: "All-time",      sub: "Lifetime earnings on MediDoor",   icon: Truck },
};

export function RiderEarningsScreen() {
  const router = useRouter();
  const [earn, setEarn] = useState<EarningsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [payOpen, setPayOpen] = useState(false);
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    if (session.role() !== "rider") { router.replace("/"); return; }
    riderApi.earnings()
      .then(setEarn)
      .catch((e) => setError(e instanceof Error ? e.message : "Load failed"))
      .finally(() => setLoading(false));
  }, [router]);

  const reload = useCallback(() => {
    riderApi.earnings().then(setEarn).catch((e) =>
      setError(e instanceof Error ? e.message : "Refresh failed"),
    );
  }, []);

  const onPay = async () => {
    if (!earn || earn.platform_fee_due <= 0) {
      setError("এখন কোনো fee due নেই।");
      setPayOpen(false);
      return;
    }
    setPaying(true);
    try {
      const r = await riderApi.payPlatformFee(earn.platform_fee_due);
      setOkMsg(`✅ ৳ ${r.amount.toFixed(2)} payment successful (mock).`);
      setPayOpen(false);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed");
    } finally { setPaying(false); }
  };

  const pct = earn ? Math.round(earn.platform_fee_pct * 100) : 9;
  const due = earn?.platform_fee_due ?? 0;

  return (
    <>
      <MobileHeader title="Earnings" subtitle="Rider income & platform fees" />

      <div
        className="space-y-4 px-4 pb-6"
        style={{ paddingTop: "calc(var(--header-h) + var(--safe-top) + 12px)" }}
      >
        {loading && (
          <div className="flex items-center justify-center gap-2 p-8 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        )}
        {error && (
          <p className="rounded-xl border border-rose-300/50 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/40 dark:bg-rose-950/40 dark:text-rose-200">
            {error}
          </p>
        )}
        {okMsg && (
          <p className="rounded-xl border border-emerald-300/50 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-200">
            {okMsg}
          </p>
        )}

        {/* Platform fee card */}
        {earn && (
          <div className={[
            "relative overflow-hidden rounded-3xl p-4 text-white shadow-lg",
            due > 0
              ? "bg-gradient-to-br from-rose-500 to-orange-500 shadow-rose-500/30"
              : "bg-gradient-to-br from-brand-500 to-emerald-600 shadow-brand-500/30",
          ].join(" ")}>
            <div className="flex items-start justify-between">
              <div>
                <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider opacity-90">
                  <Wallet size={12} /> Platform fee due
                </p>
                <p className="mt-1 text-3xl font-extrabold tabular-nums">৳ {due.toFixed(2)}</p>
                <p className="mt-1 text-[11px] opacity-90">
                  {pct}% of last 48h gross — {due > 0 ? "pay to keep going online" : "all clear"}
                </p>
              </div>
              {due > 0 ? (
                <AlertTriangle size={28} className="opacity-90" />
              ) : (
                <CheckCircle2 size={28} className="opacity-90" />
              )}
            </div>
            {due > 0 && (
              <button
                onClick={() => setPayOpen(true)}
                className="tap mt-3 inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-bold text-rose-600 shadow-sm"
              >
                <CreditCard size={13} /> Pay now
              </button>
            )}
          </div>
        )}

        {/* Windows */}
        {earn && (
          <div className="grid grid-cols-1 gap-3">
            {(Object.keys(WINDOW_LABELS) as Array<keyof EarningsResponse["windows"]>).map((k) => {
              const w = earn.windows[k];
              const meta = WINDOW_LABELS[k];
              const Icon = meta.icon;
              return (
                <div
                  key={k}
                  className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-white/10 dark:bg-white/[0.04]"
                >
                  <div className="flex items-center gap-2">
                    <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand-500/15 text-brand-600 dark:text-brand-300">
                      <Icon size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-bold">{meta.title}</p>
                      <p className="text-[10.5px] text-slate-500 dark:text-slate-400">{meta.sub}</p>
                    </div>
                    <p className="shrink-0 text-lg font-extrabold tabular-nums text-brand-600 dark:text-brand-300">
                      ৳ {w.earnings.toFixed(0)}
                    </p>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[10.5px] text-slate-500 dark:text-slate-400">
                    <span>🚲 {w.deliveries} deliveries</span>
                    <span>📅 {w.active_days} active days</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-start gap-2 rounded-2xl border border-slate-200/70 bg-slate-50/70 p-3 text-[11px] text-slate-600 dark:border-white/10 dark:bg-white/[0.02] dark:text-slate-300">
          <Info size={14} className="mt-0.5 shrink-0 text-slate-400" />
          <p>
            প্রতি 48 ঘণ্টায় total earnings থেকে {pct}% platform fee হিসেব করা হয়।
            Pay না করলে নতুন offer accept বন্ধ থাকতে পারে।
          </p>
        </div>
      </div>

      {/* Pay modal */}
      {payOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 px-4"
          onClick={() => setPayOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl dark:bg-[#0b1018]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-base font-bold">Pay platform fee</p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Mock payment — production-এ bKash/Nagad gateway connect হবে।
                </p>
              </div>
              <button
                onClick={() => setPayOpen(false)}
                className="tap grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mt-4 rounded-2xl bg-slate-50 p-3 dark:bg-white/[0.04]">
              <p className="text-[11px] uppercase tracking-wider text-slate-500">Amount</p>
              <p className="mt-1 text-3xl font-extrabold text-rose-600 dark:text-rose-300">
                ৳ {due.toFixed(2)}
              </p>
            </div>

            <button
              onClick={onPay}
              disabled={paying}
              className="tap mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-2xl bg-rose-500 py-3 text-sm font-bold text-white shadow-md shadow-rose-500/30 disabled:opacity-60"
            >
              {paying ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />}
              Confirm pay (mock)
            </button>
          </div>
        </div>
      )}
    </>
  );
}
