"use client";

/**
 * Pharmacy subscription screen — 1:1 port of
 * mobile-pharmacy/src/app/subscription/page.tsx (3-tier
 * upgrade/downgrade UI). Each tier is a full-width card the user can tap
 * "Switch to" to change subscription. The current tier is highlighted
 * with a brand-coloured ring + "Current" pill.
 *
 * Backed by `pharmacyApi.update({ subscription_tier })`. After update we
 * re-fetch /me so the badge in the header and home dashboard reflect the
 * new tier.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BadgeCheck, ClipboardList, Loader2, ShieldCheck, Sparkles, TrendingUp,
} from "lucide-react";
import { MobileHeader } from "@/components/pharmacy-app/mobile-header";
import { NotificationsBell } from "@/components/pharmacy-app/notifications-bell";
import { session } from "@/lib/api";
import {
  pharmacyApi, TIER_INFO, type PharmacyMe, type SubscriptionTier,
} from "@/lib/pharmacy";

const ORDER: SubscriptionTier[] = ["C", "B", "A"];

const TIER_ICON: Record<SubscriptionTier, typeof Sparkles> = {
  C: ShieldCheck,
  B: BadgeCheck,
  A: Sparkles,
};

export function PharmacySubscriptionScreen() {
  const router = useRouter();
  const [me, setMe] = useState<PharmacyMe | null>(null);
  const [busy, setBusy] = useState<SubscriptionTier | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    if (session.role() !== "pharmacy") { router.replace("/"); return; }
    pharmacyApi.me().then(setMe).catch((e) =>
      setError(e instanceof Error ? e.message : "Failed to load"),
    );
  }, [router]);

  const switchTo = async (tier: SubscriptionTier) => {
    if (!me || me.subscription_tier === tier || busy) return;
    setBusy(tier);
    setError(null);
    try {
      const updated = await pharmacyApi.update({ subscription_tier: tier });
      setMe(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Switch failed");
    } finally {
      setBusy(null);
    }
  };

  const current = me?.subscription_tier ?? "C";

  return (
    <>
      <MobileHeader title="Subscription" subtitle="Plan & visibility" back right={<NotificationsBell />} />

      <div className="space-y-4 px-4 pt-3">
        <div className="rounded-2xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-white/[0.04]">
          <p className="text-[11px] font-semibold uppercase tracking-wider opacity-60">
            Current plan
          </p>
          <h2 className="mt-1 text-lg font-bold">{TIER_INFO[current].label}</h2>
          <p className="mt-1 text-[12px] opacity-70">
            {TIER_INFO[current].blurb}
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-500/10 px-2 py-1 font-semibold text-brand-700 dark:text-brand-300">
              <TrendingUp size={12} /> {TIER_INFO[current].impressions}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 font-semibold text-amber-700 dark:text-amber-300">
              <ClipboardList size={12} /> {TIER_INFO[current].rx_offers}
            </span>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-rose-300/60 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200">
            {error}
          </div>
        )}

        <div className="space-y-3">
          {ORDER.map((tier) => {
            const info = TIER_INFO[tier];
            const Icon = TIER_ICON[tier];
            const isCurrent = current === tier;
            return (
              <div
                key={tier}
                className={[
                  "rounded-2xl border p-4 transition",
                  isCurrent
                    ? "border-brand-500/60 bg-brand-50/40 ring-2 ring-brand-500/40 dark:bg-brand-500/5"
                    : "border-black/10 bg-white dark:border-white/10 dark:bg-white/[0.04]",
                ].join(" ")}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold">{info.label}</h3>
                      {isCurrent && (
                        <span className="rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                          Current
                        </span>
                      )}
                    </div>
                    <span
                      className={`mt-1 inline-flex items-center gap-1 rounded-full bg-gradient-to-r px-2 py-1 text-[11px] font-semibold text-white ${info.color}`}
                    >
                      <Icon size={12} /> {info.badge}
                    </span>
                  </div>
                </div>

                <ul className="mt-3 space-y-1 text-[12px] opacity-80">
                  <li>📊 {info.impressions}</li>
                  <li>📋 {info.rx_offers}</li>
                  <li>{info.blurb}</li>
                </ul>

                <button
                  onClick={() => switchTo(tier)}
                  disabled={isCurrent || busy !== null}
                  className={[
                    "tap mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-semibold transition",
                    isCurrent
                      ? "cursor-default bg-slate-200 text-slate-500 dark:bg-white/10 dark:text-slate-300"
                      : "bg-brand-500 text-white shadow hover:bg-brand-600 disabled:opacity-60",
                  ].join(" ")}
                >
                  {busy === tier && <Loader2 size={14} className="animate-spin" />}
                  {isCurrent ? "Active" : busy === tier ? "Switching…" : `Switch to ${info.label}`}
                </button>
              </div>
            );
          })}
        </div>

        <p className="pb-6 pt-2 text-center text-[11px] opacity-60">
          এই demo build-এ subscription instantly switch হয়। Production launch-এ payment gateway যোগ হবে।
        </p>
      </div>
    </>
  );
}
