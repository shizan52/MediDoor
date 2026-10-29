"use client";

/**
 * Pharmacy Home / Dashboard — 1:1 port of mobile-pharmacy/src/app/page.tsx
 * (routes remapped under /pharmacy). Shows at-a-glance status (verification,
 * publish toggle, open-now, subscription tier), today's quick stats, and
 * quick links to the rest of the app. Heavy editing flows (banner crop,
 * license upload, hours editor, map) live on /pharmacy/profile so this
 * screen stays scrollable on a 390px phone.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  AlertTriangle, BadgeCheck, Building2, ChevronRight, ClipboardList,
  Clock, Loader2, MessageCircle, Package, Pill, Power,
  Sparkles, Store, TrendingUp, X,
} from "lucide-react";
import { MobileHeader } from "@/components/pharmacy-app/mobile-header";
import { BrandLogo } from "@/components/pharmacy-app/brand-logo";
import { NotificationsBell } from "@/components/pharmacy-app/notifications-bell";
import { ThemeToggle } from "@/components/pharmacy-app/theme-toggle";
import { PharmacyVerificationGate } from "@/components/pharmacy-verification-gate";
import { resolveMediaUrl, session } from "@/lib/api";
import {
  pharmacyApi,
  TIER_INFO,
  type AiNotification,
  type PharmacyAnalytics,
  type PharmacyMe,
} from "@/lib/pharmacy";

export function PharmacyHomeScreen() {
  const router = useRouter();
  const [me, setMe] = useState<PharmacyMe | null>(null);
  const [stats, setStats] = useState<PharmacyAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([
        pharmacyApi.me(),
        pharmacyApi.analytics().catch(() => null),
      ]);
      setMe(m);
      if (s) setStats(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    if (session.role() !== "pharmacy") { router.replace("/"); return; }
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh, router]);

  const togglePublish = async () => {
    if (!me) return;
    if (me.verification.status !== "verified") {
      setError("DGDA verification সম্পূর্ণ না হলে shop publish করা যাবে না।");
      return;
    }
    if (!me.is_published && !me.banner_photo_url) {
      setError("Banner image upload করুন আগে — Profile → Banner থেকে।");
      return;
    }
    setBusy(true);
    try {
      const updated = await pharmacyApi.update({ is_published: !me.is_published });
      setMe(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleOpenToday = async () => {
    if (!me) return;
    setBusy(true);
    try {
      const updated = me.closed_until
        ? await pharmacyApi.openNow()
        : await pharmacyApi.closeToday();
      setMe(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <MobileHeader
        title={<BrandLogo className="h-7 w-auto" />}
        subtitle={
          me
            ? `${me.pharmacy_name} · ${me.is_published ? "Shop is open" : "Shop is closed"}`
            : "Pharmacy · Loading…"
        }
        right={
          <>
            <NotificationsBell />
            <ThemeToggle />
          </>
        }
      />

      {/* DGDA verification gate — full-screen blocker until verified. */}
      {me && me.verification.status !== "verified" && (
        <PharmacyVerificationGate me={me} onVerified={(m) => setMe(m)} />
      )}

      <div className="px-4 pt-3">
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-2xl border border-rose-300/60 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <p className="flex-1">{error}</p>
            <button onClick={() => setError(null)}><X size={12} /></button>
          </div>
        )}

        {!me && !error && (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading dashboard…
          </div>
        )}

        {me && (
          <>
            {/* Banner + identity */}
            <BannerHero me={me} />

            {/* Verification status — most important block at top */}
            <VerificationStatus me={me} onResubmitNeeded={() => router.push("/pharmacy/profile")} onRetry={async () => {
              setBusy(true);
              try {
                const updated = await pharmacyApi.retryVerification();
                setMe(updated);
              } catch (e) { setError(e instanceof Error ? e.message : "Retry failed"); }
              finally { setBusy(false); }
            }} />

            {/* Two big toggles — Publish + Open today */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <ToggleCard
                active={me.is_published}
                disabled={busy}
                onClick={togglePublish}
                icon={Power}
                title={me.is_published ? "Shop open" : "Shop closed"}
                subtitle={me.is_published ? "Customer-রা দেখছে" : "Hidden from customers"}
                activeClass="bg-brand-500 text-white"
              />
              <ToggleCard
                active={!me.closed_until}
                disabled={busy}
                onClick={toggleOpenToday}
                icon={Clock}
                title={me.closed_until ? "Closed today" : "Open today"}
                subtitle={me.closed_until ? "Tap to re-open now" : "Tap to close till midnight"}
                activeClass="bg-emerald-500 text-white"
              />
            </div>

            {/* Quick stats */}
            <QuickStats stats={stats} />

            {/* Tier card */}
            <TierCard me={me} />

            {/* Quick links */}
            <QuickLinks me={me} />

            {/* MediAI inbox card */}
            <NotificationsInline />
          </>
        )}
      </div>
    </>
  );
}

/* -------------------------- Banner hero -------------------------- */

function BannerHero({ me }: { me: PharmacyMe }) {
  const banner = resolveMediaUrl(me.banner_photo_url);
  return (
    <div className="relative mb-3 overflow-hidden rounded-3xl border border-slate-200/60 dark:border-white/10">
      <div className="relative h-32 w-full bg-gradient-to-br from-brand-400/40 to-emerald-500/20">
        {banner && <Image src={banner} alt="Banner" fill sizes="480px" className="object-cover" unoptimized />}
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-end gap-2 bg-gradient-to-t from-black/65 via-black/30 to-transparent p-3 text-white">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/15 backdrop-blur">
          <Store size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{me.pharmacy_name}</p>
          <p className="truncate text-[10.5px] opacity-80">
            {me.address || "Address set করতে → Profile"}
          </p>
        </div>
        {me.is_verified && (
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/90 px-2 py-0.5 text-[10px] font-semibold">
            <BadgeCheck size={12} /> Verified
          </span>
        )}
      </div>
    </div>
  );
}

/* -------------------------- Verification block -------------------------- */

function VerificationStatus({ me, onResubmitNeeded, onRetry }: {
  me: PharmacyMe;
  onResubmitNeeded: () => void;
  onRetry: () => void;
}) {
  const v = me.verification;
  const palette: Record<string, { ring: string; bg: string; fg: string; icon: any; title: string }> = {
    verified:  { ring: "border-emerald-300", bg: "bg-emerald-50 dark:bg-emerald-950/30", fg: "text-emerald-700 dark:text-emerald-300", icon: BadgeCheck, title: "DGDA verified" },
    pending:   { ring: "border-amber-300",   bg: "bg-amber-50 dark:bg-amber-950/30",     fg: "text-amber-700 dark:text-amber-300",     icon: Loader2,    title: "Verification চলছে…" },
    mismatch:  { ring: "border-rose-300",    bg: "bg-rose-50 dark:bg-rose-950/30",       fg: "text-rose-700 dark:text-rose-300",       icon: AlertTriangle, title: "তথ্য mismatch" },
    not_found: { ring: "border-rose-300",    bg: "bg-rose-50 dark:bg-rose-950/30",       fg: "text-rose-700 dark:text-rose-300",       icon: AlertTriangle, title: "DGDA-তে পাওয়া যায়নি" },
    expired:   { ring: "border-amber-400",   bg: "bg-amber-50 dark:bg-amber-950/30",     fg: "text-amber-800 dark:text-amber-200",     icon: AlertTriangle, title: "License expired" },
    error:     { ring: "border-slate-300",   bg: "bg-slate-50 dark:bg-white/5",          fg: "text-slate-700 dark:text-slate-200",     icon: AlertTriangle, title: "Verification error" },
  };
  const p = palette[v.status] ?? palette.error;
  const Icon = p.icon;
  return (
    <div className={`mt-1 rounded-2xl border ${p.ring} ${p.bg} p-3`}>
      <div className="flex items-start gap-2">
        <Icon size={16} className={`${p.fg} mt-0.5 shrink-0 ${v.status === "pending" ? "animate-spin" : ""}`} />
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${p.fg}`}>{p.title}</p>
          {v.message && <p className="mt-0.5 text-[11px] opacity-80">{v.message}</p>}
          {v.mismatch_fields.length > 0 && (
            <p className="mt-1 text-[10.5px] opacity-70">
              ভুল field: {v.mismatch_fields.join(", ")}
            </p>
          )}
        </div>
      </div>
      {v.status !== "verified" && v.status !== "pending" && (
        <div className="mt-3 flex gap-2">
          {(v.status === "mismatch" || v.status === "not_found") && (
            <button onClick={onResubmitNeeded} className="tap flex-1 rounded-full bg-rose-500 py-2 text-[11px] font-semibold text-white">
              তথ্য সংশোধন করুন
            </button>
          )}
          {(v.status === "expired" || v.status === "error") && (
            <button onClick={onRetry} className="tap flex-1 rounded-full bg-slate-900 py-2 text-[11px] font-semibold text-white dark:bg-white dark:text-slate-900">
              আবার যাচাই করুন
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------- Toggle card -------------------------- */

function ToggleCard({ active, disabled, onClick, icon: Icon, title, subtitle, activeClass }: {
  active: boolean; disabled?: boolean; onClick: () => void;
  icon: any; title: string; subtitle: string; activeClass: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        "tap flex flex-col items-start gap-1 rounded-2xl border p-3 text-left transition disabled:opacity-60",
        active
          ? `${activeClass} border-transparent shadow-md`
          : "border-slate-200 bg-white text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100",
      ].join(" ")}
    >
      <Icon size={16} />
      <p className="text-xs font-semibold">{title}</p>
      <p className={`text-[10px] leading-tight ${active ? "opacity-90" : "opacity-60"}`}>{subtitle}</p>
    </button>
  );
}

/* -------------------------- Quick stats -------------------------- */

function QuickStats({ stats }: { stats: PharmacyAnalytics | null }) {
  return (
    <div className="mt-3 grid grid-cols-3 gap-2">
      <StatTile label="Pending" value={stats?.pending_count ?? 0} icon={ClipboardList} tint="amber" />
      <StatTile label="Delivered" value={stats?.delivered_count ?? 0} icon={Package} tint="emerald" />
      <StatTile label="This month" value={`৳${(stats?.this_month_revenue ?? 0).toFixed(0)}`} icon={TrendingUp} tint="brand" />
    </div>
  );
}

function StatTile({ label, value, icon: Icon, tint }: {
  label: string; value: number | string; icon: any; tint: "amber" | "emerald" | "brand";
}) {
  const ringColors: Record<string, string> = {
    amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    emerald: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    brand: "bg-brand-500/15 text-brand-700 dark:text-brand-300",
  };
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white p-2.5 dark:border-white/10 dark:bg-white/[0.04]">
      <div className={`mb-1 grid h-7 w-7 place-items-center rounded-lg ${ringColors[tint]}`}>
        <Icon size={14} />
      </div>
      <p className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-0.5 text-base font-bold leading-tight">{value}</p>
    </div>
  );
}

/* -------------------------- Tier card -------------------------- */

function TierCard({ me }: { me: PharmacyMe }) {
  const t = TIER_INFO[me.subscription_tier];
  return (
    <Link
      href="/pharmacy/subscription"
      className="tap mt-3 block overflow-hidden rounded-2xl border border-slate-200/70 bg-white active:bg-slate-50 dark:border-white/10 dark:bg-white/[0.04] dark:active:bg-white/[0.07]"
    >
      <div className={`flex items-center justify-between bg-gradient-to-r ${t.color} px-3 py-2 text-white`}>
        <div>
          <p className="text-[10px] uppercase tracking-wider opacity-80">Subscription</p>
          <p className="text-sm font-bold">{t.label}</p>
        </div>
        <ChevronRight size={16} className="opacity-80" />
      </div>
      <div className="space-y-1 p-3 text-[11px]">
        <p className="opacity-80">{t.blurb}</p>
        <p>· {t.impressions}</p>
        <p>· {t.rx_offers}</p>
        <p className="pt-1 text-[10px] font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-300">
          Tap to upgrade / downgrade →
        </p>
      </div>
    </Link>
  );
}

/* -------------------------- Quick links -------------------------- */

function QuickLinks({ me }: { me: PharmacyMe }) {
  const items = [
    { href: "/pharmacy/orders", icon: ClipboardList, label: "Manage orders", body: "Confirm, dispatch, mark delivered" },
    { href: "/pharmacy/medicines", icon: Pill, label: "Medicines", body: "Add new, edit price & stock" },
    { href: "/pharmacy/chats", icon: MessageCircle, label: "Customer chats", body: "Reply, share quote, share invoice" },
    { href: "/pharmacy/subscription", icon: TrendingUp, label: "Subscription plan", body: `${TIER_INFO[me.subscription_tier].label} · upgrade / downgrade` },
    { href: "/pharmacy/profile", icon: Building2, label: "Pharmacy profile", body: "Banner, hours, license, map" },
  ];
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200/70 bg-white dark:border-white/10 dark:bg-white/[0.04]">
      {items.map((it, i) => {
        const Icon = it.icon;
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`tap flex items-center gap-3 p-3 active:bg-slate-100 dark:active:bg-white/5 ${i ? "border-t border-slate-100 dark:border-white/5" : ""}`}
          >
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-300">
              <Icon size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{it.label}</p>
              <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">{it.body}</p>
            </div>
            <ChevronRight size={14} className="text-slate-400" />
          </Link>
        );
      })}
    </div>
  );
}

/* -------------------------- Notifications inline -------------------------- */

function NotificationsInline() {
  const [items, setItems] = useState<AiNotification[]>([]);
  const [unread, setUnread] = useState(0);

  const reload = useCallback(async () => {
    try {
      const r = await pharmacyApi.listNotifications();
      setItems(r.items.slice(0, 3));
      setUnread(r.unread);
    } catch { /* offline */ }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  if (items.length === 0) return null;
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200/70 bg-white dark:border-white/10 dark:bg-white/[0.04]">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-white/5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles size={14} className="text-brand-500" /> MediAI advice
        </div>
        {unread > 0 && (
          <span className="rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-semibold text-white">
            {unread} new
          </span>
        )}
      </div>
      {items.map((n) => (
        <div key={n.id} className="border-t border-slate-100 px-3 py-2 first:border-t-0 dark:border-white/5">
          <p className="text-[12px] font-semibold">{n.title}</p>
          <p className="mt-0.5 line-clamp-2 text-[11px] opacity-75">{n.body_bn}</p>
        </div>
      ))}
    </div>
  );
}
