"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  MapPin,
  Map as MapIcon,
  Search,
  Star,
  BadgeCheck,
  Sparkles,
  Loader2,
  Pill,
  ChevronRight,
  Bell,
  ScanLine,
} from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { BrandLogo } from "@/components/brand-logo";
import { InitialAvatar } from "@/components/initial-avatar";
import { ThemeToggle } from "@/components/theme-toggle";
import { ProductCard, ProductCardSkeleton } from "@/components/product-card";
import { api, resolveMediaUrl, session, type Role } from "@/lib/api";
import {
  fetchNearby,
  reverseGeocode,
  userLocation,
  requestPharmacyChat,
  buyPrefill,
  inquiryPrefill,
  type CategoryCount,
  type StorefrontMedicine,
  type StoredLocation,
} from "@/lib/storefront";
import { fetchSiteContent, type SiteContent } from "@/lib/site";
import {
  canTrackLocationOnThisDevice,
  friendlyLocationLabel,
  getPreciseLocation,
  locationErrorMessage,
  geoApi,
  savedLocationApi,
  type PharmacyMarker,
} from "@/lib/geo";

const FALLBACK_LOCATION: StoredLocation = {
  lat: 22.7009,
  lng: 90.3676,
  label: "আপনার অবস্থান",
  ts: 0,
};

/**
 * Older builds (and the map page) saved the location label as raw
 * "lat, lng" coordinates whenever the Barikoi reverse-geocode failed.
 * Those bare numbers looked like an IP address under the logo. Rewrite
 * any coordinate-shaped label to a friendly Bangla placeholder so the
 * whole app reads cleanly regardless of what's already in localStorage.
 */
const COORDS_LABEL = /^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/;
function prettyLocation(l: StoredLocation | null): StoredLocation | null {
  if (!l) return l;
  if (!l.label || COORDS_LABEL.test(l.label)) {
    return { ...l, label: "আপনার অবস্থান" };
  }
  return l;
}

export default function HomePage() {
  const router = useRouter();
  const [loc, setLoc] = useState<StoredLocation | null>(null);
  const [locating, setLocating] = useState(false);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [items, setItems] = useState<StorefrontMedicine[]>([]);
  const [categories, setCategories] = useState<CategoryCount[]>([]);
  const [pharmacyCount, setPharmacyCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [locationNotice, setLocationNotice] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [role, setRole] = useState<Role | null>(null);
  const [me, setMe] = useState<{ name: string | null; avatar: string | null } | null>(null);
  const [site, setSite] = useState<SiteContent | null>(null);
  // Nearby pharmacy markers for the home map (parity with the website home).
  const [pharms, setPharms] = useState<PharmacyMarker[]>([]);
  // ---- AI symptom search (parity with website customer-landing) ----
  type SymptomAi = {
    intent_summary: string | null;
    suggested_categories: string[];
    advice_bn: string | null;
    confidence: number;
  };
  const [symptomAi, setSymptomAi] = useState<SymptomAi | null>(null);
  const [symptomLoading, setSymptomLoading] = useState(false);
  const [symptomQuotaLeft, setSymptomQuotaLeft] = useState<number | null>(null);
  const canUseCustomerActions = authed && role === "customer";
  // Lightweight poll of /api/notifications/me/unread for the bell badge.
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    if (!canUseCustomerActions) { setUnreadCount(0); return; }
    let alive = true;
    const tick = async () => {
      try {
        const r = await api<{ unread: number }>("/api/notifications/me?limit=1");
        if (alive) setUnreadCount(r.unread || 0);
      } catch {}
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [canUseCustomerActions]);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Nearby-pharmacy pins follow the customer's REAL location (the server
  // clips to the 5 km connect radius). The ts===0 fallback marker is not a
  // real location, so it shows no pins.
  useEffect(() => {
    if (!loc || !loc.ts) { setPharms([]); return; }
    geoApi.pharmacies({ lat: loc.lat, lng: loc.lng })
      .then(setPharms)
      .catch(() => setPharms([]));
  }, [loc]);

  /* ------------- bootstrap ------------- */
  useEffect(() => {
    const hasToken = !!session.access();
    setAuthed(hasToken);
    setRole(session.role());
    const stored = prettyLocation(userLocation.load());
    setLoc(stored ?? FALLBACK_LOCATION);
    fetchSiteContent().then(setSite).catch(() => setSite(null));

    // Pull profile photo + name so the top-right avatar mirrors the
    // website's header (where the real photo is shown). Fail silently
    // — the InitialAvatar gradient fallback will still render.
    if (hasToken) {
      api<{
        gmail: string;
        profile?: { first_name?: string; last_name?: string; profile_photo_url?: string | null } | null;
      }>("/api/auth/me")
        .then((m) => {
          const p = m.profile ?? null;
          const name = [p?.first_name, p?.last_name].filter(Boolean).join(" ") || m.gmail || null;
          setMe({ name, avatar: resolveMediaUrl(p?.profile_photo_url) || null });
        })
        .catch(() => setMe(null));
    }

    const FRESH = 24 * 60 * 60 * 1000;
    const isFresh = stored && stored.ts && Date.now() - stored.ts < FRESH;
    // Device can't give a real fix → reuse the location this account saved
    // server-side (from any device) until a newer save replaces it.
    const useSavedLocation = async (err?: unknown): Promise<void> => {
      const saved = await savedLocationApi.get();
      if (saved) {
        const next: StoredLocation = {
          lat: saved.lat, lng: saved.lng, label: saved.label, ts: Date.now(),
        };
        userLocation.save(next);
        setLoc(next);
        setLocationNotice(
          `এই device থেকে location পাওয়া যায়নি — আপনার সর্বশেষ save করা location "${saved.label}" ব্যবহার হচ্ছে।`,
        );
        return;
      }
      setLocationNotice(locationErrorMessage(err));
    };
    if (!isFresh && canTrackLocationOnThisDevice()) {
      getPreciseLocation({ desiredAccuracyM: 30, bestEffortAfterMs: 10_000, timeoutMs: 18_000 })
        .then(async (fix) => {
          const lat = fix.lat;
          const lng = fix.lng;
          const geo = await reverseGeocode(lat, lng).catch(() => null);
          const label = friendlyLocationLabel(geo);
          const next: StoredLocation = { lat, lng, label, ts: Date.now() };
          userLocation.save(next);
          setLoc(next);
          // This is the "mobile login" capture: persist server-side so every
          // other device shows this written location too.
          void savedLocationApi.save(lat, lng, fix.accuracy);
        })
        .catch((err) => void useSavedLocation(err));
    } else if (!isFresh) {
      void useSavedLocation();
    }
  }, []);

  /* ------------- nearby fetch ------------- */
  const load = useCallback(async () => {
    if (!loc) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchNearby({
        lat: loc.lat,
        lng: loc.lng,
        radius_km: 5,
        q: canUseCustomerActions ? search.trim() || undefined : undefined,
        category: activeCategory ?? undefined,
      });
      setItems(data.items);
      setCategories(data.categories);
      setPharmacyCount(data.pharmacy_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [loc, search, activeCategory, canUseCustomerActions]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  /* ------------- AI symptom search (debounced, customer-only) ------------- */
  useEffect(() => {
    const q = search.trim();
    if (!canUseCustomerActions || q.length < 2 || !loc) {
      setSymptomAi(null);
      setSymptomLoading(false);
      return;
    }
    let cancelled = false;
    setSymptomLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await api<{
          ok: boolean;
          is_symptom: boolean;
          ai: SymptomAi | null;
          usage?: { remaining: number };
          code?: string;
        }>("/api/ai/symptom-search", {
          method: "POST",
          body: JSON.stringify({ q, lat: loc.lat, lng: loc.lng, radius_km: 5 }),
        });
        if (cancelled) return;
        if (res.ok && res.is_symptom && res.ai) setSymptomAi(res.ai);
        else setSymptomAi(null);
        if (typeof res.usage?.remaining === "number") setSymptomQuotaLeft(res.usage.remaining);
      } catch {
        if (!cancelled) setSymptomAi(null);
      } finally {
        if (!cancelled) setSymptomLoading(false);
      }
    }, 700);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, canUseCustomerActions, loc]);

  const requireCustomerLogin = (next = "/") => {
    router.push(`/login?role=customer&next=${encodeURIComponent(next)}`);
  };

  const onSearchChange = (value: string) => {
    if (!canUseCustomerActions) {
      setSearch("");
      requireCustomerLogin("/");
      return;
    }
    setSearch(value);
  };

  /* ------------- locate me ------------- */
  // Device can't give a real fix → reuse the account's server-saved location.
  const fallbackToSavedLocation = async (err?: unknown) => {
    const saved = await savedLocationApi.get();
    if (saved) {
      const next: StoredLocation = {
        lat: saved.lat, lng: saved.lng, label: saved.label, ts: Date.now(),
      };
      userLocation.save(next);
      setLoc(next);
      setLocationNotice(
        `এই device থেকে location পাওয়া যায়নি — আপনার সর্বশেষ save করা location "${saved.label}" ব্যবহার হচ্ছে।`,
      );
      return;
    }
    setLocationNotice(locationErrorMessage(err));
  };

  const onLocate = async () => {
    if (locating) return;
    if (!canTrackLocationOnThisDevice()) {
      await fallbackToSavedLocation();
      return;
    }
    setLocating(true);
    try {
      const fix = await getPreciseLocation({ desiredAccuracyM: 25, bestEffortAfterMs: 12_000, timeoutMs: 22_000 });
      const lat = fix.lat;
      const lng = fix.lng;
      const geo = await reverseGeocode(lat, lng).catch(() => null);
      const label = friendlyLocationLabel(geo);
      const next: StoredLocation = { lat, lng, label, ts: Date.now() };
      userLocation.save(next);
      setLoc(next);
      setLocationNotice(null);
      // Persist server-side so the user's other (GPS-less) devices show it.
      void savedLocationApi.save(lat, lng, fix.accuracy);
    } catch (err) {
      await fallbackToSavedLocation(err);
    } finally {
      setLocating(false);
    }
  };

  /* ------------- chat handlers ------------- */
  const onBuy = (m: StorefrontMedicine) =>
    requestPharmacyChat(router, {
      pharmacy_id: m.pharmacy.id,
      prefill: buyPrefill(m.name, m.price),
    });
  const onMessage = (m: StorefrontMedicine) =>
    requestPharmacyChat(router, {
      pharmacy_id: m.pharmacy.id,
      prefill: inquiryPrefill(m.name),
    });

  const banner = site?.banner;
  // Try mobile-cropped variant first; if it fails to load (admin-uploaded
  // file removed/missing on disk) we fall back to the desktop banner via
  // the onError swap below.
  const mobileBannerImg = resolveMediaUrl(banner?.image_url_mobile || "");
  const desktopBannerImg = resolveMediaUrl(banner?.image_url || "");
  const [bannerSrc, setBannerSrc] = useState<string>("");
  useEffect(() => {
    setBannerSrc(mobileBannerImg || desktopBannerImg || "");
  }, [mobileBannerImg, desktopBannerImg]);

  return (
    <>
      {/*
        Header: brand logo + theme toggle + auth shortcut.
        - title slot replaces the bare "MediDoor" text with the wordmark
          image so the mobile app matches the website branding.
        - subtitle keeps the user's resolved location.
        - right slot stacks ThemeToggle and the Login/Profile pill.
      */}
      <MobileHeader
        title={<BrandLogo className="h-7 w-auto" />}
        subtitle={
          <button
            type="button"
            onClick={onLocate}
            className="flex max-w-full items-center gap-1 text-brand-600 dark:text-brand-300"
            aria-label="Update location"
          >
            {locating ? (
              <Loader2 size={11} className="shrink-0 animate-spin" />
            ) : (
              <MapPin size={11} className="shrink-0" />
            )}
            <span className="truncate font-medium">{locating ? "লোকেশন খোঁজা হচ্ছে…" : loc?.label || "আপনার অবস্থান দিন"}</span>
          </button>
        }
        right={
          <>
            <Link
              href="/map"
              aria-label="Open map"
              className="tap flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 text-brand-600 dark:bg-white/10 dark:text-brand-300"
            >
              <MapIcon size={16} />
            </Link>
            {authed && role === "customer" && (
              <Link
                href="/notifications"
                aria-label="Notifications"
                className="tap relative flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 text-brand-600 dark:bg-white/10 dark:text-brand-300"
              >
                <Bell size={16} />
                {unreadCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white ring-2 ring-white dark:ring-[#070b12]">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                )}
              </Link>
            )}
            <ThemeToggle />
            {authed ? (
              <Link
                href={role === "customer" ? "/profile" : "/login"}
                className="tap relative grid h-9 w-9 place-items-center overflow-hidden rounded-full ring-1 ring-brand-500/30 dark:ring-white/10"
                aria-label="Profile"
              >
                <InitialAvatar
                  name={me?.name || "You"}
                  src={me?.avatar || null}
                  size={36}
                />
              </Link>
            ) : (
              <Link
                href="/login"
                className="tap rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600"
              >
                Login
              </Link>
            )}
          </>
        }
      />

      {locationNotice && (
        <section className="px-4 pt-2">
          <p className="rounded-2xl border border-amber-300/70 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
            {locationNotice}
          </p>
        </section>
      )}

      {/* Search */}
      <section className="px-4 pt-2.5">
        <div className="flex items-center gap-2 rounded-[22px] border border-slate-200 bg-white px-3.5 shadow-sm focus-within:border-brand-300 focus-within:ring-4 focus-within:ring-brand-500/10 dark:border-white/10 dark:bg-white/[0.04]">
          <Search size={17} className="shrink-0 text-brand-500" />
          <input
            value={search}
            onFocus={() => {
              if (!canUseCustomerActions) requireCustomerLogin("/");
            }}
            onChange={(e) => onSearchChange(e.target.value)}
            readOnly={!canUseCustomerActions}
            placeholder="ওষুধ বা উপসর্গ খুঁজুন…"
            className="min-w-0 flex-1 bg-transparent py-3.5 text-sm font-medium outline-none placeholder:text-slate-400"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="grid h-7 w-7 place-items-center rounded-full bg-slate-100 text-xs font-bold text-slate-500 dark:bg-white/10 dark:text-slate-300"
            >
              ✕
            </button>
          )}
        </div>
      </section>

      {/* AI symptom understanding banner — shown when /api/ai/symptom-search
          flagged the query as a symptom. Mirrors the website parity. */}
      {(symptomLoading || symptomAi) && (
        <section className="mt-3 px-4">
          <div className="rounded-2xl border border-brand-200 bg-gradient-to-br from-brand-50 to-emerald-50 p-3 dark:border-brand-500/30 dark:from-brand-500/10 dark:to-emerald-500/5">
            <div className="flex items-start gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-brand-600 shadow-sm dark:bg-white/10 dark:text-brand-300">
                {symptomLoading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-bold uppercase tracking-wider text-brand-600 dark:text-brand-300">
                  medi AI — উপসর্গ বুঝেছে
                  {symptomQuotaLeft != null && (
                    <span className="ml-2 rounded-full bg-white/70 px-1.5 py-0.5 text-[9px] font-semibold text-brand-700 dark:bg-white/10 dark:text-brand-200">
                      {symptomQuotaLeft} বার বাকি
                    </span>
                  )}
                </p>
                {symptomAi?.intent_summary && (
                  <p className="mt-1 text-[13px] font-semibold text-slate-800 dark:text-slate-100">
                    {symptomAi.intent_summary}
                  </p>
                )}
                {symptomAi?.advice_bn && (
                  <p className="mt-0.5 text-[11px] leading-snug text-slate-600 dark:text-slate-300">
                    {symptomAi.advice_bn}
                  </p>
                )}
                {symptomAi?.suggested_categories?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {symptomAi.suggested_categories.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setActiveCategory(c)}
                        className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-brand-700 shadow-sm dark:bg-white/10 dark:text-brand-200"
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Hero banner — the admin-set banner image IS the hero. The two
          primary actions (Locate me + Smart Prescription) are overlaid on
          a bottom scrim with a glass/solid treatment, a soft shine sweep
          and a slide-up entrance, so they always stand out and never melt
          into the underlying image. When the admin image can't load we
          fall back to a plain brand gradient surface (no invented copy) so
          it still reads as the banner, not a fabricated one. */}
      <section className="mt-3 px-4">
        <div className="relative aspect-[16/10] w-full overflow-hidden rounded-[24px] border border-slate-200/70 shadow-sm dark:border-white/10">
          {/* Background layer: admin image, else brand gradient. */}
          {bannerSrc ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={bannerSrc}
              alt={banner?.title_top || "MediDoor"}
              className="absolute inset-0 h-full w-full object-cover"
              onError={() => {
                if (bannerSrc !== desktopBannerImg && desktopBannerImg) {
                  setBannerSrc(desktopBannerImg);
                } else {
                  setBannerSrc("");
                }
              }}
            />
          ) : (
            <div className="brand-grad absolute inset-0">
              <div className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-white/10 blur-2xl" />
              <div className="pointer-events-none absolute -bottom-12 -left-8 h-36 w-36 rounded-full bg-emerald-200/20 blur-2xl" />
            </div>
          )}

          {/* Soft animated shine so the hero always feels alive. */}
          <div className="hero-shine pointer-events-none absolute inset-0" />

          {/* Bottom scrim so overlaid buttons pop on any image. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/70 via-black/25 to-transparent" />

          {/* Overlaid primary actions. */}
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 p-3">
            <button
              type="button"
              onClick={onLocate}
              disabled={locating}
              className="tap animate-slideUp inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3.5 py-2 text-[12px] font-bold text-brand-700 shadow-lg ring-1 ring-black/5 backdrop-blur disabled:opacity-70"
            >
              {locating ? <Loader2 size={13} className="animate-spin" /> : <MapPin size={13} />} Locate me
            </button>
            <Link
              href={canUseCustomerActions ? "/prescription" : "/login?role=customer&next=%2Fprescription"}
              className="tap animate-slideUp ml-auto inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-3.5 py-2 text-[12px] font-bold text-white shadow-lg ring-1 ring-white/25"
            >
              <ScanLine size={13} /> Smart Prescription
            </Link>
          </div>
        </div>
      </section>

      {/* Nearby pharmacies — a single compact entry point to the full
          map + live tracking page. The interactive map itself lives on
          /map (reached here or via the header map icon), so the home no
          longer renders a second, duplicate map. */}
      {loc && (
        <section className="mt-4 px-4">
          <Link
            href="/map"
            className="tap flex items-center gap-3 rounded-[22px] border border-slate-200/80 bg-white px-3.5 py-3 shadow-sm dark:border-white/10 dark:bg-white/[0.04]"
          >
            <span className="relative grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
              <MapIcon size={20} />
              {pharms.length > 0 && (
                <span className="absolute -right-1 -top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-brand-500 px-1 text-[9px] font-bold text-white ring-2 ring-white dark:ring-[#070b12]">
                  {pharms.length > 9 ? "9+" : pharms.length}
                </span>
              )}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block text-sm font-bold">কাছের ফার্মেসি</span>
              <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">
                {pharms.length > 0
                  ? `${pharms.length}টি ফার্মেসি আপনার কাছাকাছি — মানচিত্রে দেখুন`
                  : "মানচিত্রে আপনার আশেপাশের ফার্মেসি ও order tracking দেখুন"}
              </span>
            </span>
            <ChevronRight size={18} className="shrink-0 text-slate-400" />
          </Link>
        </section>
      )}

      {/* Categories — simple horizontal pills. Kept text-only because
          icon tiles made this section feel visually heavier than the
          medicine grid below. */}
      {categories.length > 0 && (
        <section className="mt-4">
          <div className="flex items-center justify-between px-4">
            <h2 className="text-sm font-bold">Shop by category</h2>
            {activeCategory && (
              <button
                type="button"
                onClick={() => setActiveCategory(null)}
                className="rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-bold text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
              >
                Clear filter
              </button>
            )}
          </div>
          <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto px-4 pb-1.5">
            <button
              type="button"
              onClick={() => setActiveCategory(null)}
              aria-pressed={activeCategory === null}
              className={[
                "tap shrink-0 rounded-full border px-3.5 py-2 text-[11px] font-bold shadow-sm",
                activeCategory === null
                  ? "border-brand-500 bg-brand-500 text-white shadow-sm"
                  : "border-slate-200/80 bg-white text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200",
              ].join(" ")}
            >
              All ({categories.reduce((sum, c) => sum + c.count, 0)})
            </button>
            {categories.slice(0, 24).map((c) => {
              const active = activeCategory === c.name;
              return (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => setActiveCategory(active ? null : c.name)}
                  aria-pressed={active}
                  className={[
                    "tap shrink-0 rounded-full border px-3.5 py-2 text-[11px] font-bold shadow-sm",
                    active
                      ? "border-brand-500 bg-brand-500 text-white shadow-sm"
                      : "border-slate-200/80 bg-white text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200",
                  ].join(" ")}
                >
                  {c.name} ({c.count})
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Status row */}
      <section className="mt-3 px-4 text-[11px] text-slate-500 dark:text-slate-400">
        <div className="rounded-2xl border border-slate-200/70 bg-white px-3 py-2 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
        {loading ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 size={11} className="animate-spin" /> Loading…
          </span>
        ) : error ? (
          <span className="text-rose-500">{error}</span>
        ) : (
          <span>
            <BadgeCheck size={11} className="-mt-0.5 mr-1 inline text-brand-500" />
            {pharmacyCount} pharmacy · {items.length} medicines nearby
          </span>
        )}
        </div>
      </section>

      {/* Product grid */}
      <section className="mt-3 grid grid-cols-2 gap-3.5 px-4">
        {loading && items.length === 0
          ? Array.from({ length: 6 }).map((_, i) => <ProductCardSkeleton key={i} />)
          : items.map((m) => (
              <ProductCard
                key={m.id}
                item={m}
                onBuy={() => onBuy(m)}
                onMessage={() => onMessage(m)}
              />
            ))}
        {!loading && items.length === 0 && (
          <div className="col-span-2 flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.02] dark:text-slate-400">
            <Pill size={22} className="opacity-50" />
            <p>আশেপাশে কোনও pharmacy পাওয়া যায়নি — অন্য location চেষ্টা করুন।</p>
          </div>
        )}
      </section>

      <div ref={sentinelRef} className="h-4" />
    </>
  );
}
