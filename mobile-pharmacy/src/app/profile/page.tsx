"use client";

/**
 * Pharmacy profile + analytics + opening hours + verification details.
 * Tabs: profile, hours, analytics, inbox.
 *
 * Heavy editing (banner upload + map pin + license doc) lives on
 * /profile/edit so this screen stays a quick read-only summary.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle, BadgeCheck, Bell, Building2, Camera, ChevronRight, Clock,
  Edit3, LogOut, Loader2, MapPin, MessageCircle, Paperclip, Phone, Power,
  Send, Sparkles, Star, Store, TrendingUp, X,
} from "lucide-react";
import { BannerCropModal } from "@/components/banner-crop-modal";
import { MobileHeader } from "@/components/mobile-header";
import { NotificationsBell } from "@/components/notifications-bell";
import { PharmacyMapCard } from "@/components/pharmacy-map-card";
import { ThemeToggle } from "@/components/theme-toggle";
import { api, resolveMediaUrl, session, uploadAttachment } from "@/lib/api";
import {
  DAYS, pharmacyApi, TIER_INFO,
  type AiNotification, type DayKey, type OpeningHourEntry,
  type PharmacyAdminMessage, type PharmacyAnalytics, type PharmacyMe,
} from "@/lib/pharmacy";

type Tab = "profile" | "hours" | "analytics" | "inbox";

export default function PharmacyProfilePage() {
  return (
    <Suspense fallback={null}>
      <PharmacyProfileScreen />
    </Suspense>
  );
}

function PharmacyProfileScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const initial = (params?.get("tab") as Tab) || "profile";
  const [tab, setTab] = useState<Tab>(initial);

  const [me, setMe] = useState<PharmacyMe | null>(null);
  const [stats, setStats] = useState<PharmacyAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([
        pharmacyApi.me(),
        pharmacyApi.analytics().catch(() => null),
      ]);
      setMe(m);
      if (s) setStats(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    if (session.role() !== "pharmacy") { router.replace("/login?msg=wrong-role"); return; }
    refresh();
  }, [refresh, router]);

  const onLogout = async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    session.clear();
    router.replace("/login");
  };

  return (
    <>
      <MobileHeader
        title="Profile"
        subtitle={me?.pharmacy_name}
        right={
          <>
            <NotificationsBell />
            <ThemeToggle />
          </>
        }
      />

      <div className="px-4 pt-3">
        {/* Tabs */}
        <div className="flex gap-1 overflow-x-auto rounded-full bg-slate-100 p-1 dark:bg-white/5">
          {([
            ["profile", "Profile"],
            ["hours", "Hours"],
            ["analytics", "Analytics"],
            ["inbox", "Inbox"],
          ] as [Tab, string][]).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={[
                "tap flex-1 rounded-full py-2 text-[11px] font-semibold transition",
                tab === k
                  ? "bg-white text-slate-900 shadow dark:bg-slate-900 dark:text-white"
                  : "text-slate-500 dark:text-slate-300",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-2xl border border-rose-300/60 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <p className="flex-1">{error}</p>
            <button onClick={() => setError(null)}><X size={12} /></button>
          </div>
        )}

        {me?.is_blocked && (
          <div className="mt-3 flex items-start gap-2 rounded-2xl border border-rose-300/70 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-100">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-bold">Pharmacy account restricted</p>
              <p className="mt-1 leading-relaxed">{me.block_notice || "MediDoor Admin আপনার pharmacy account সাময়িকভাবে restricted করেছে। Inbox থেকে admin-এর সাথে কথা বলুন।"}</p>
            </div>
          </div>
        )}

        {!me && !error && (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        )}

        {me && (
          <div className="mt-3 space-y-3">
            {tab === "profile" && <ProfileTab me={me} stats={stats} onLogout={onLogout} setMe={setMe} setError={setError} />}
            {tab === "hours" && <HoursTab me={me} setMe={setMe} setError={setError} />}
            {tab === "analytics" && <AnalyticsTab stats={stats} />}
            {tab === "inbox" && <InboxTab me={me} />}
          </div>
        )}
      </div>
    </>
  );
}

/* ---------------- Profile tab ---------------- */

function ProfileTab({ me, stats, onLogout, setMe, setError }: {
  me: PharmacyMe; stats: PharmacyAnalytics | null; onLogout: () => void;
  setMe: (m: PharmacyMe) => void; setError: (s: string | null) => void;
}) {
  const banner = resolveMediaUrl(me.banner_photo_url);
  const bannerFileRef = useRef<HTMLInputElement>(null);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [bannerBusy, setBannerBusy] = useState(false);
  const [bannerSaved, setBannerSaved] = useState(false);

  // Crop modal returns a freshly-uploaded URL; persist it immediately so the
  // pharmacist never has to hunt for a second "Save" (same as /profile/edit).
  const onBannerUploaded = async (url: string) => {
    setBannerBusy(true);
    setError(null);
    try {
      const updated = await pharmacyApi.update({ banner_photo_url: url });
      setMe(updated);
      setBannerSaved(true);
      window.setTimeout(() => setBannerSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Banner save failed");
    } finally {
      setBannerBusy(false);
    }
  };

  return (
    <>
      <div className="overflow-hidden rounded-3xl border border-slate-200/70 dark:border-white/10">
        <div className="relative h-32 w-full bg-gradient-to-br from-brand-400/40 to-emerald-500/20">
          {banner && <Image src={banner} alt="" fill sizes="480px" className="object-cover" />}
          <input
            ref={bannerFileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setBannerFile(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => bannerFileRef.current?.click()}
            disabled={bannerBusy}
            className={[
              "tap absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold text-white backdrop-blur",
              banner ? "bg-black/55" : "bg-amber-500/90 ring-2 ring-amber-300/70",
            ].join(" ")}
          >
            {bannerBusy ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
            {bannerBusy ? "Saving…" : banner ? "Change banner" : "Banner দিন"}
          </button>
        </div>
        {bannerSaved && (
          <div className="border-t border-brand-300/40 bg-brand-50 px-3 py-1.5 text-[11px] font-semibold text-brand-700 dark:border-brand-500/30 dark:bg-brand-950/30 dark:text-brand-200">
            ✓ Banner updated.
          </div>
        )}
        <div className="space-y-2 bg-white p-3 dark:bg-white/[0.04]">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-base font-bold">{me.pharmacy_name}</p>
              <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                Owner: {me.owner_name}
              </p>
            </div>
            {me.is_verified && (
              <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                <BadgeCheck size={11} /> Verified
              </span>
            )}
          </div>
          {me.rating_count > 0 && (
            <p className="flex items-center gap-1 text-[11px] text-amber-500">
              <Star size={11} fill="currentColor" /> {me.rating.toFixed(1)} ({me.rating_count})
            </p>
          )}
          {me.address && (
            <p className="flex items-start gap-1 text-[11.5px] text-slate-600 dark:text-slate-300">
              <MapPin size={12} className="mt-0.5 shrink-0" /> {me.address}
            </p>
          )}
          {me.phone_number && (
            <a href={`tel:${me.phone_number}`} className="inline-flex items-center gap-1 text-[12px] font-semibold text-brand-600 dark:text-brand-300">
              <Phone size={12} /> {me.phone_number}
            </a>
          )}
          {me.description && (
            <p className="text-[12px] leading-relaxed opacity-80">{me.description}</p>
          )}
        </div>
      </div>

      {/* License + tier */}
      <div className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white dark:border-white/10 dark:bg-white/[0.04]">
        <Row icon={Store} label="License No." value={me.pharmacy_license_no} />
        {me.pharmacist_name && <Row icon={Building2} label="Pharmacist" value={`${me.pharmacist_name}${me.pharmacist_reg_no ? ` (${me.pharmacist_reg_no})` : ""}`} />}
        <Link
          href="/subscription"
          className="tap flex items-center gap-3 border-t border-slate-100 p-3 active:bg-slate-50 dark:border-white/5 dark:active:bg-white/5"
        >
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-300">
            <TrendingUp size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider opacity-60">Subscription</p>
            <p className="text-sm font-semibold">{TIER_INFO[me.subscription_tier].label}</p>
          </div>
          <span className="text-[11px] font-semibold text-brand-600 dark:text-brand-300">Manage →</span>
        </Link>
        <Row icon={Clock} label="Open right now" value={me.is_open_now ? "Yes" : "No"} />
      </div>

      {stats && (
        <div className="grid grid-cols-3 gap-2">
          <Tile label="Lifetime" value={`৳${stats.lifetime_revenue.toFixed(0)}`} />
          <Tile label="Inventory" value={`${stats.inventory_active} / ${stats.inventory_total}`} />
          <Tile label="Delivered" value={String(stats.delivered_count)} />
        </div>
      )}

      {/* Map preview — pharmacy pin + delivery radius */}
      <PharmacyMapCard
        lat={me.lat}
        lng={me.lng}
        pharmacyName={me.pharmacy_name}
        radiusKm={3}
      />

      <Link
        href="/profile/edit"
        className="tap flex w-full items-center justify-center gap-2 rounded-full bg-slate-900 py-3 text-sm font-semibold text-white dark:bg-white dark:text-slate-900"
      >
        <Edit3 size={14} /> Edit pharmacy details
      </Link>

      <button
        onClick={onLogout}
        className="tap flex w-full items-center justify-center gap-1.5 rounded-full border border-rose-300 py-2.5 text-xs font-semibold text-rose-600 dark:border-rose-500/40 dark:text-rose-300"
      >
        <LogOut size={12} /> Logout
      </button>

      {bannerFile && (
        <BannerCropModal
          file={bannerFile}
          onClose={() => setBannerFile(null)}
          onUploaded={onBannerUploaded}
        />
      )}
    </>
  );
}

function Row({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 border-t border-slate-100 p-3 first:border-t-0 dark:border-white/5">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
        <Icon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
        <p className="truncate text-[13px] font-semibold">{value}</p>
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white p-2.5 dark:border-white/10 dark:bg-white/[0.04]">
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-0.5 text-sm font-bold leading-tight">{value}</p>
    </div>
  );
}

/* ---------------- Hours tab ---------------- */

function HoursTab({ me, setMe, setError }: {
  me: PharmacyMe;
  setMe: (m: PharmacyMe) => void;
  setError: (s: string | null) => void;
}) {
  const [draft, setDraft] = useState(me.opening_hours);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const u = await pharmacyApi.update({ opening_hours: draft });
      setMe(u);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); }
    finally { setBusy(false); }
  };

  const update = (k: DayKey, p: Partial<OpeningHourEntry>) => {
    setDraft((d) => ({ ...d, [k]: { ...d[k], ...p } }));
  };

  const setAll24h = () => {
    const next: typeof draft = { ...draft };
    for (const { key } of DAYS) {
      next[key] = { open: "00:00", close: "23:59", closed: false };
    }
    setDraft(next);
  };
  const setAllStandard = () => {
    const next: typeof draft = { ...draft };
    for (const { key } of DAYS) {
      next[key] = { open: "09:00", close: "22:00", closed: false };
    }
    setDraft(next);
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={setAll24h}
          className="tap rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-[11px] font-semibold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
        >
          24h · সারাদিন খোলা
        </button>
        <button
          type="button"
          onClick={setAllStandard}
          className="tap rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
        >
          ৯টা–১০টা (default)
        </button>
      </div>
      <div className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white dark:border-white/10 dark:bg-white/[0.04]">
        {DAYS.map(({ key, label }, i) => {
          const e = draft[key];
          return (
            <div key={key} className={`p-3 ${i ? "border-t border-slate-100 dark:border-white/5" : ""}`}>
              <div className="flex items-center justify-between">
                <p className="text-[12.5px] font-semibold">{label}</p>
                <button
                  onClick={() => update(key, { closed: !e.closed })}
                  className={[
                    "tap rounded-full px-3 py-1 text-[10px] font-semibold",
                    e.closed
                      ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                      : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                  ].join(" ")}
                >
                  {e.closed ? "Closed" : "Open"}
                </button>
              </div>
              {!e.closed && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <input type="time" value={e.open} onChange={(ev) => update(key, { open: ev.target.value })} className="rounded-lg border border-slate-200 bg-white p-1.5 text-sm dark:border-white/10 dark:bg-white/5" />
                  <input type="time" value={e.close} onChange={(ev) => update(key, { close: ev.target.value })} className="rounded-lg border border-slate-200 bg-white p-1.5 text-sm dark:border-white/10 dark:bg-white/5" />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button
        disabled={busy}
        onClick={save}
        className="tap flex w-full items-center justify-center gap-2 rounded-full bg-brand-500 py-3 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy && <Loader2 size={14} className="animate-spin" />}
        Save hours
      </button>
    </>
  );
}

/* ---------------- Analytics tab ---------------- */

function AnalyticsTab({ stats }: { stats: PharmacyAnalytics | null }) {
  if (!stats) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
        <Loader2 size={14} className="animate-spin" /> Loading analytics…
      </div>
    );
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Tile label="Lifetime revenue" value={`৳${stats.lifetime_revenue.toFixed(0)}`} />
        <Tile label="This month" value={`৳${stats.this_month_revenue.toFixed(0)}`} />
        <Tile label="Delivered" value={String(stats.delivered_count)} />
        <Tile label="Pending" value={String(stats.pending_count)} />
        <Tile label="Rejected" value={String(stats.rejected_count)} />
        <Tile label="Cancelled" value={String(stats.cancelled_count)} />
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white dark:border-white/10 dark:bg-white/[0.04]">
        <p className="border-b border-slate-100 px-3 py-2 text-sm font-semibold dark:border-white/5">Top selling</p>
        {stats.top_products.length === 0 && (
          <p className="px-3 py-4 text-center text-xs text-slate-400">No sales yet.</p>
        )}
        {stats.top_products.map((p, i) => (
          <div key={i} className="flex items-center justify-between border-t border-slate-100 px-3 py-2 first:border-t-0 dark:border-white/5">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{p.name}</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{p.qty} sold</p>
            </div>
            <p className="text-sm font-semibold">৳{p.revenue.toFixed(0)}</p>
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------------- Inbox tab ---------------- */

function InboxTab({ me }: { me: PharmacyMe | null }) {
  const [items, setItems] = useState<AiNotification[] | null>(null);
  const [thread, setThread] = useState<PharmacyAdminMessage[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [adminText, setAdminText] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      const [r, support] = await Promise.all([
        pharmacyApi.listNotifications(),
        pharmacyApi.adminThread(),
      ]);
      setItems(r.items);
      setUnread(r.unread);
      setThread(support.items || []);
      setAdminError(null);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const markRead = async (id: string) => {
    setItems((xs) => xs?.map((x) => x.id === id ? { ...x, is_read: true } : x) ?? null);
    setUnread((u) => Math.max(0, u - 1));
    try { await pharmacyApi.markNotificationRead(id); } catch {}
  };

  const markAll = async () => {
    setItems((xs) => xs?.map((x) => ({ ...x, is_read: true })) ?? null);
    setUnread(0);
    try { await pharmacyApi.markAllNotificationsRead(); } catch {}
  };

  const sendAdmin = async (attachment?: { url: string; mime: string | null }, force = false) => {
    const body = adminText.trim();
    if ((!body && !attachment?.url) || (adminBusy && !force)) return;
    setAdminBusy(true);
    setAdminError(null);
    try {
      const msg = await pharmacyApi.sendAdminMessage({
        body,
        attachment_url: attachment?.url || null,
        attachment_mime: attachment?.mime || null,
      });
      setThread((prev) => [...(prev || []), msg]);
      setAdminText("");
    } catch (e) {
      setAdminError(e instanceof Error ? e.message : "Message send failed");
    } finally {
      setAdminBusy(false);
    }
  };

  const onAttach = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
      setAdminError("Only image or PDF attachments are supported.");
      return;
    }
    setAdminBusy(true);
    setAdminError(null);
    try {
      const uploaded = await uploadAttachment(file);
      await sendAdmin(uploaded, true);
    } catch (e) {
      setAdminError(e instanceof Error ? e.message : "Attachment upload failed");
      setAdminBusy(false);
    }
  };

  if (!items) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <>
      <div className="mb-4 overflow-hidden rounded-2xl border border-slate-200/70 bg-white dark:border-white/10 dark:bg-white/[0.04]">
        <div className="flex items-start gap-3 border-b border-slate-100 p-3 dark:border-white/5">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-300">
            <MessageCircle size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">MediDoor Admin</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {me?.is_blocked ? "Account restriction support" : "Pharmacy support"}
            </p>
          </div>
          {me?.is_blocked && (
            <span className="rounded-full bg-rose-100 px-2 py-1 text-[10px] font-bold text-rose-700 dark:bg-rose-500/15 dark:text-rose-200">
              BLOCKED
            </span>
          )}
        </div>

        {me?.is_blocked && (
          <div className="border-b border-rose-100 bg-rose-50 px-3 py-2 text-[11px] leading-relaxed text-rose-800 dark:border-rose-500/20 dark:bg-rose-950/30 dark:text-rose-100">
            {me.block_notice || "আপনার pharmacy account restricted আছে। Admin-এর সাথে এখানেই কথা বলুন।"}
          </div>
        )}

        <div className="max-h-[320px] space-y-2 overflow-y-auto bg-slate-50/70 p-3 dark:bg-black/10">
          {thread === null ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-400">
              <Loader2 size={14} className="animate-spin" /> Loading support…
            </div>
          ) : thread.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-500 dark:text-slate-400">
              Admin message এখানেই আসবে।
            </div>
          ) : (
            thread.map((m) => {
              const mine = m.direction === "pharmacy_to_admin";
              return (
                <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[82%] rounded-2xl px-3 py-2 text-xs shadow-sm ${mine ? "bg-brand-500 text-white" : "bg-white text-slate-800 dark:bg-slate-900 dark:text-slate-100"}`}>
                    <p className="mb-1 text-[10px] font-bold opacity-70">{mine ? "You" : "MediDoor Admin"}</p>
                    {m.body && <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>}
                    <AdminAttachment url={m.attachment_url} mime={m.attachment_mime} mine={mine} />
                    <p className="mt-1 text-[9px] opacity-60">{(m.created_at || "").slice(0, 16).replace("T", " ")}</p>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {adminError && <p className="border-t border-rose-100 px-3 py-2 text-[11px] text-rose-600 dark:border-rose-500/20 dark:text-rose-300">{adminError}</p>}
        <div className="flex items-end gap-2 border-t border-slate-100 p-3 dark:border-white/5">
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              void onAttach(file);
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={adminBusy}
            className="tap grid h-10 w-10 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-700 disabled:opacity-50 dark:bg-white/10 dark:text-slate-100"
            aria-label="Attach file"
          >
            <Paperclip size={16} />
          </button>
          <textarea
            value={adminText}
            onChange={(e) => setAdminText(e.target.value)}
            rows={2}
            placeholder="MediDoor Admin-কে message লিখুন…"
            className="min-h-[40px] flex-1 resize-none rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-brand-400 dark:border-white/10 dark:bg-slate-950"
          />
          <button
            type="button"
            onClick={() => void sendAdmin()}
            disabled={adminBusy || !adminText.trim()}
            className="tap grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-500 text-white disabled:opacity-50"
            aria-label="Send message"
          >
            {adminBusy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>

      {unread > 0 && (
        <button onClick={markAll} className="tap mb-2 self-end rounded-full bg-brand-500/10 px-3 py-1 text-[11px] font-semibold text-brand-700 dark:text-brand-300">
          Mark all read ({unread})
        </button>
      )}
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-8 text-center text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.02]">
          <Bell size={22} className="opacity-50" />
          <p>কোনো notification নেই।</p>
        </div>
      ) : (
      <div className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white dark:border-white/10 dark:bg-white/[0.04]">
        {items.map((n, i) => (
          <button
            key={n.id}
            onClick={() => !n.is_read && markRead(n.id)}
            className={[
              "block w-full p-3 text-left",
              i ? "border-t border-slate-100 dark:border-white/5" : "",
              n.is_read ? "" : "bg-brand-50/40 dark:bg-brand-500/5",
            ].join(" ")}
          >
            <div className="flex items-start gap-2">
              <Sparkles size={14} className="mt-0.5 text-brand-500" />
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${n.is_read ? "font-semibold" : "font-bold"}`}>{n.title}</p>
                <p className="mt-0.5 text-[11px] opacity-75">{n.body_bn}</p>
              </div>
              {!n.is_read && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />}
            </div>
          </button>
        ))}
      </div>
      )}
    </>
  );
}

function AdminAttachment({ url, mime, mine }: { url?: string | null; mime?: string | null; mine: boolean }) {
  if (!url) return null;
  const href = resolveMediaUrl(url);
  const isPdf = (mime || "").startsWith("application/pdf") || url.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${mine ? "bg-white/20 text-white" : "bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-slate-100"}`}
      >
        <Paperclip size={12} /> PDF attachment
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="mt-2 block overflow-hidden rounded-xl">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={href} alt="Attachment" className="max-h-44 w-full object-cover" />
    </a>
  );
}
