"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import Image from "next/image";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle, BadgeCheck, Bell, Building2, CheckCircle2, ClipboardList, Edit3, Eye,
  Home, ImageIcon, Info, Lightbulb, Loader2, LogOut, MapPin, MessageCircle, Package, Plus,
  Power, Save, Settings, Store, Trash2, User, X,
} from "lucide-react";
import { api, session, uploadImage } from "@/lib/api";
import { reverseGeocode } from "@/lib/storefront";
import { fetchSiteContent, type SiteContent } from "@/lib/site";
import {
  DAYS, TIER_INFO, pharmacyApi,
  type DayKey, type MedicineInput, type OpeningHourEntry,
  type PharmacyAnalytics, type PharmacyMe, type PharmacyMedicine,
  type AiNotification,
} from "@/lib/pharmacy";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { HeaderMenu, HeaderMenuItem, ThemeMenuItem, MobileTabBar } from "@/components/mobile-nav";
import { MessengerDock } from "@/components/messenger-dock";
import { BannerCropModal } from "@/components/banner-crop-modal";
import { PharmacyVerificationGate } from "@/components/pharmacy-verification-gate";
import { friendlyLocationLabel, geoApi, getPreciseLocation, locationErrorMessage, type TrackResponse } from "@/lib/geo";

const MediMap = dynamic(() => import("@/components/medi-map").then((m) => m.MediMap), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-xs opacity-60">
      Loading map…
    </div>
  ),
});

// Shown whenever the pharmacy tries to open/publish the shop without a banner.
// Points them to the exact button so they don't get stuck in a loop (Problem 6).
const BANNER_REQUIRED_MSG =
  "🖼️ Shop open করতে আগে একটি banner ছবি দিন — banner-এর ডান-উপরের “Change banner” বাটনে ক্লিক করে ছবি বেছে নিন, crop করে “Save banner” চাপুন। তারপর আবার Shop open চাপুন।";

const DAY_KEYS: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Explain WHY a published ("Live") shop currently shows "Closed" to customers,
 * so the pharmacist isn't confused when it's simply outside opening hours or a
 * self-set temporary close (Problem 13). Returns null when nothing needs
 * explaining (already open, or intentionally Offline — the Live/Offline pill
 * already covers that).
 */
function shopClosedNote(me: PharmacyMe): string | null {
  if (me.is_open_now || !me.is_published) return null;
  // Manual temporary close ("closed_until" in the future).
  if (me.closed_until) {
    const until = new Date(me.closed_until);
    if (!Number.isNaN(until.getTime()) && until.getTime() > Date.now()) {
      return `⏸️ আপনি shop সাময়িকভাবে বন্ধ রেখেছেন — ${until.toLocaleString("bn-BD")} পর্যন্ত customer-দের কাছে “Closed” দেখাবে।`;
    }
  }
  // Otherwise it's outside today's opening hours.
  const today = me.opening_hours?.[DAY_KEYS[new Date().getDay()]];
  if (today?.closed) {
    return "🕒 আজকের দিনটি আপনার opening hours-এ বন্ধ রাখা আছে — তাই shop “Live” থাকলেও এই মুহূর্তে customer-দের কাছে “Closed” দেখাচ্ছে। খুলতে চাইলে My profile → Opening hours থেকে আজকের দিন চালু করুন।";
  }
  if (today?.open && today?.close) {
    return `🕒 এখন opening hours-এর বাইরে (আজ ${today.open}–${today.close} খোলা)। shop “Live” আছে — hours-এর ভেতরে এলে নিজে থেকেই “Open now” হয়ে যাবে, আলাদা কিছু করতে হবে না।`;
  }
  return "🕒 এখন opening hours-এর বাইরে বলে customer-দের কাছে “Closed” দেখাচ্ছে। My profile → Opening hours চেক করে নিন।";
}

export function PharmacyProfilePage() {
  const router = useRouter();
  const [me, setMe] = useState<PharmacyMe | null>(null);
  const [stats, setStats] = useState<PharmacyAnalytics | null>(null);
  const [site, setSite] = useState<SiteContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const [m, s, sc] = await Promise.all([
        pharmacyApi.me(),
        pharmacyApi.analytics().catch(() => null),
        fetchSiteContent().catch(() => null),
      ]);
      setMe(m);
      if (s) setStats(s);
      if (sc) setSite(sc);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load profile");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    if (session.role() !== "pharmacy") { router.replace("/"); return; }
    refresh();
  }, [refresh, router]);

  const onLogout = () => {
    setLoggingOut(true);
    void api("/api/auth/logout", { method: "POST" }).catch(() => {});
    session.clear();
    router.replace("/login");
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-gradient-to-br from-brand-50 via-white to-brand-100 dark:from-[#070b12] dark:via-[#0b1018] dark:to-[#091622]">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-32 -left-24 h-[420px] w-[420px] rounded-full bg-brand-300/40 blur-3xl animate-blob" />
        <div className="absolute top-1/3 -right-24 h-[460px] w-[460px] rounded-full bg-emerald-300/30 blur-3xl animate-blob [animation-delay:2s]" />
        <div className="absolute bottom-0 left-1/3 h-[380px] w-[380px] rounded-full bg-cyan-300/25 blur-3xl animate-blob [animation-delay:4s]" />
      </div>

      <TopNavbar me={me} onChange={setMe} onLogout={onLogout} loggingOut={loggingOut} setError={setError} />

      <div className="px-3 pt-4 pb-28 sm:px-6 sm:pt-6 sm:pb-6 lg:px-10">
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-2xl border border-red-300/60 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-300">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
            <p className="flex-1">{error}</p>
            <button onClick={() => setError(null)}><X size={14} /></button>
          </div>
        )}
        {loading && <p className="opacity-60">Loading…</p>}

        {me && (
          <div id="settings" className="grid scroll-mt-24 gap-6 lg:grid-cols-2">
            {/* LEFT */}
            <div className="space-y-5">
              <BannerCard me={me} onSaved={setMe} setError={setError} />
              <StatsGrid me={me} stats={stats} />
              <PharmacyInfoCard
                me={me}
                onSaved={setMe}
                setError={setError}
                notice={site?.pharmacy_notice}
              />
              <LicenseCard me={me} onSaved={setMe} setError={setError} />
            </div>
            {/* RIGHT */}
            <div className="space-y-5">
              <OpeningHoursCard me={me} onSaved={setMe} setError={setError} />
              <PharmacyMapCard me={me} onSaved={setMe} setError={setError} />
            </div>
          </div>
        )}

        {me && (
          <div id="inventory" className="mt-6 space-y-6 scroll-mt-24">
            <CatalogIntro me={me} onChange={setMe} setError={setError} />
            <InventorySection me={me} onChange={setMe} setError={setError} />
          </div>
        )}
      </div>

      <MessengerDock />

      {/* Mobile bottom tab bar (G3) */}
      <MobileTabBar
        tabs={[
          {
            key: "home",
            label: "Home",
            icon: <Home size={20} />,
            onClick: () => window.scrollTo({ top: 0, behavior: "smooth" }),
          },
          {
            key: "inventory",
            label: "Inventory",
            icon: <Package size={20} />,
            onClick: () =>
              document.getElementById("inventory")?.scrollIntoView({ behavior: "smooth", block: "start" }),
          },
          {
            key: "orders",
            label: "Orders",
            icon: <MessageCircle size={20} />,
            onClick: () => window.dispatchEvent(new CustomEvent("medidoor-open-chat")),
          },
          {
            key: "settings",
            label: "Settings",
            icon: <Settings size={20} />,
            onClick: () =>
              document.getElementById("settings")?.scrollIntoView({ behavior: "smooth", block: "start" }),
          },
        ]}
      />

      {me && me.verification.status !== "verified" && (
        <PharmacyVerificationGate me={me} onVerified={setMe} />
      )}
    </main>
  );
}

/* ---------------------------- top navbar ---------------------------- */

function TopNavbar({
  me, onChange, onLogout, loggingOut, setError,
}: {
  me: PharmacyMe | null;
  onChange: (m: PharmacyMe) => void;
  onLogout: () => void;
  loggingOut: boolean;
  setError: (s: string | null) => void;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const [openingProfile, setOpeningProfile] = useState(false);

  const startLocate = () => setConfirmOpen(true);

  const doLocate = async () => {
    setConfirmOpen(false);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError(locationErrorMessage());
      return;
    }
    setError(null);
    setLocating(true);
    try {
      const fix = await getPreciseLocation({
        desiredAccuracyM: 20,
        bestEffortAfterMs: 12_000,
        timeoutMs: 22_000,
      });
      const geo = await reverseGeocode(fix.lat, fix.lng).catch(() => null);
      // Written place name only. If the geocoders are down, keep the shop's
      // existing typed address instead of overwriting it with a placeholder.
      const label = friendlyLocationLabel(geo, "");
      const address = label || me?.address || "নির্ধারিত অবস্থান";
      const updated = await pharmacyApi.update({ lat: fix.lat, lng: fix.lng, address });
      onChange(updated);
      if (fix.accuracy > 100) {
        setError(`Location ±${Math.round(fix.accuracy)} m (Wi-Fi based) — outdoor-এ গিয়ে আবার try করলে GPS এ pin-point হবে।`);
      }
    } catch (err) {
      setError(locationErrorMessage(err));
    } finally {
      setLocating(false);
    }
  };

  const toggleShop = async () => {
    if (!me) return;
    if (me.verification.status !== "verified") {
      setError("DGDA verification সম্পূর্ণ না হলে shop publish করা যাবে না।");
      return;
    }
    if (!me.is_published && !me.banner_photo_url) {
      setError(BANNER_REQUIRED_MSG);
      return;
    }
    try {
      const updated = await pharmacyApi.update({ is_published: !me.is_published });
      onChange(updated);
    } catch (e) { setError(e instanceof Error ? e.message : "Toggle failed"); }
  };

  return (
    <header className="sticky top-0 z-30 border-b border-black/5 bg-white/70 backdrop-blur dark:border-white/10 dark:bg-[#0b1018]/70">
      <div className="flex w-full flex-wrap items-center gap-2 px-3 py-2 sm:gap-3 sm:px-6 sm:py-3 lg:px-10">
        <BrandLogo className="h-9 w-auto sm:h-12 lg:h-14" />

        <button
          onClick={startLocate}
          disabled={locating}
          className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-brand-500/30 bg-brand-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-brand-700 transition hover:bg-brand-500/20 disabled:opacity-50 sm:ml-2 sm:px-3 sm:text-xs dark:text-brand-300"
        >
          <MapPin size={14} />
          <span className="hidden xs:inline sm:inline">{locating ? "Locating…" : "Locate me"}</span>
        </button>

        {me?.lat && me?.lng && (
          <span className="hidden items-center gap-1 truncate rounded-full bg-black/5 px-2 py-0.5 text-[10px] uppercase tracking-wider opacity-70 md:inline-flex dark:bg-white/10">
            <MapPin size={10} /> {me.address?.slice(0, 40) || "অবস্থান সেট করা আছে"}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {me && (
            <button
              onClick={toggleShop}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-semibold transition sm:px-3 sm:text-xs ${
                me.is_published
                  ? "border-brand-500 bg-brand-500 text-white shadow-md shadow-brand-500/30"
                  : "border-rose-400 bg-rose-500/90 text-white shadow-md shadow-rose-500/30"
              }`}
              title={me.is_published ? "দোকান খোলা — বন্ধ করতে ক্লিক করুন" : "দোকান বন্ধ — খুলতে ক্লিক করুন"}
              aria-label={me.is_published ? "দোকান খোলা" : "দোকান বন্ধ"}
            >
              <Power size={13} />
              <span>{me.is_published ? "দোকান খোলা" : "দোকান বন্ধ"}</span>
            </button>
          )}

          <NotificationsBell />

          {/* Desktop secondary controls (unchanged) */}
          <div className="hidden items-center gap-1.5 sm:flex sm:gap-2">
            <button
              onClick={() => {
                setOpeningProfile(true);
                router.push("/pharmacy/profile");
              }}
              disabled={openingProfile}
              className="inline-flex items-center gap-1.5 rounded-full bg-black/5 px-2.5 py-1.5 text-[11px] font-semibold hover:bg-black/10 sm:px-3 sm:text-xs dark:bg-white/10 dark:hover:bg-white/20"
              aria-label="My profile"
            >
              {openingProfile ? <Loader2 size={12} className="animate-spin" /> : <User size={12} />}
              <span className="hidden sm:inline">{openingProfile ? "Opening…" : "My profile"}</span>
            </button>
            <ThemeToggle />
            <button
              onClick={onLogout}
              disabled={loggingOut}
              className="inline-flex items-center gap-1.5 rounded-full bg-black/5 px-2.5 py-1.5 text-[11px] font-medium hover:bg-black/10 disabled:opacity-60 sm:px-3 sm:text-xs dark:bg-white/10 dark:hover:bg-white/20"
              aria-label="Logout"
            >
              {loggingOut ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />}
              <span className="hidden sm:inline">{loggingOut ? "Logging out…" : "Logout"}</span>
            </button>
          </div>

          {/* Mobile: single overflow menu (G2) */}
          <div className="sm:hidden">
            <HeaderMenu>
              <HeaderMenuItem
                icon={<User size={16} />}
                label="My profile"
                onClick={() => {
                  setOpeningProfile(true);
                  router.push("/pharmacy/profile");
                }}
              />
              <ThemeMenuItem />
              <HeaderMenuItem icon={<LogOut size={16} />} label="Logout" danger onClick={onLogout} />
            </HeaderMenu>
          </div>
        </div>
      </div>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={doLocate}
        title="আপনি কি এখন আপনার pharmacy-তে আছেন?"
        body="Locate me বাটনটি আপনার বর্তমান অবস্থান থেকে pharmacy-র coordinate set করবে। তাই অবশ্যই pharmacy-র ভেতরে দাঁড়িয়ে এই বাটন চাপুন — তা না হলে customer-রা ভুল জায়গায় চলে যাবে।"
        confirmText="হ্যাঁ, আমি pharmacy-তে আছি"
      />
    </header>
  );
}

/* ---------------------------- MediAI notifications bell ---------------------------- */
//
// One-way feed of platform → pharmacy advice messages (publish_advice today,
// extensible later). Polls every 60 s; opens a dropdown on click; marks the
// individual notification as read when the pharmacy taps it.

function NotificationsBell() {
  const [items, setItems] = useState<AiNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await pharmacyApi.listNotifications();
      setItems(res.items);
      setUnread(res.unread);
    } catch { /* offline → keep last state */ }
  }, []);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, [reload]);

  const onMarkOne = async (id: string) => {
    setItems((xs) => xs.map((x) => x.id === id ? { ...x, is_read: true } : x));
    setUnread((u) => Math.max(0, u - 1));
    try { await pharmacyApi.markNotificationRead(id); } catch { /* best-effort */ }
  };

  const onMarkAll = async () => {
    setItems((xs) => xs.map((x) => ({ ...x, is_read: true })));
    setUnread(0);
    try { await pharmacyApi.markAllNotificationsRead(); } catch { /* best-effort */ }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1.5 text-xs font-semibold hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
        aria-label="MediAI notifications"
      >
        <Bell size={14} />
        <span className="hidden md:inline">MediAI</span>
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 grid h-5 min-w-[20px] place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white shadow">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-black/10 bg-white shadow-2xl dark:border-white/10 dark:bg-[#0f1722]">
            <div className="flex items-center justify-between border-b border-black/5 px-3 py-2 dark:border-white/10">
              <p className="text-sm font-bold">MediAI পরামর্শ</p>
              {unread > 0 && (
                <button onClick={onMarkAll} className="text-[11px] font-semibold text-brand-600 hover:underline dark:text-brand-300">
                  সব পঠিত করুন
                </button>
              )}
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {items.length === 0 && (
                <p className="px-4 py-8 text-center text-xs opacity-60">এখনও কোনও MediAI বার্তা আসেনি।</p>
              )}
              {items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => !n.is_read && onMarkOne(n.id)}
                  className={`flex w-full flex-col gap-1 border-b border-black/5 px-3 py-2 text-left transition hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5 ${
                    n.is_read ? "opacity-60" : "bg-brand-50/40 dark:bg-brand-500/5"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 text-base">🤖</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold">{n.title}</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-snug opacity-90">
                        {n.body_bn}
                      </p>
                      {n.payload && Array.isArray((n.payload as Record<string, unknown>).suggested_categories) && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {((n.payload as { suggested_categories: string[] }).suggested_categories || []).map((c) => (
                            <span key={c} className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                              {c}
                            </span>
                          ))}
                        </div>
                      )}
                      {n.created_at && (
                        <p className="mt-1 text-[10px] uppercase tracking-wider opacity-50">
                          {new Date(n.created_at).toLocaleString("bn-BD")}
                        </p>
                      )}
                    </div>
                    {!n.is_read && <span className="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-rose-500" />}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}



function BannerCard({
  me, onSaved, setError,
}: {
  me: PharmacyMe;
  onSaved: (m: PharmacyMe) => void;
  setError: (s: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const tier = TIER_INFO[me.subscription_tier];
  // Cache-bust whenever banner_photo_url changes so the browser never serves
  // a stale image from disk cache when the same URL is overwritten.
  const displayBannerUrl = me.banner_photo_url
    ? `${me.banner_photo_url}${me.banner_photo_url.includes("?") ? "&" : "?"}v=${encodeURIComponent(me.banner_photo_url)}`
    : null;

  // Crop modal returns a freshly-uploaded URL; persist it to the backend
  // immediately so the pharmacist never has to remember a second “Save”.
  const onUploaded = async (url: string) => {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const next = await pharmacyApi.update({ banner_photo_url: url });
      onSaved(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Banner save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="!p-0 overflow-hidden">
      <div className="relative h-56 w-full overflow-hidden bg-gradient-to-r from-brand-300 to-brand-600 sm:h-64">
        {displayBannerUrl && (
          <Image src={displayBannerUrl} alt="banner" fill className="object-cover" sizes="(min-width:1024px) 50vw, 100vw" unoptimized />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/30 to-transparent" />
        <div className="absolute inset-x-4 bottom-3 flex flex-col items-start gap-2 text-white sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 w-full sm:w-auto">
            <h1 className="line-clamp-2 text-xl font-extrabold leading-tight drop-shadow sm:text-2xl md:text-3xl">{me.pharmacy_name}</h1>
            <p className="line-clamp-1 text-sm opacity-90">{me.business_name}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {me.is_verified && (
              <Pill tone="emerald"><BadgeCheck size={11} /> {tier.badge}</Pill>
            )}
            <Pill tone={me.is_published ? "brand" : "slate"}>
              {me.is_published ? "Live" : "Offline"}
            </Pill>
            <Pill tone={me.is_open_now ? "emerald" : "amber"}>
              {me.is_open_now ? "Open now" : me.is_published ? "Closed" : "Closed"}
            </Pill>
          </div>
        </div>

        <label
          className={`absolute right-3 top-3 inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-white backdrop-blur transition ${
            !displayBannerUrl
              ? "bg-amber-500/90 ring-2 ring-amber-300/70 hover:bg-amber-600 animate-pulse"
              : "bg-black/55 hover:bg-black/70"
          }`}
        >
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setPendingFile(f);
              e.target.value = "";
            }}
            disabled={busy}
          />
          <ImageIcon size={12} /> {busy ? "Saving…" : displayBannerUrl ? "Change banner" : "Banner দিন"}
        </label>
      </div>
      {!displayBannerUrl && !busy && (
        <div className="border-t border-amber-300/50 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
          ⚠️ Shop open করতে আগে একটি banner দরকার — উপরে ডান দিকের <b>“Banner দিন”</b> বাটনে ক্লিক করে ছবি বেছে crop করুন, তারপর <b>“Save banner”</b> চাপুন। (crop-এর পর ছবি নিজে থেকেই save হয়ে যাবে।)
        </div>
      )}
      {(() => {
        const note = shopClosedNote(me);
        return note ? (
          <div className="border-t border-amber-300/50 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
            {note}
          </div>
        ) : null;
      })()}
      {saved && (
        <div className="border-t border-brand-300/40 bg-brand-50 px-4 py-2 text-xs font-semibold text-brand-700 dark:border-brand-500/30 dark:bg-brand-950/30 dark:text-brand-200">
          ✓ Banner updated.
        </div>
      )}
      {pendingFile && (
        <BannerCropModal
          file={pendingFile}
          onClose={() => setPendingFile(null)}
          onUploaded={onUploaded}
        />
      )}
    </Card>
  );
}

/* ---------------------------- stats grid ---------------------------- */

function StatsGrid({ me, stats }: { me: PharmacyMe; stats: PharmacyAnalytics | null }) {
  void me;
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <StatBox
        label="This month"
        value={`৳ ${stats?.this_month_revenue ?? 0}`}
        hint="Sold this month"
      />
      <StatBox
        label="Lifetime"
        value={`৳ ${stats?.lifetime_revenue ?? 0}`}
        hint="Since joining"
      />
      <StatBox
        label="Pending"
        value={`${stats?.pending_count ?? 0}`}
        hint="Not delivered yet"
      />
      <StatBox
        label="Inventory"
        value={`${stats?.inventory_active ?? 0}/${stats?.inventory_total ?? 0}`}
        hint="Active / total"
      />
    </div>
  );
}

/* ---------------------------- pharmacy info ---------------------------- */

function PharmacyInfoCard({
  me, onSaved, setError, notice,
}: {
  me: PharmacyMe;
  onSaved: (m: PharmacyMe) => void;
  setError: (s: string | null) => void;
  notice?: string;
}) {
  const [form, setForm] = useState(() => ({
    pharmacy_name: me.pharmacy_name,
    business_name: me.business_name,
    owner_name: me.owner_name,
    description: me.description ?? "",
    phone_number: me.phone_number ?? "",
    address: me.address ?? "",
  }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const updateField = (patch: Partial<typeof form>) => {
    setSaved(false);
    setForm((current) => ({ ...current, ...patch }));
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const next = await pharmacyApi.update(form);
      onSaved(next);
      setSaved(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); }
    finally { setSaving(false); }
  };

  return (
    <Card>
      <h3 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <Building2 size={16} /> Pharmacy info
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Pharmacy name" value={form.pharmacy_name}
          onChange={(v) => updateField({ pharmacy_name: v })} />
        <Field label="Business name" value={form.business_name}
          onChange={(v) => updateField({ business_name: v })} />
        <Field label="Owner name" value={form.owner_name}
          onChange={(v) => updateField({ owner_name: v })} />
        <Field label="Phone" value={form.phone_number}
          onChange={(v) => updateField({ phone_number: v })} />
        <Field label="Address" value={form.address} className="sm:col-span-2"
          onChange={(v) => updateField({ address: v })} />
      </div>
      <label className="mt-3 block">
        <span className="text-xs uppercase tracking-wider opacity-60">Description</span>
        <textarea
          value={form.description}
          onChange={(e) => updateField({ description: e.target.value })}
          rows={3}
          placeholder="আপনার pharmacy সম্পর্কে কয়েকটি লাইন…"
          className="mt-1 w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm dark:border-white/10 dark:bg-white/5"
        />
      </label>
      {notice && notice.trim() && (
        <p className="mt-3 whitespace-pre-line rounded-xl border border-amber-300/40 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-300">
          {notice}
        </p>
      )}
      <button
        onClick={save} disabled={saving}
        className="mt-4 inline-flex items-center gap-2 rounded-full bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
      >
        <Save size={14} /> {saving ? "Saving…" : "Save info"}
      </button>
      {saved && (
        <span className="ml-3 inline-flex align-middle text-xs font-semibold text-brand-700 dark:text-brand-300">
          Changes saved.
        </span>
      )}
    </Card>
  );
}

/* ---------------------------- license & verification ---------------------------- */

function LicenseCard({
  me, onSaved, setError,
}: { me: PharmacyMe; onSaved: (m: PharmacyMe) => void; setError: (s: string | null) => void }) {
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState(false);
  const docUrl = me.pharmacy_license_doc_url;

  const onUpload = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const url = await uploadImage(file);
      const next = await pharmacyApi.update({ pharmacy_license_doc_url: url });
      onSaved(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(me.pharmacy_license_no);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  return (
    <Card>
      <h3 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <BadgeCheck size={16} className="text-emerald-500" /> License & verification
      </h3>
      <p className="mb-3 text-xs opacity-60">
        DGDA / Pharmacy Council license number signup-এ লক করা — পরিবর্তন করতে support এ যোগাযোগ করুন। Document expire হলে renew করে নতুন copy upload করতে পারবেন।
      </p>
      <div className="space-y-3">
        <div>
          <span className="text-xs uppercase tracking-wider opacity-60">License number</span>
          <div className="mt-1 flex items-center gap-2 rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm dark:border-white/10 dark:bg-white/5">
            <span className="flex-1 font-mono">{me.pharmacy_license_no}</span>
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-600 dark:text-emerald-400">
              Locked
            </span>
            <button
              onClick={copy}
              className="rounded-full border border-black/10 px-2 py-0.5 text-[11px] hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
        <div>
          <span className="text-xs uppercase tracking-wider opacity-60">License document</span>
          {docUrl ? (
            <div className="mt-1 flex items-center gap-2 rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm dark:border-white/10 dark:bg-white/5">
              <a href={docUrl} target="_blank" rel="noopener noreferrer" className="flex-1 truncate text-brand-600 underline-offset-2 hover:underline dark:text-brand-300">
                View uploaded document
              </a>
              <label className="cursor-pointer rounded-full border border-black/10 px-3 py-1 text-[11px] font-semibold hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5">
                {uploading ? "Uploading…" : "Replace"}
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }}
                />
              </label>
            </div>
          ) : (
            <label className="mt-1 flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-amber-400/60 bg-amber-50/60 px-3 py-3 text-sm font-medium text-amber-700 hover:bg-amber-100/60 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-300">
              <ImageIcon size={14} />
              {uploading ? "Uploading…" : "Upload license document (image / PDF)"}
              <input
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }}
              />
            </label>
          )}
        </div>
        <p className="rounded-lg bg-black/5 px-3 py-2 text-[11px] opacity-70 dark:bg-white/5">
          Verify references: <a className="underline" href="https://www.dgdagov.info/index.php/pharmacies/allopathic-retail-pharmacy" target="_blank" rel="noopener noreferrer">DGDA retail pharmacy list</a> · <a className="underline" href="https://pcbapps.com.bd/" target="_blank" rel="noopener noreferrer">Pharmacy Council BD</a>
        </p>
      </div>
    </Card>
  );
}

function Field({
  label, value, onChange, type = "text", className,
}: { label: string; value: string; onChange: (v: string) => void; type?: string; className?: string }) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="text-xs uppercase tracking-wider opacity-60">{label}</span>
      <input
        type={type} value={value} onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm dark:border-white/10 dark:bg-white/5"
      />
    </label>
  );
}

/* ---------------------------- opening hours ---------------------------- */

function OpeningHoursCard({
  me, onSaved, setError,
}: { me: PharmacyMe; onSaved: (m: PharmacyMe) => void; setError: (s: string | null) => void }) {
  const [hours, setHours] = useState(me.opening_hours);
  const [saving, setSaving] = useState(false);
  const [sameAll, setSameAll] = useState(false);

  const updateDay = (day: DayKey, patch: Partial<OpeningHourEntry>) => {
    setHours((h) => ({ ...h, [day]: { ...h[day], ...patch } }));
  };

  // Apply one open/close/closed setting to every day at once ("সব দিন একই").
  const applyAll = (patch: Partial<OpeningHourEntry>) => {
    setHours((h) => {
      const next = { ...h };
      for (const k of DAY_KEYS) next[k] = { ...next[k], ...patch };
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const next = await pharmacyApi.update({ opening_hours: hours });
      onSaved(next);
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); }
    finally { setSaving(false); }
  };

  return (
    <Card>
      <h3 className="mb-2 flex items-center gap-2 text-base font-semibold">
        <ClipboardList size={16} /> Opening hours
      </h3>
      <p className="mb-3 text-xs opacity-60">
        Open hours-এর বাইরে pharmacy automatically Closed হয়ে যাবে — কোন order আসবে না।
      </p>

      {/* Quick "same for all days" toggle (P6) */}
      <label className="mb-3 flex cursor-pointer items-center gap-2 rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2.5 text-sm font-medium dark:border-white/10 dark:bg-white/5">
        <input
          type="checkbox"
          checked={sameAll}
          onChange={(e) => {
            const on = e.target.checked;
            setSameAll(on);
            if (on) applyAll({ open: hours.sun.open, close: hours.sun.close, closed: hours.sun.closed });
          }}
          className="h-5 w-5 accent-brand-500"
        />
        সব দিন একই সময়
      </label>

      {sameAll ? (
        <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
          <input
            type="time" value={hours.sun.open} disabled={hours.sun.closed}
            onChange={(e) => applyAll({ open: e.target.value })}
            className="min-w-0 rounded-lg border border-black/10 bg-white/70 px-2 py-2.5 text-sm disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:[color-scheme:dark]"
          />
          <input
            type="time" value={hours.sun.close} disabled={hours.sun.closed}
            onChange={(e) => applyAll({ close: e.target.value })}
            className="min-w-0 rounded-lg border border-black/10 bg-white/70 px-2 py-2.5 text-sm disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:[color-scheme:dark]"
          />
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
            <input
              type="checkbox" checked={hours.sun.closed}
              onChange={(e) => applyAll({ closed: e.target.checked })}
              className="h-5 w-5 accent-brand-500"
            />
            বন্ধ
          </label>
        </div>
      ) : (
        <div className="space-y-2">
          {DAYS.map(({ key, label }) => {
            const h = hours[key];
            return (
              <div key={key} className="grid grid-cols-[52px_1fr_1fr_auto] items-center gap-1.5 sm:grid-cols-[88px_1fr_1fr_auto] sm:gap-2">
                <span className="text-xs font-medium sm:text-sm">{label}</span>
                <input
                  type="time" value={h.open} disabled={h.closed}
                  onChange={(e) => updateDay(key, { open: e.target.value })}
                  className="min-w-0 rounded-lg border border-black/10 bg-white/70 px-1.5 py-2 text-xs disabled:opacity-50 sm:px-2 sm:text-sm dark:border-white/10 dark:bg-white/5 dark:[color-scheme:dark]"
                />
                <input
                  type="time" value={h.close} disabled={h.closed}
                  onChange={(e) => updateDay(key, { close: e.target.value })}
                  className="min-w-0 rounded-lg border border-black/10 bg-white/70 px-1.5 py-2 text-xs disabled:opacity-50 sm:px-2 sm:text-sm dark:border-white/10 dark:bg-white/5 dark:[color-scheme:dark]"
                />
                <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] sm:text-xs">
                  <input
                    type="checkbox" checked={h.closed}
                    onChange={(e) => updateDay(key, { closed: e.target.checked })}
                    className="h-4 w-4 accent-brand-500"
                  />
                  <span>বন্ধ</span>
                </label>
              </div>
            );
          })}
        </div>
      )}
      <button
        onClick={save} disabled={saving}
        className="mt-4 inline-flex items-center gap-2 rounded-full bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
      >
        <Save size={14} /> {saving ? "Saving…" : "Save hours"}
      </button>
    </Card>
  );
}

/* ---------------------------- pharmacy map ---------------------------- */
/**
 * Live map showing the shop's pin + (during a dispatched delivery) the
 * assigned rider's last known location. Click anywhere on the map (or use
 * the search box) to update the shop's address — same effect as the
 * "Locate me" pill in the header but from a richer UI.
 */
function PharmacyMapCard({
  me, onSaved, setError,
}: { me: PharmacyMe; onSaved: (m: PharmacyMe) => void; setError: (s: string | null) => void }) {
  const [activeOrder, setActiveOrder] = useState<{ id: string; rider_lat: number | null; rider_lng: number | null; status: string } | null>(null);
  const [tracking, setTracking] = useState<TrackResponse | null>(null);
  const [route, setRoute] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Find the most recent order with an assigned rider (status = dispatched)
  // so we can poll the rider's live location.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    async function findActive() {
      try {
        const { items } = await pharmacyApi.listOrders("dispatched");
        if (cancelled) return;
        const o = items[0];
        if (o) {
          setActiveOrder({ id: o.id, rider_lat: null, rider_lng: null, status: o.status });
        } else {
          setActiveOrder(null);
        }
      } catch { /* ignore */ }
    }
    findActive();
    timer = setInterval(findActive, 15000);
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, []);

  // Poll track endpoint for the rider's live location.
  useEffect(() => {
    if (!activeOrder) { setTracking(null); setRoute(null); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    async function poll() {
      try {
        const t = await geoApi.track(activeOrder!.id);
        if (cancelled) return;
        setTracking(t);
        // Draw rider→pharmacy route once we have both points.
        if (t.rider?.lat != null && t.rider?.lng != null && t.pharmacy.lat != null && t.pharmacy.lng != null) {
          try {
            const r = await geoApi.route(
              { lat: t.rider.lat, lng: t.rider.lng },
              { lat: t.pharmacy.lat, lng: t.pharmacy.lng },
            );
            if (!cancelled) setRoute(r.geometry);
          } catch { /* ignore */ }
        } else {
          setRoute(null);
        }
      } catch { /* ignore */ }
    }
    poll();
    timer = setInterval(poll, 8000);
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [activeOrder?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const center = me.lat != null && me.lng != null ? { lat: me.lat, lng: me.lng } : null;

  const onPick = async (picked: { lat: number; lng: number; address: string }) => {
    if (saving) return;
    setSaving(true);
    try {
      const updated = await pharmacyApi.update({
        lat: picked.lat,
        lng: picked.lng,
        address: picked.address,
      });
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <MapPin size={16} /> Shop location
          </h3>
          <p className="mt-1 text-xs opacity-60">
            Search bar বা locate button দিয়ে shop-এর সঠিক position সেট করুন।
            Rider যখন order pick-up করতে আসবে তখন তার live location এখানে দেখাবে।
          </p>
        </div>
        {saving && <Loader2 size={14} className="mt-1 animate-spin text-brand-600" />}
      </div>

      <div className="h-[220px] overflow-hidden rounded-2xl border border-black/5 dark:border-white/10 sm:h-[360px]">
        <MediMap
          height="100%"
          center={center}
          userLocation={center}
          userLabel={me.pharmacy_name}
          riderLocation={tracking?.rider?.lat != null && tracking?.rider?.lng != null ? { lat: tracking.rider.lat, lng: tracking.rider.lng } : null}
          riderLabel={tracking?.rider?.name ?? "Rider"}
          routePolyline={route}
          onPick={onPick}
        />
      </div>

      {activeOrder && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          <span className="font-semibold">Active delivery</span>
          <span>·</span>
          <span>Order #{activeOrder.id.slice(0, 8)}</span>
          {tracking?.rider && (
            <>
              <span>·</span>
              <span>Rider: <b>{tracking.rider.name ?? "Assigned"}</b></span>
              {tracking.rider.last_seen_at && (
                <span className="opacity-70">
                  ({new Date(tracking.rider.last_seen_at).toLocaleTimeString()})
                </span>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

/* ---------------------------- inventory ---------------------------- */

function CatalogIntro({
  me, onChange, setError,
}: {
  me: PharmacyMe;
  onChange: (m: PharmacyMe) => void;
  setError: (s: string | null) => void;
}) {
  const isLive = me.is_published;
  const onPublish = async () => {
    if (!me.banner_photo_url) {
      setError(BANNER_REQUIRED_MSG);
      return;
    }
    try {
      const updated = await pharmacyApi.update({ is_published: true });
      onChange(updated);
    } catch (e) { setError(e instanceof Error ? e.message : "Publish failed"); }
  };
  return (
    <Card className="border-brand-500/20 bg-gradient-to-br from-brand-50/80 to-white dark:from-brand-500/10 dark:to-transparent">
      <div className="flex items-start gap-3">
        <div className="hidden h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-brand-600 sm:flex">
          <Lightbulb size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold">আপনার দোকান সাজান — মাত্র ৩ ধাপে</h2>
          <p className="mt-1 text-sm opacity-75">
            Customer-রা যেন আপনার ঔষধ খুঁজে পায়, সেজন্য নিচের ধাপগুলো অনুসরণ করুন।
          </p>
          <ol className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <li className="rounded-xl bg-white/70 p-3 dark:bg-white/5">
              <p className="flex items-center gap-1.5 font-semibold">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand-500 text-[11px] text-white">১</span>
                ছবি, নাম, দাম, stock
              </p>
              <p className="mt-1 text-xs opacity-70">
                শুধু এই ৪টা তথ্য দিন — Category ও Description আমাদের MediAI ছবি দেখে নিজেই বসিয়ে দিবে।
              </p>
            </li>
            <li className="rounded-xl bg-white/70 p-3 dark:bg-white/5">
              <p className="flex items-center gap-1.5 font-semibold">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand-500 text-[11px] text-white">২</span>
                AI review পার হোক
              </p>
              <p className="mt-1 text-xs opacity-70">
                Healthcare product হলে auto-approve, না হলে pending → admin দেখবে।
              </p>
            </li>
            <li className="rounded-xl bg-white/70 p-3 dark:bg-white/5">
              <p className="flex items-center gap-1.5 font-semibold">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand-500 text-[11px] text-white">৩</span>
                দোকান চালু করুন
              </p>
              <p className="mt-1 text-xs opacity-70">
                উপরের <b>Shop open</b> button চাপলে customer-রা আপনার ঔষধ দেখতে পাবে।
              </p>
            </li>
          </ol>

          {!isLive && (
            <div className="mt-4 flex flex-col items-start gap-2 rounded-xl border border-amber-300/50 bg-amber-50 p-3 text-sm text-amber-900 sm:flex-row sm:items-center dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
              <AlertTriangle size={16} className="flex-shrink-0" />
              <p className="flex-1">
                আপনার দোকান এখনো <b>বন্ধ</b> — customer-side এ কিছু দেখাচ্ছে না। ঔষধ যোগ করার পর Publish করতে ভুলবেন না।
              </p>
              <button
                onClick={onPublish}
                className="inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110"
              >
                <Power size={12} /> এখনই চালু করুন
              </button>
            </div>
          )}
          {isLive && (
            <p className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-brand-500/10 px-3 py-1 text-xs font-semibold text-brand-700 dark:text-brand-300">
              <CheckCircle2 size={12} /> আপনার দোকান <b>চালু</b> আছে — customer-রা দেখতে পাচ্ছেন।
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function InventorySection({ me, onChange, setError }: {
  me: PharmacyMe;
  onChange: (m: PharmacyMe) => void;
  setError: (s: string | null) => void;
}) {
  const [items, setItems] = useState<PharmacyMedicine[]>([]);
  const [editing, setEditing] = useState<PharmacyMedicine | "new" | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await pharmacyApi.listMedicines();
      setItems(r.items);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load"); }
  }, [setError]);

  useEffect(() => { reload(); }, [reload]);

  // Group medicines by their PRIMARY (first) AI-assigned category for the
  // pharmacy's own inventory view. Multi-category meds appear once here
  // (under their primary bucket); on the customer side they appear under
  // every bucket they belong to.
  const grouped = useMemo(() => {
    const g: Record<string, PharmacyMedicine[]> = {};
    items.forEach((m) => { (g[m.category || "Uncategorized"] ??= []).push(m); });
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  const onDelete = async (id: string) => {
    if (typeof window !== "undefined" && !window.confirm("এই medicine টি delete করবেন?")) return;
    try { await pharmacyApi.deleteMedicine(id); reload(); }
    catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); }
  };

  const onPublishShop = async () => {
    if (!me.banner_photo_url) {
      setError(BANNER_REQUIRED_MSG);
      return;
    }
    try {
      const updated = await pharmacyApi.update({ is_published: true });
      onChange(updated);
    } catch (e) { setError(e instanceof Error ? e.message : "Publish failed"); }
  };

  const hasMeds = items.length > 0;
  const isLive = me.is_published;

  return (
    <Card>
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <Store size={18} /> Inventory (ঔষধ)
          <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs font-medium opacity-70 dark:bg-white/10">{items.length}</span>
        </h2>
        <button
          onClick={() => setEditing("new")}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-brand-500 px-3 py-2.5 text-sm font-semibold text-white hover:brightness-110 sm:w-auto sm:py-1.5 sm:text-xs"
        ><Plus size={16} /> নতুন ঔষধ যোগ করুন</button>
      </div>
      <p className="mb-3 flex items-start gap-1.5 text-xs opacity-70">
        <Info size={12} className="mt-0.5 flex-shrink-0" />
        <span>ছবি, নাম, দাম ও stock — শুধু এই ৪টা তথ্য দিন। Category ও short description MediAI ছবি দেখে নিজেই বসিয়ে দিবে। Stock = ০ বা hidden হলে customer দেখতে পাবে না।</span>
      </p>

      {hasMeds && !isLive && (
        <div className="mb-3 flex flex-col items-start gap-2 rounded-xl border border-amber-300/50 bg-amber-50 p-3 text-xs text-amber-900 sm:flex-row sm:items-center dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <Eye size={14} className="flex-shrink-0" />
          <p className="flex-1">
            ঔষধ যোগ হয়েছে কিন্তু আপনার <b>দোকান বন্ধ</b> — customer-side থেকে এই ঔষধ দেখাচ্ছে না। চালু করতে ক্লিক করুন:
          </p>
          <button
            onClick={onPublishShop}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110"
          ><Power size={12} /> Publish shop</button>
        </div>
      )}

      {hasMeds && isLive && (() => {
        const visibleCount = items.filter((m) => (m.approval_status ?? "approved") === "approved").length;
        const pendingCount = items.length - visibleCount;
        return (
          <p className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-brand-500/10 px-3 py-1 text-[11px] font-semibold text-brand-700 dark:text-brand-300">
            <CheckCircle2 size={12} /> দোকান চালু — এই {visibleCount} টি ঔষধ customer-রা দেখতে পাচ্ছেন{pendingCount > 0 ? ` (${pendingCount} টি AI/admin review-এ)` : ""}।
          </p>
        );
      })()}

      {grouped.length === 0 && (
        <p className="rounded-xl border border-dashed border-black/10 px-3 py-6 text-center text-sm opacity-70 dark:border-white/10">
          এখনো কোনো ঔষধ যোগ করা হয়নি। উপরে <b>“Medicine যোগ করুন”</b> চাপুন।
        </p>
      )}

      {grouped.map(([cat, list]) => (
        <div key={cat} className="mb-5 last:mb-0">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider opacity-70">{cat}</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {list.map((m) => (
              <div key={m.id} className="flex gap-3 rounded-xl border border-black/5 bg-white/40 p-2 dark:border-white/10 dark:bg-white/5">
                <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-black/5 dark:bg-white/5">
                  {m.image_url
                    ? <Image src={m.image_url} alt={m.name} fill className="object-cover" sizes="64px" unoptimized />
                    : <div className="flex h-full items-center justify-center opacity-40"><Package size={20} /></div>
                  }
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{m.name}</p>
                  <p className="text-xs opacity-70">৳ {m.price} • stock {m.stock}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <button onClick={() => setEditing(m)} className="rounded bg-black/5 p-1 hover:bg-black/10 dark:bg-white/10"><Edit3 size={12} /></button>
                    <button onClick={() => onDelete(m.id)} className="rounded bg-rose-500/10 p-1 text-rose-600 hover:bg-rose-500/20"><Trash2 size={12} /></button>
                    {!m.is_active && <Pill tone="amber">Hidden</Pill>}
                    {m.is_active && m.stock === 0 && <Pill tone="rose">Out of stock</Pill>}
                    {m.is_active && m.stock > 0 && m.stock < 10 && <Pill tone="amber">Low stock</Pill>}
                    {m.prescription_required && <Pill tone="brand">📋 Rx</Pill>}
                    {m.approval_status === "pending" && (
                      <Pill tone="amber">⏳ AI review</Pill>
                    )}
                    {m.approval_status === "rejected" && (
                      <Pill tone="rose">⛔ Rejected</Pill>
                    )}
                  </div>
                  {m.approval_status === "rejected" && m.approval_reason && (
                    <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-rose-600 dark:text-rose-300" title={m.approval_reason}>
                      {m.approval_reason}
                    </p>
                  )}
                  {m.approval_status === "pending" && m.approval_reason && (
                    <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-amber-700 dark:text-amber-300" title={m.approval_reason}>
                      {m.approval_reason}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      <AnimatePresence>
        {editing && (
          <MedicineModal
            initial={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={() => { setEditing(null); reload(); }}
            onError={setError}
          />
        )}
      </AnimatePresence>
    </Card>
  );
}

function MedicineModal({
  initial, onClose, onSaved, onError,
}: {
  initial: PharmacyMedicine | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (s: string) => void;
}) {
  const [form, setForm] = useState<MedicineInput>({
    name: initial?.name ?? "",
    short_description: initial?.short_description ?? "",
    image_url: initial?.image_url ?? "",
    price: initial?.price ?? 0,
    stock: initial?.stock ?? 0,
    is_active: initial?.is_active ?? true,
    prescription_required: initial?.prescription_required ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const onPickImage = async (file: File) => {
    setBusy(true);
    try { const url = await uploadImage(file); setForm({ ...form, image_url: url }); }
    catch (e) { onError(e instanceof Error ? e.message : "Upload failed"); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    if (!form.name.trim()) {
      onError("Medicine-এর নাম দিতে হবে।"); return;
    }
    if (!form.image_url || !form.image_url.trim()) {
      onError("Product image অবশ্যই দিতে হবে — image upload করে তারপর publish করুন।"); return;
    }
    setSubmitting(true);
    try {
      if (initial) await pharmacyApi.updateMedicine(initial.id, form);
      else await pharmacyApi.createMedicine(form);
      onSaved();
    } catch (e) { onError(e instanceof Error ? e.message : "Save failed"); }
    finally { setSubmitting(false); }
  };

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[9999] flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-16"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, y: 12 }} animate={{ scale: 1, y: 0 }}
        className="relative my-auto w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-black/10 bg-white shadow-2xl dark:border-white/10 dark:bg-[#0f1722]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-black/5 px-4 py-3 dark:border-white/10">
          <h3 className="text-base font-bold">{initial ? "Edit medicine" : "Add medicine"}</h3>
          <button onClick={onClose} disabled={submitting}><X size={16} /></button>
        </div>
        {/* AI review notice — collapsed by default so the form is reachable first (P5) */}
        <div className="border-b border-black/5 dark:border-white/10">
          <button
            type="button"
            onClick={() => setShowHelp((v) => !v)}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-[12px] font-semibold text-brand-700 dark:text-brand-300"
            aria-expanded={showHelp}
          >
            <Info size={14} /> কীভাবে কাজ করে?
            <span className="ml-auto text-xs opacity-60">{showHelp ? "▲" : "▼"}</span>
          </button>
          {showHelp && (
            <div className="flex items-start gap-2 bg-gradient-to-r from-brand-50 to-emerald-50 px-4 py-2.5 text-[12px] dark:from-brand-500/10 dark:to-emerald-500/10">
              <span className="text-base">🤖</span>
              <p className="flex-1 leading-snug opacity-85">
                <b>Save চাপলেই MediAI ছবি দেখে product review করবে।</b>
                &nbsp;Healthcare না হলে reject হবে; ছবি ও নাম মিল না থাকলে pending হবে।
                <span className="opacity-70"> Category ও short description AI নিজেই বসিয়ে দিবে — multi-use ঔষধ একাধিক category-তে দেখা যাবে।</span>
              </p>
            </div>
          )}
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <div className="flex items-center gap-3">
            <div className={`relative h-20 w-20 flex-shrink-0 overflow-hidden rounded-xl ${
              form.image_url ? "bg-black/5 dark:bg-white/5" : "bg-rose-50 ring-1 ring-rose-300/60 dark:bg-rose-500/10 dark:ring-rose-400/30"
            }`}>
              {form.image_url
                ? <Image src={form.image_url} alt="img" fill className="object-cover" sizes="80px" unoptimized />
                : <div className="flex h-full items-center justify-center text-rose-500"><Package size={24} /></div>
              }
            </div>
            <div className="flex flex-col gap-1">
              <label className="cursor-pointer rounded-full bg-black/5 px-3 py-1.5 text-xs font-semibold hover:bg-black/10 dark:bg-white/10">
                <input type="file" accept="image/*" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickImage(f); }}
                />
                {busy ? "…" : form.image_url ? "Change image" : "Upload image *"}
              </label>
              {!form.image_url && (
                <span className="text-[11px] font-medium text-rose-600 dark:text-rose-300">
                  Image অবশ্যই দিতে হবে — AI ছবি দেখেই product review করবে।
                </span>
              )}
            </div>
          </div>
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />

          <label className="block">
            <span className="text-xs uppercase tracking-wider opacity-60">
              Short description <span className="opacity-50">(optional — ফাঁকা রাখলে AI লিখে দিবে)</span>
            </span>
            <input
              type="text"
              value={form.short_description ?? ""}
              placeholder="যেমন: Paracetamol 500mg — জ্বর ও ব্যথার জন্য"
              onChange={(e) => setForm({ ...form, short_description: e.target.value })}
              className="mt-1 w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm dark:border-white/10 dark:bg-white/5"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Price (৳)" type="number" value={String(form.price)}
              onChange={(v) => setForm({ ...form, price: Number(v) || 0 })} />
            <Field label="Stock" type="number" value={String(form.stock)}
              onChange={(v) => setForm({ ...form, stock: Number(v) || 0 })} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.is_active}
              onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            Active (visible to customers)
          </label>
          <label className="flex items-start gap-2 rounded-xl border border-amber-300/40 bg-amber-50/60 p-2 text-sm dark:border-amber-400/20 dark:bg-amber-500/10">
            <input
              type="checkbox"
              checked={!!form.prescription_required}
              onChange={(e) => setForm({ ...form, prescription_required: e.target.checked })}
              className="mt-0.5"
            />
            <span className="flex-1">
              <span className="font-semibold">📋 এই ঔষধের জন্য prescription আবশ্যক</span>
              <span className="mt-0.5 block text-[11px] opacity-75">
                আপনি নিজে set করুন — AI এটা decide করবে না, কারণ সব medicine-এর জন্য prescription লাগে না।
                Customer এই product order করতে চাইলে আগে prescription upload করতে হবে।
              </span>
            </span>
          </label>
          {initial && initial.approval_status && initial.approval_status !== "approved" && (
            <div className={`rounded-xl border p-2 text-xs ${
              initial.approval_status === "rejected"
                ? "border-rose-300/50 bg-rose-50/60 text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-200"
                : "border-amber-300/50 bg-amber-50/60 text-amber-700 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200"
            }`}>
              <p className="font-semibold">
                {initial.approval_status === "rejected" ? "⛔ AI rejected this product" : "⏳ Pending admin review"}
              </p>
              {initial.approval_reason && (
                <p className="mt-0.5 opacity-90">{initial.approval_reason}</p>
              )}
              <p className="mt-1 opacity-70">Image / name / category edit করে save করলে AI আবার review করবে।</p>
            </div>
          )}
        </div>
        <div className="flex flex-shrink-0 justify-end gap-2 border-t border-black/5 px-4 py-3 dark:border-white/10">
          <button onClick={onClose} disabled={submitting} className="rounded-full bg-black/5 px-3 py-1.5 text-xs font-semibold dark:bg-white/10 disabled:opacity-50">Cancel</button>
          <button onClick={submit} disabled={busy || submitting || !form.image_url}
            className="inline-flex items-center gap-1 rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50">
            <Save size={12} /> {submitting ? "AI review…" : "Save"}
          </button>
        </div>

        {submitting && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/92 backdrop-blur-sm dark:bg-[#0f1722]/92">
            <div className="relative grid h-16 w-16 place-items-center">
              <div className="absolute inset-0 animate-ping rounded-full bg-brand-500/30" />
              <div className="grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-2xl text-white shadow-lg">
                🤖
              </div>
            </div>
            <p className="text-sm font-bold">MediAI ছবি দেখে review করছে…</p>
            <p className="max-w-xs text-center text-xs opacity-70">
              Healthcare product কিনা, ছবি ও নাম মিলছে কিনা যাচাই করছে।
              5–20 second লাগতে পারে।
            </p>
            <Loader2 size={18} className="animate-spin opacity-60" />
          </div>
        )}
      </motion.div>
    </motion.div>,
    document.body
  );
}

/* ---------------------------- shared primitives ---------------------------- */

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-black/5 bg-white/70 p-5 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5 ${className ?? ""}`}>
      {children}
    </div>
  );
}

function StatBox({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="!p-3 sm:!p-4">
      <p className="text-[11px] uppercase tracking-wider opacity-60 sm:text-xs">{label}</p>
      <p className="mt-1 text-xl font-extrabold tabular-nums sm:text-2xl">{value}</p>
      {hint && <p className="mt-0.5 text-[10px] opacity-60 sm:text-[11px]">{hint}</p>}
    </Card>
  );
}

export function Pill({
  children, tone = "slate",
}: { children: React.ReactNode; tone?: "emerald" | "amber" | "slate" | "brand" | "rose" }) {
  const toneCls = {
    emerald: "bg-emerald-500/90 text-white",
    amber:   "bg-amber-500/90 text-white",
    slate:   "bg-slate-500/80 text-white",
    brand:   "bg-brand-500 text-white",
    rose:    "bg-rose-500/90 text-white",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${toneCls}`}>
      {children}
    </span>
  );
}

export function ConfirmModal({
  open, onClose, onConfirm, title, body, confirmText = "Confirm",
}: {
  open: boolean; onClose: () => void; onConfirm: () => void;
  title: string; body: string; confirmText?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted || !open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border border-black/10 bg-white shadow-2xl dark:border-white/10 dark:bg-[#0f1722]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-5">
          <div className="flex-shrink-0 rounded-full bg-amber-500/20 p-2 text-amber-600">
            <AlertTriangle size={22} />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-bold">{title}</h3>
            <p className="mt-1 text-sm opacity-80">{body}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-black/5 px-4 py-3 dark:border-white/10">
          <button onClick={onClose}
            className="rounded-full bg-black/5 px-3 py-1.5 text-xs font-semibold dark:bg-white/10">
            Cancel
          </button>
          <button onClick={onConfirm}
            className="rounded-full bg-brand-500 px-4 py-1.5 text-xs font-semibold text-white hover:brightness-110">
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
