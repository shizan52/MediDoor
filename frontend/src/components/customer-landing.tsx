"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  MapPin,
  Search,
  MessageCircle,
  LogIn,
  LogOut,
  Upload,
  Loader2,
  Star,
  BadgeCheck,
  ChevronRight,
  Pill,
  Layers,
  Sparkles,
  AlertCircle,
  Home as HomeIcon,
  ScanLine,
  Receipt,
  User as UserIcon,
  X,
} from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { MobileTabBar } from "@/components/mobile-nav";
import { MessengerDock } from "@/components/messenger-dock";
import { SiteFooter } from "@/components/site-footer";
import { PrescriptionFlowModal } from "@/components/prescription-flow-modal";
import { uploadImage, session, api, resolveMediaUrl, type Role } from "@/lib/api";
import {
  fetchNearby,
  reverseGeocode,
  userLocation,
  requestPharmacyChat,
  buyPrefill,
  inquiryPrefill,
  fmtDistance,
  type CategoryCount,
  type StorefrontMedicine,
  type StoredLocation,
} from "@/lib/storefront";
import { fetchSiteContent, type SiteContent } from "@/lib/site";
import { conversationsApi } from "@/lib/conversations";
import {
  canTrackLocationOnThisDevice,
  friendlyLocationLabel,
  geoApi,
  getPreciseLocation,
  locationErrorMessage,
  savedLocationApi,
  type PharmacyMarker,
} from "@/lib/geo";

// MapLibre touches `window` at import — load only on the client.
const MediMap = dynamic(() => import("@/components/medi-map").then((m) => m.MediMap), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-xs opacity-60">
      Loading map…
    </div>
  ),
});

// Map view fallback centre (used only to position the map before the
// customer grants location). Medicines are NOT listed against this — listing
// requires a real location permission (see `loc` gating below).
const MAP_FALLBACK_CENTER = { lat: 22.7009, lng: 90.3676 };

// Bengali copy shown when the customer hasn't granted location permission.
// Per product policy, no medicine is shown without a location.
const LOCATION_REQUIRED_MESSAGE =
  "Location permission ছাড়া medicine দেখানো যাবে না। আপনার আশেপাশের ৩ কিমির মধ্যে pharmacy ও ওষুধ দেখতে অনুগ্রহ করে location permission দিন।";

type SymptomAi = {
  condition: string;
  generic_names: string[];
  categories: string[];
  short_advice: string;
};

type SymptomState = {
  loading: boolean;
  is_symptom: boolean;
  ai: SymptomAi | null;
  items: StorefrontMedicine[];
  usage: { used: number; limit: number; remaining: number; month: string } | null;
  error: string | null;
  // Quota errors are normalised by the API client for user-facing copy.
  quotaExceeded: boolean;
};

const EMPTY_SYMPTOM: SymptomState = {
  loading: false,
  is_symptom: false,
  ai: null,
  items: [],
  usage: null,
  error: null,
  quotaExceeded: false,
};

export function CustomerLanding() {
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
  const [notice, setNotice] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [role, setRole] = useState<Role | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [openingProfile, setOpeningProfile] = useState(false);
  const [site, setSite] = useState<SiteContent | null>(null);
  // Falls back to the gradient hero if the configured banner image fails to
  // load (e.g. the file isn't present on the backend) instead of showing a
  // broken "banner" image.
  const [bannerOk, setBannerOk] = useState(true);
  const [rxModalOpen, setRxModalOpen] = useState(false);
  // Full-screen "কাছের ফার্মেসি" map for mobile (desktop shows the inline map
  // beside the banner). Opened from the mobile nearby card and the profile
  // "Nearby" tile (via the home-intent handoff).
  const [mapModalOpen, setMapModalOpen] = useState(false);
  const [symptom, setSymptom] = useState<SymptomState>(EMPTY_SYMPTOM);
  const [pharmacyMarkers, setPharmacyMarkers] = useState<PharmacyMarker[]>([]);
  // Unread chat count for the mobile bottom-nav চ্যাট badge (app parity).
  const [chatUnread, setChatUnread] = useState(0);
  useEffect(() => {
    if (!authed) { setChatUnread(0); return; }
    let cancelled = false;
    const tick = () =>
      conversationsApi
        .list()
        .then((items) => {
          // A thread is unread for the customer when its last message arrived
          // after (or without) the customer's last read timestamp — same rule
          // the /customer/chats list uses. `ConversationSummary` has no
          // server-provided unread counter, so we derive it here.
          if (!cancelled)
            setChatUnread(
              items.filter(
                (c) =>
                  !!c.last_message_at &&
                  (!c.customer_last_read_at ||
                    new Date(c.last_message_at).getTime() >
                      new Date(c.customer_last_read_at).getTime()),
              ).length,
            );
        })
        .catch(() => {});
    tick();
    const t = setInterval(tick, 20_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [authed]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const guestSearchPromptedRef = useRef(false);

  /* ---------- bootstrap ---------- */
  useEffect(() => {
    setAuthed(!!session.access());
    setRole(null);
    const stored = userLocation.load();
    // Only a real, previously-granted location seeds the listing. Without one
    // we stay in the "location required" state until the browser gives a fix.
    setLoc(stored ?? null);
    fetchSiteContent().then(setSite).catch(() => setSite(null));
    if (session.access()) {
      // Seed from the cached role immediately so the header shows the
      // logged-in state even before /api/auth/me responds.
      setAuthed(true);
      setRole(session.role());
      api<{ role: Role; profile?: { profile_photo_url?: string | null } | null }>("/api/auth/me")
        .then((m) => {
          setAuthed(true);
          setRole(m.role);
          setAvatarUrl(m.role === "customer" ? m.profile?.profile_photo_url ?? null : null);
        })
        .catch(() => {
          // A transient/5xx failure (e.g. the backend returning 503) must NOT
          // log the user out. `api()` already clears the session on a real,
          // unrecoverable 401, so only show the logged-out header when the
          // tokens are actually gone. Otherwise keep them logged in using the
          // cached role.
          if (!session.access()) {
            setAuthed(false);
            setRole(null);
            setAvatarUrl(null);
          } else {
            setAuthed(true);
            setRole(session.role());
          }
        });
    }
    // Auto-trigger geolocation on every page load if we don't have a fresh
    // (<24h old) stored location. Browser only shows the permission prompt
    // once; after that the cached decision applies silently.
    const FRESH_MS = 24 * 60 * 60 * 1000;
    const isFresh = stored && stored.ts && Date.now() - stored.ts < FRESH_MS;
    // GPS-less / blocked device → reuse the location the user's phone saved
    // server-side (kept until their next mobile Locate-me replaces it).
    const useSavedLocation = async (err?: unknown): Promise<void> => {
      const saved = await savedLocationApi.get();
      if (saved) {
        const next: StoredLocation = {
          lat: saved.lat, lng: saved.lng, label: saved.label, ts: Date.now(),
        };
        userLocation.save(next);
        setLoc(next);
        setLocationNotice(
          `এই device থেকে location পাওয়া যায়নি — আপনার সর্বশেষ save করা location "${saved.label}" ব্যবহার হচ্ছে। নতুন location দিতে mobile দিয়ে login করে Locate me চাপুন।`,
        );
        return;
      }
      setLocationNotice(locationErrorMessage(err));
    };
    if (!isFresh && canTrackLocationOnThisDevice()) {
      // Use the shared high-accuracy helper (watchPosition + accuracy
      // threshold) instead of getCurrentPosition — the latter returns the
      // first cached fix which is often a coarse Wi-Fi/IP lookup that can be
      // hundreds of metres off.
      getPreciseLocation({ desiredAccuracyM: 30, bestEffortAfterMs: 10_000, timeoutMs: 18_000 })
        .then(async (fix) => {
          const geo = await reverseGeocode(fix.lat, fix.lng).catch(() => null);
          const label = friendlyLocationLabel(geo);
          const next: StoredLocation = { lat: fix.lat, lng: fix.lng, label, ts: Date.now() };
          userLocation.save(next);
          setLoc(next);
          // Persist server-side so the user's other (GPS-less) devices show
          // this written location too.
          void savedLocationApi.save(fix.lat, fix.lng, fix.accuracy);
        })
        .catch((err) => void useSavedLocation(err));
    } else if (!isFresh) {
      void useSavedLocation();
    }
  }, []);

  // Map pins follow the customer's location — the server clips them to the
  // 5 km connect radius, so without a location there is nothing to show.
  useEffect(() => {
    if (!loc) { setPharmacyMarkers([]); return; }
    geoApi.pharmacies({ lat: loc.lat, lng: loc.lng })
      .then(setPharmacyMarkers)
      .catch(() => setPharmacyMarkers([]));
  }, [loc]);

  const onLogout = () => {
    setLeaving(true);
    void api("/api/auth/logout", { method: "POST" }).catch(() => {});
    session.clear();
    setAuthed(false);
    setRole(null);
    setAvatarUrl(null);
    setSearch("");
    setSymptom(EMPTY_SYMPTOM);
  };

  const canUseCustomerActions = authed && role === "customer";

  const promptCustomerLogin = (feature: string, message: string) => {
    window.dispatchEvent(
      new CustomEvent("medidoor-require-login", {
        detail: { feature, message, role: "customer" },
      }),
    );
  };

  /* ---------- nearby fetch ---------- */
  const load = useCallback(async () => {
    // No location permission → show nothing, surface the blocking message.
    if (!loc) {
      setItems([]);
      setCategories([]);
      setPharmacyCount(0);
      setLoading(false);
      return;
    }
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
      setItems([]);
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [loc, search, activeCategory, canUseCustomerActions]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  /* ---------- AI symptom search (debounced, customer-only) ---------- */
  useEffect(() => {
    const q = search.trim();
    // Reset when query is cleared / too short / unauthenticated.
    if (!canUseCustomerActions || q.length < 2 || !loc) {
      setSymptom(EMPTY_SYMPTOM);
      return;
    }
    let cancelled = false;
    setSymptom((s) => ({ ...s, loading: true, error: null, quotaExceeded: false }));
    const t = setTimeout(async () => {
      try {
        const res = await api<{
          ok: boolean;
          is_symptom: boolean;
          ai: SymptomAi | null;
          items: StorefrontMedicine[];
          usage: SymptomState["usage"];
          code?: string;
          message?: string;
        }>("/api/ai/symptom-search", {
          method: "POST",
          body: JSON.stringify({
            q,
            lat: loc.lat,
            lng: loc.lng,
            radius_km: 5,
          }),
        });
        if (cancelled) return;
        if (!res.ok && res.code === "ai_busy") {
          setSymptom({ ...EMPTY_SYMPTOM, error: res.message || "AI busy" });
          return;
        }
        setSymptom({
          loading: false,
          is_symptom: !!res.is_symptom,
          ai: res.ai,
          items: res.items || [],
          usage: res.usage,
          error: null,
          quotaExceeded: false,
        });
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        const isQuota = /limit শেষ/.test(msg) || (/\b429\b/.test(msg) && /quota_exceeded/.test(msg));
        if (isQuota) {
          // Try to parse usage from the error body for a friendlier counter.
          let used = 5;
          let limit = 5;
          try {
            const m = msg.match(/\{.*\}/s);
            if (m) {
              const parsed = JSON.parse(m[0]);
              const d = parsed?.detail ?? parsed;
              if (typeof d?.used === "number") used = d.used;
              if (typeof d?.limit === "number") limit = d.limit;
            }
          } catch {
            /* ignore */
          }
          setSymptom({
            ...EMPTY_SYMPTOM,
            quotaExceeded: true,
            usage: { used, limit, remaining: 0, month: "" },
          });
        } else {
          setSymptom({ ...EMPTY_SYMPTOM, error: msg });
        }
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, canUseCustomerActions, loc]);

  const onSearchChange = (value: string) => {
    if (!canUseCustomerActions) {
      setSearch("");
      if (!guestSearchPromptedRef.current) {
        guestSearchPromptedRef.current = true;
        promptCustomerLogin(
          "Natural language search",
          "ওষুধ বা উপসর্গ search করতে customer login করতে হবে। Login না করলেও আপনার location অনুযায়ী medicines দেখা যাবে।",
        );
      }
      return;
    }
    setSearch(value);
  };

  /* ---------- locate me ---------- */
  // Device can't give a real fix → show the location the user's phone saved
  // server-side (until their next mobile Locate-me replaces it).
  const fallbackToSavedLocation = async (err?: unknown) => {
    const saved = await savedLocationApi.get();
    if (saved) {
      const next: StoredLocation = {
        lat: saved.lat, lng: saved.lng, label: saved.label, ts: Date.now(),
      };
      userLocation.save(next);
      setLoc(next);
      setLocationNotice(
        `এই device থেকে location পাওয়া যায়নি — আপনার সর্বশেষ save করা location "${saved.label}" ব্যবহার হচ্ছে। নতুন location দিতে mobile দিয়ে login করে Locate me চাপুন।`,
      );
      return;
    }
    setLocationNotice(locationErrorMessage(err));
  };

  const onLocateMe = async () => {
    if (!canTrackLocationOnThisDevice()) {
      await fallbackToSavedLocation();
      return;
    }
    setLocationNotice(null);
    setLocating(true);
    try {
      const fix = await getPreciseLocation({
        desiredAccuracyM: 25,
        bestEffortAfterMs: 12_000,
        timeoutMs: 22_000,
      });
      const geo = await reverseGeocode(fix.lat, fix.lng).catch(() => null);
      const label = friendlyLocationLabel(geo);
      const next: StoredLocation = { lat: fix.lat, lng: fix.lng, label, ts: Date.now() };
      userLocation.save(next);
      setLoc(next);
      void savedLocationApi.save(fix.lat, fix.lng, fix.accuracy);
      if (fix.accuracy > 100) {
        // Coarse fix — warn but don't block.
        setLocationNotice(`Location ±${Math.round(fix.accuracy)} m (Wi-Fi based) — outdoor-এ গিয়ে আবার try করলে GPS এ pin-point হবে।`);
      }
    } catch (err) {
      await fallbackToSavedLocation(err);
    } finally {
      setLocating(false);
    }
  };

  /* ---------- prescription upload (legacy fallback for unauth'd users) ---------- */
  const onPrescriptionPick = async (file: File) => {
    if (!canUseCustomerActions) {
      promptCustomerLogin(
        "Smart Prescription (AI)",
        "Prescription scan করে nearby pharmacy থেকে order করতে customer login করতে হবে।",
      );
      return;
    }
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const url = await uploadImage(file);
      window.localStorage.setItem("medidoor_pending_prescription", url);
      setNotice("✅ Prescription uploaded — Order page-এ এটা attach হবে।");
      window.setTimeout(() => setNotice(null), 4500);
    } catch (e) {
      setError(`Upload failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setUploading(false);
    }
  };

  const openSmartFlow = () => {
    if (!canUseCustomerActions) {
      promptCustomerLogin(
        "Smart Prescription (AI)",
        "Prescription scan করে nearby pharmacy থেকে সব medicine একসাথে order করতে শুধু একবার login করতে হবে।",
      );
      return;
    }
    setRxModalOpen(true);
  };

  // One-shot "home intent" handoff. The app-style sub-pages (profile, chats,
  // orders) have bottom-nav "Rx স্ক্যান" / "Nearby" tiles that live OUTSIDE the
  // landing, so they navigate here and leave an intent for us to act on. Without
  // this they just dumped the user on the home top and appeared to do nothing.
  const homeIntentDoneRef = useRef(false);
  useEffect(() => {
    if (homeIntentDoneRef.current) return;
    let intent: string | null = null;
    try {
      intent = window.sessionStorage.getItem("medidoor_home_intent");
    } catch {
      return;
    }
    if (!intent) return;
    if (intent === "rx") {
      // Wait until the role resolves so openSmartFlow doesn't misfire the login
      // prompt for a customer who is actually signed in.
      if (role !== "customer") return;
      homeIntentDoneRef.current = true;
      try { window.sessionStorage.removeItem("medidoor_home_intent"); } catch { /* ignore */ }
      openSmartFlow();
    } else if (intent === "nearby") {
      homeIntentDoneRef.current = true;
      try { window.sessionStorage.removeItem("medidoor_home_intent"); } catch { /* ignore */ }
      // Show the nearby-pharmacy map (same component the desktop shows inline).
      setMapModalOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  /* ---------- derived ---------- */
  const banner = site?.banner;

  // Open the customer profile — but a viewer who is NOT a logged-in customer
  // must never get a silent dead click. Guest → login gate; logged-in
  // pharmacy/rider (one gmail = one role, so no customer profile exists) →
  // a clean customer-login notice instead of doing nothing.
  const openCustomerProfile = () => {
    if (!authed) {
      window.dispatchEvent(
        new CustomEvent("medidoor-require-login", { detail: { role: "customer" } }),
      );
      return;
    }
    if (role === "customer") {
      setOpeningProfile(true);
      router.push("/customer/profile");
      return;
    }
    router.push("/login?role=customer&msg=customer-only");
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-gradient-to-br from-brand-50 via-white to-brand-100 dark:from-[#070b12] dark:via-[#0b1018] dark:to-[#091622]">
      {/* Decorative 3D blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-brand-300/40 blur-3xl animate-blob" />
        <div className="absolute top-[40%] -right-40 h-[28rem] w-[28rem] rounded-full bg-brand-500/20 blur-3xl animate-blob [animation-delay:-4s]" />
        <div className="absolute bottom-0 left-1/4 h-80 w-80 rounded-full bg-brand-200/40 blur-3xl animate-blob [animation-delay:-8s]" />
      </div>

      {/* Top Navbar — full bleed */}
      <header className="sticky top-0 z-30 border-b border-black/5 dark:border-white/10 bg-white/85 dark:bg-[#0b1018]/85 backdrop-blur">
        <div className="flex items-center gap-3 px-6 py-3 lg:px-10">
          {/* Brand + mobile location — stacked on phones so the header
              reads exactly like the customer app (wordmark with the
              resolved location as a subtitle beneath it). `sm:contents`
              dissolves this wrapper on ≥sm so the desktop layout is
              completely unchanged. */}
          <div className="flex min-w-0 flex-1 flex-col sm:contents">
            <Link href="/" className="shrink-0" aria-label="MediDoor home">
              {/* Mobile: tight wordmark asset (same crop the customer app
                  uses) so the logo reads big & prominent instead of the
                  padded desktop crop that looked small on phones. */}
              <span className="inline-flex h-9 items-center sm:hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/logo-inside-mobile.png" alt="MediDoor" className="h-full w-auto object-contain dark:brightness-0 dark:invert" />
              </span>
              {/* Desktop wordmark unchanged. */}
              <BrandLogo className="hidden h-14 w-auto sm:block" />
            </Link>
            <button
              onClick={onLocateMe}
              disabled={locating}
              aria-label="Update location"
              className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] font-medium text-brand-600 dark:text-brand-300 sm:hidden"
            >
              {locating ? (
                <Loader2 size={11} className="shrink-0 animate-spin" />
              ) : (
                <MapPin size={11} className="shrink-0" />
              )}
              <span className="truncate">{locating ? "লোকেশন খোঁজা হচ্ছে…" : (loc?.label ?? "আপনার অবস্থান দিন")}</span>
            </button>
          </div>

          <button
            onClick={onLocateMe}
            disabled={locating}
            title={loc?.label ?? "আপনার অবস্থান"}
            className="hidden md:flex items-center gap-2 rounded-full border border-black/10 dark:border-white/10 bg-white/80 dark:bg-white/5 px-4 py-2 text-sm hover:bg-brand-50 dark:hover:bg-white/10 transition shadow-sm hover:shadow-md min-w-0 max-w-[460px] lg:max-w-[560px] xl:max-w-[640px] flex-1"
          >
            {locating ? (
              <Loader2 size={14} className="shrink-0 animate-spin text-brand-600" />
            ) : (
              <MapPin size={14} className="shrink-0 text-brand-600" />
            )}
            <span className="truncate text-left">{loc?.label ?? "আপনার অবস্থান"}</span>
          </button>

          <div className="ml-auto flex items-center gap-2">
            {/* Desktop controls (unchanged) */}
            <div className="hidden items-center gap-2 sm:flex">
              <ThemeToggle />
              {authed ? (
                <button
                  onClick={onLogout}
                  disabled={leaving}
                  className="inline-flex items-center gap-1.5 rounded-full glass px-4 py-2 text-sm font-medium hover:scale-105 transition disabled:opacity-60 disabled:hover:scale-100"
                >
                  {leaving ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />} {leaving ? "Logout হচ্ছে…" : "লগআউট"}
                </button>
              ) : (
                <>
                  <Link
                    href="/login?role=customer"
                    className="inline-flex items-center gap-1.5 rounded-full glass px-4 py-2 text-sm font-medium hover:scale-105 transition"
                  >
                    <LogIn size={14} /> Login করুন
                  </Link>
                  <Link
                    href="/login?role=customer"
                    className="rounded-full bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 transition"
                  >
                    Sign up করুন
                  </Link>
                </>
              )}
              <button
                onClick={openCustomerProfile}
                disabled={openingProfile}
                className="relative h-10 w-10 overflow-hidden rounded-full ring-2 ring-brand-500/40 hover:scale-105 transition glass"
                aria-label={authed ? "My profile" : "Login"}
                title={authed ? "My profile" : "Login"}
              >
                {openingProfile ? (
                  <span className="grid h-full w-full place-items-center">
                    <Loader2 size={16} className="animate-spin" />
                  </span>
                ) : authed && avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatarUrl} alt="profile" className="h-full w-full object-cover" />
                ) : (
                  <span className="grid h-full w-full place-items-center">
                    <UserIcon size={16} />
                  </span>
                )}
              </button>
            </div>

            {/* Mobile: direct icon row mirroring the customer app header
                (theme toggle + profile avatar / login). */}
            <div className="flex items-center gap-1.5 sm:hidden">
              <ThemeToggle />
              {authed ? (
                <button
                  onClick={openCustomerProfile}
                  disabled={openingProfile}
                  className="relative grid h-9 w-9 place-items-center overflow-hidden rounded-full ring-1 ring-brand-500/30 dark:ring-white/10"
                  aria-label="Profile"
                >
                  {openingProfile ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={avatarUrl} alt="profile" className="h-full w-full object-cover" />
                  ) : (
                    <UserIcon size={16} />
                  )}
                </button>
              ) : (
                <Link
                  href="/login?role=customer"
                  className="inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white transition"
                >
                  <LogIn size={14} /> Login
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Sub-row */}
        <div className="flex flex-wrap items-center gap-2 px-6 pb-3 lg:px-10">
          <button
            onClick={openSmartFlow}
            disabled={uploading}
            className="group relative hidden items-center gap-2 overflow-hidden rounded-full bg-gradient-to-r from-brand-500 to-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-brand-500/30 hover:shadow-lg hover:shadow-brand-500/40 transition sm:inline-flex"
            title="AI prescription scan"
          >
            <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent group-hover:translate-x-full transition-transform duration-700" />
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            <span>Smart Prescription</span>
            <span className="hidden sm:inline rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">AI</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPrescriptionPick(f);
              e.target.value = "";
            }}
          />

          <div className="relative flex-1 min-w-[220px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
            <input
              value={search}
              onFocus={() => {
                if (!canUseCustomerActions) {
                  promptCustomerLogin(
                    "Natural language search",
                    "ওষুধ বা উপসর্গ search করতে customer login করতে হবে। Login না করলেও আপনার location অনুযায়ী medicines দেখা যাবে।",
                  );
                }
              }}
              onChange={(e) => onSearchChange(e.target.value)}
              readOnly={!canUseCustomerActions}
              placeholder="ওষুধ বা উপসর্গ খুঁজুন (যেমন: Napa, মাথা ব্যথা, চোখ জ্বালা)"
              className="w-full rounded-full border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 pl-9 pr-4 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-300/40"
            />
          </div>

          {/* Desktop-only quick location on the search row; mobile shows it
              under the wordmark instead (see header top row above). */}
          <button
            onClick={onLocateMe}
            disabled={locating}
            className="hidden sm:inline-flex md:hidden items-center gap-1.5 rounded-full border border-black/10 dark:border-white/10 bg-white/70 dark:bg-white/5 px-3 py-2 text-xs"
          >
            {locating ? <Loader2 size={12} className="animate-spin" /> : <MapPin size={12} />}
            <span className="max-w-[140px] truncate">{loc?.label ?? "লোকেশন"}</span>
          </button>
        </div>
      </header>

      {locationNotice && (
        <div className="mx-3 mt-3 flex items-start gap-2 rounded-2xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100 sm:mx-6 lg:mx-10">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <p className="min-w-0 flex-1 leading-relaxed">{locationNotice}</p>
        </div>
      )}

      {/* Hero — banner image on the LEFT, live pharmacy map on the RIGHT.
          On mobile they stack (image first, then map). The map shows the
          customer's location, every nearby pharmacy as a green pin, and
          lets them click anywhere to set delivery address. */}
      <section className="relative px-3 pt-4 sm:px-6 sm:pt-6 lg:px-10 [filter:drop-shadow(0_18px_28px_rgba(6,173,101,0.18))_drop-shadow(0_4px_10px_rgba(15,23,42,0.08))] dark:[filter:drop-shadow(0_22px_36px_rgba(6,173,101,0.28))_drop-shadow(0_4px_12px_rgba(0,0,0,0.45))]">
        <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            style={{ transformStyle: "preserve-3d" }}
            className="relative w-full overflow-hidden rounded-3xl border border-white/30 dark:border-white/10 shadow-2xl shadow-brand-900/20"
          >
            {(banner?.image_url || banner?.image_url_mobile) && bannerOk ? (
              <>
                {/* Mobile (sm and below) — portrait or square crop preferred */}
                {(banner.image_url_mobile || banner.image_url) && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={(banner.image_url_mobile || banner.image_url)!}
                    alt="banner"
                    onError={() => setBannerOk(false)}
                    className="block h-auto max-h-[80vh] w-full object-contain sm:hidden"
                  />
                )}
                {/* Desktop / tablet — wide crop preferred */}
                {(banner.image_url || banner.image_url_mobile) && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={(banner.image_url || banner.image_url_mobile)!}
                    alt="banner"
                    onError={() => setBannerOk(false)}
                    className="hidden h-auto max-h-[640px] w-full object-contain sm:block"
                  />
                )}
                {/* Dark gradient overlay so banner text stays legible over a
                    busy photo (C1) — bottom-anchored where captions usually sit. */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/60 via-black/25 to-transparent" />
              </>
            ) : (
              <div className="aspect-[16/10] w-full bg-gradient-to-br from-brand-500 via-brand-600 to-emerald-700 sm:aspect-[16/9]" />
            )}
            {/* Mobile hero actions — overlaid on the banner exactly like the
                customer mobile app (Locate me + Smart Prescription). Hidden on
                desktop where the toolbar already exposes these. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/60 via-black/20 to-transparent lg:hidden" />
            <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 p-3 lg:hidden">
              <button
                type="button"
                onClick={onLocateMe}
                disabled={locating}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3.5 py-2 text-[12px] font-bold text-brand-700 shadow-lg ring-1 ring-black/5 backdrop-blur disabled:opacity-70"
              >
                {locating ? <Loader2 size={13} className="animate-spin" /> : <MapPin size={13} />} Locate me
              </button>
              <button
                type="button"
                onClick={openSmartFlow}
                disabled={uploading}
                className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-3.5 py-2 text-[12px] font-bold text-white shadow-lg ring-1 ring-white/25 disabled:opacity-70"
              >
                {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Smart Prescription
              </button>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.05 }}
            className="relative hidden w-full overflow-hidden rounded-3xl border border-white/30 dark:border-white/10 shadow-2xl shadow-brand-900/20 bg-white dark:bg-white/5 min-h-[200px] sm:min-h-[320px] lg:block"
          >
            <MediMap
              height="100%"
              center={loc ? { lat: loc.lat, lng: loc.lng } : MAP_FALLBACK_CENTER}
              userLocation={loc ? { lat: loc.lat, lng: loc.lng } : null}
              userLabel={loc?.label}
              pharmacies={pharmacyMarkers}
              onPharmacyClick={(p) => router.push(`/store/${p.id}`)}
              onPick={(picked) => {
                const next: StoredLocation = {
                  lat: picked.lat,
                  lng: picked.lng,
                  label: picked.address || picked.raw.address_bn || "আপনার অবস্থান",
                  ts: Date.now(),
                };
                userLocation.save(next);
                setLoc(next);
              }}
            />
            {loc && (
              <div className="pointer-events-none absolute bottom-3 left-3 z-[6] max-w-[calc(100%-72px)] rounded-2xl bg-white/95 dark:bg-slate-900/90 px-3 py-2 text-[11px] shadow-lg ring-1 ring-black/5 dark:ring-white/10 backdrop-blur">
                <div className="flex items-center gap-1.5 font-semibold text-brand-700 dark:text-brand-400">
                  <MapPin size={12} />
                  আপনার অবস্থান
                </div>
                <div className="mt-0.5 truncate">{loc.label}</div>
              </div>
            )}
          </motion.div>
        </div>
      </section>

      {/* Mobile-only compact "কাছের ফার্মেসি" card — the customer app shows
          this instead of a full inline map on the home screen. Desktop keeps
          the live map beside the banner (hidden below lg). */}
      <section className="mt-4 px-3 lg:hidden">
        <button
          type="button"
          onClick={() => setMapModalOpen(true)}
          className="flex w-full items-center gap-3 rounded-[22px] border border-black/5 bg-white px-3.5 py-3 text-left shadow-sm dark:border-white/10 dark:bg-white/5"
        >
          <span className="relative grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-brand-500/10 text-brand-600 dark:text-brand-300">
            <MapPin size={20} />
            {pharmacyMarkers.length > 0 && (
              <span className="absolute -right-1 -top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-brand-500 px-1 text-[9px] font-bold text-white ring-2 ring-white dark:ring-[#0b1018]">
                {pharmacyMarkers.length > 9 ? "9+" : pharmacyMarkers.length}
              </span>
            )}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block text-sm font-bold">কাছের ফার্মেসি</span>
            <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">
              {pharmacyMarkers.length > 0
                ? `${pharmacyMarkers.length}টি ফার্মেসি আপনার কাছাকাছি — ঔষধ দেখুন`
                : "আপনার আশেপাশের ফার্মেসির ঔষধ দেখুন"}
            </span>
          </span>
          <ChevronRight size={18} className="shrink-0 text-slate-400" />
        </button>
      </section>

      {/* Sidebar + Product grid */}
      <section id="browse" className="relative scroll-mt-24 px-6 pt-8 pb-28 lg:px-10 sm:pb-16">
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          {/* Vertical category sidebar — desktop only; mobile uses the
              horizontal pill row below (app parity). */}
          <aside className="hidden lg:block lg:sticky lg:top-[140px] lg:self-start">
            <div className="overflow-hidden rounded-3xl border border-black/5 dark:border-white/10 bg-white/80 dark:bg-white/5 backdrop-blur shadow-lg">
              <div className="flex items-center justify-between gap-2 border-b border-black/5 dark:border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Layers size={14} className="text-brand-600" />
                  <p className="text-sm font-semibold">ক্যাটেগরি</p>
                </div>
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-medium text-brand-700 dark:text-brand-300"
                  title="MediAI প্রতিটি ঔষধ ছবি দেখে নিজে ক্যাটেগরিতে রাখে"
                >
                  <Sparkles size={10} /> AI
                </span>
              </div>
              <nav className="max-h-[calc(100vh-220px)] overflow-y-auto p-2">
                <SidebarRow
                  label="সব ঔষধ"
                  active={!activeCategory}
                  count={items.length}
                  onClick={() => setActiveCategory(null)}
                />
                {categories.map((c) => (
                  <SidebarRow
                    key={c.name}
                    label={c.name}
                    count={c.count}
                    title={c.short_description ?? undefined}
                    active={activeCategory === c.name}
                    onClick={() => setActiveCategory(c.name)}
                  />
                ))}
                {categories.length === 0 && !loading && (
                  <p className="px-3 py-2 text-xs opacity-60">কোনো ক্যাটেগরি নেই।</p>
                )}
              </nav>
            </div>
          </aside>

          {/* Right column: product grid.
              `min-w-0` is essential: as a grid item its default
              `min-width:auto` would let the inner product grid + horizontal
              category scroller expand to their content width and overflow
              the viewport on mobile (pushing the 2nd product column off
              screen). min-w-0 lets it shrink to the available cell. */}
          <div className="min-w-0">
            {/* Mobile category pills — horizontal scroll, mirrors the
                customer mobile app's "Shop by category" row. Desktop keeps
                the vertical sidebar (hidden on mobile above). */}
            {categories.length > 0 && (
              <div className="mb-4 lg:hidden">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-sm font-bold">Shop by category</h2>
                  {activeCategory && (
                    <button
                      type="button"
                      onClick={() => setActiveCategory(null)}
                      className="rounded-full bg-brand-500/10 px-2.5 py-1 text-[11px] font-bold text-brand-700 dark:text-brand-300"
                    >
                      Clear filter
                    </button>
                  )}
                </div>
                <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                  <button
                    type="button"
                    onClick={() => setActiveCategory(null)}
                    aria-pressed={!activeCategory}
                    className={[
                      "shrink-0 rounded-full border px-3.5 py-2 text-[11px] font-bold shadow-sm transition",
                      !activeCategory
                        ? "border-brand-500 bg-brand-500 text-white"
                        : "border-black/10 bg-white text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200",
                    ].join(" ")}
                  >
                    All ({items.length})
                  </button>
                  {categories.map((c) => {
                    const active = activeCategory === c.name;
                    return (
                      <button
                        key={c.name}
                        type="button"
                        onClick={() => setActiveCategory(active ? null : c.name)}
                        aria-pressed={active}
                        className={[
                          "shrink-0 rounded-full border px-3.5 py-2 text-[11px] font-bold shadow-sm transition",
                          active
                            ? "border-brand-500 bg-brand-500 text-white"
                            : "border-black/10 bg-white text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200",
                        ].join(" ")}
                      >
                        {c.name} ({c.count})
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Mobile status row — app parity ("X pharmacy · Y medicines"). */}
            {loc && (
              <div className="mb-3 rounded-2xl border border-black/5 bg-white px-3 py-2 text-[11px] text-slate-500 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-slate-400 lg:hidden">
                {loading ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 size={11} className="animate-spin" /> Loading…
                  </span>
                ) : (
                  <span>
                    <BadgeCheck size={11} className="-mt-0.5 mr-1 inline text-brand-500" />
                    {pharmacyCount} pharmacy · {items.length} medicines nearby
                  </span>
                )}
              </div>
            )}

            {error && (
              <p className="mb-4 rounded-xl border border-red-300/50 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                {error}
              </p>
            )}
            {notice && (
              <p className="mb-4 rounded-xl border border-emerald-300/50 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
                {notice}
              </p>
            )}

            {/* AI symptom-search strip */}
            {(symptom.is_symptom || symptom.quotaExceeded || symptom.loading || symptom.error) && (
              <SymptomStrip state={symptom} />
            )}

            {/* Guest hint: typed in search but not logged in → invite to log in for AI search */}
            {!authed && search.trim().length >= 2 && (
              <div className="mb-4 flex flex-col gap-2 rounded-2xl border border-brand-300/40 bg-brand-50/70 dark:bg-brand-500/10 px-4 py-3 text-sm text-brand-900 dark:text-brand-100 sm:flex-row sm:items-center sm:justify-between">
                <span>
                  <Sparkles size={14} className="mr-1 inline -translate-y-0.5" />
                  AI medicine search ও symptom understanding ব্যবহার করতে login করুন।
                </span>
                <button
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("medidoor-require-login", {
                        detail: {
                          feature: "AI medicine search",
                          message:
                            "নিজের symptom লিখলে AI nearby pharmacy থেকে সঠিক medicine খুঁজে দেবে — শুধু একবার login করতে হবে।",
                          role: "customer",
                        },
                      }),
                    )
                  }
                  className="self-start rounded-full bg-gradient-to-r from-brand-500 to-brand-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:brightness-110 sm:self-auto"
                >
                  <LogIn size={12} className="mr-1 inline -translate-y-0.5" />
                  Login করুন
                </button>
              </div>
            )}

            {!loc ? (
              <div className="rounded-3xl border border-amber-300/60 bg-amber-50/80 p-8 text-center shadow-sm dark:border-amber-500/30 dark:bg-amber-500/10 sm:p-10">
                <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-300">
                  <MapPin size={26} />
                </div>
                <p className="text-base font-semibold text-amber-900 dark:text-amber-100">
                  Location permission প্রয়োজন
                </p>
                <p className="mx-auto mt-1.5 max-w-md text-sm text-amber-800/90 dark:text-amber-200/80">
                  {LOCATION_REQUIRED_MESSAGE}
                </p>
                <button
                  onClick={onLocateMe}
                  disabled={locating}
                  className="mt-4 inline-flex items-center gap-2 rounded-full bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow hover:bg-brand-600 disabled:opacity-60"
                >
                  {locating ? <Loader2 size={15} className="animate-spin" /> : <MapPin size={15} />}
                  {locating ? "Location খোঁজা হচ্ছে…" : "Location permission দিন"}
                </button>
              </div>
            ) : loading ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {Array.from({ length: 10 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-72 animate-pulse rounded-2xl bg-black/5 dark:bg-white/5"
                  />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-black/10 dark:border-white/10 bg-white/50 dark:bg-white/5 p-10 text-center">
                <Pill className="mx-auto mb-3 text-brand-500" />
                <p className="text-base font-medium">কোনো ঔষধ পাওয়া যায়নি।</p>
                <p className="mt-1 text-sm opacity-70">
                  অন্য ক্যাটেগরি / search চেষ্টা করুন বা location বদলান।
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {items.map((m) => (
                  <ProductCard key={m.id} m={m} />
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <SiteFooter />

      <MessengerDock navInset />

      {/* Mobile bottom tab bar — mirrors the customer mobile app's 5-tab nav
          (হোম · চ্যাট · Rx স্ক্যান · অর্ডার · প্রোফাইল) so the web mobile view
          feels identical to the native app. */}
      <MobileTabBar
        tabs={[
          {
            key: "home",
            label: "হোম",
            icon: <HomeIcon size={20} />,
            active: true,
            onClick: () =>
              window.scrollTo({ top: 0, behavior: "smooth" }),
          },
          {
            key: "chats",
            label: "চ্যাট",
            icon: <MessageCircle size={20} />,
            badge: chatUnread,
            onClick: () => {
              if (!session.access()) {
                window.dispatchEvent(
                  new CustomEvent("medidoor-require-login", {
                    detail: {
                      feature: "Messages",
                      message: "Order ও chat দেখতে শুধু একবার login করতে হবে।",
                      role: "customer",
                    },
                  }),
                );
                return;
              }
              router.push("/customer/chats");
            },
          },
          {
            key: "rx",
            label: "Rx স্ক্যান",
            icon: <ScanLine size={20} />,
            onClick: openSmartFlow,
          },
          {
            key: "orders",
            label: "অর্ডার",
            icon: <Receipt size={20} />,
            onClick: () => {
              if (!session.access()) {
                window.dispatchEvent(
                  new CustomEvent("medidoor-require-login", {
                    detail: {
                      feature: "Orders",
                      message: "আপনার order গুলো দেখতে শুধু একবার login করতে হবে।",
                      role: "customer",
                    },
                  }),
                );
                return;
              }
              router.push("/customer/orders");
            },
          },
          {
            key: "profile",
            label: "প্রোফাইল",
            icon: <UserIcon size={20} />,
            onClick: openCustomerProfile,
          },
        ]}
      />

      <PrescriptionFlowModal
        open={rxModalOpen}
        onClose={() => setRxModalOpen(false)}
        lat={loc?.lat ?? null}
        lng={loc?.lng ?? null}
        address={loc?.label ?? null}
      />

      {/* Full-screen "কাছের ফার্মেসি" map for mobile — same live MediMap the
          desktop shows inline beside the banner. Opened from the mobile nearby
          card and the profile "Nearby" tile (home-intent handoff). */}
      {mapModalOpen && (
        <div className="fixed inset-0 z-[70] flex flex-col bg-white dark:bg-[#0b1018] lg:hidden">
          <div className="flex items-center gap-3 border-b border-black/5 px-4 py-3 dark:border-white/10">
            <button
              type="button"
              onClick={() => setMapModalOpen(false)}
              aria-label="Close map"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            >
              <X size={18} />
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold leading-tight">কাছের ফার্মেসি</p>
              <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                {pharmacyMarkers.length > 0
                  ? `${pharmacyMarkers.length}টি ফার্মেসি আপনার কাছাকাছি — পিন চাপুন`
                  : loc
                    ? "আপনার আশেপাশে ফার্মেসি খোঁজা হচ্ছে…"
                    : "লোকেশন দিন — কাছের ফার্মেসি দেখতে"}
              </p>
            </div>
            <button
              type="button"
              onClick={onLocateMe}
              disabled={locating}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand-500 px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-70"
            >
              {locating ? <Loader2 size={13} className="animate-spin" /> : <MapPin size={13} />} Locate me
            </button>
          </div>
          <div className="relative flex-1">
            <MediMap
              height="100%"
              center={loc ? { lat: loc.lat, lng: loc.lng } : MAP_FALLBACK_CENTER}
              userLocation={loc ? { lat: loc.lat, lng: loc.lng } : null}
              userLabel={loc?.label}
              pharmacies={pharmacyMarkers}
              onPharmacyClick={(p) => { setMapModalOpen(false); router.push(`/store/${p.id}`); }}
              onPick={(picked) => {
                const next: StoredLocation = {
                  lat: picked.lat,
                  lng: picked.lng,
                  label: picked.address || picked.raw.address_bn || "আপনার অবস্থান",
                  ts: Date.now(),
                };
                userLocation.save(next);
                setLoc(next);
              }}
            />
          </div>
        </div>
      )}
    </main>
  );
}

/* ===================================================================== */

function SidebarRow({
  label,
  count,
  active,
  title,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition ${
        active
          ? "bg-brand-500 text-white shadow-md shadow-brand-500/30"
          : "hover:bg-brand-500/10"
      }`}
    >
      <span className="truncate">{label}</span>
      {typeof count === "number" && (
        <span
          className={`text-[10px] font-medium ${
            active ? "text-white/80" : "opacity-50"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function ProductCard({ m }: { m: StorefrontMedicine }) {
  // Up to 2 category chips on the image (multi-use medicines).
  const cats = (m.categories && m.categories.length > 0 ? m.categories : [m.category]).slice(0, 2);
  // Resolve relative /uploads paths to the backend origin (app parity).
  const imgSrc = resolveMediaUrl(m.image_url);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -3 }}
      transition={{ type: "spring", stiffness: 220, damping: 22 }}
      onClick={() => requestPharmacyChat({ pharmacy_id: m.pharmacy.id })}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          requestPharmacyChat({ pharmacy_id: m.pharmacy.id });
        }
      }}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-black/5 dark:border-white/10 bg-white/85 dark:bg-white/5 backdrop-blur shadow-md transition hover:shadow-xl hover:shadow-brand-500/10"
    >
      <div className="relative aspect-square w-full overflow-hidden bg-gradient-to-br from-slate-50 to-emerald-50/60 dark:from-white/5 dark:to-brand-500/10">
        {imgSrc ? (
          <Image
            src={imgSrc}
            alt={m.name}
            fill
            sizes="(max-width:640px) 50vw, 25vw"
            className="object-cover transition group-hover:scale-105"
            unoptimized
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-brand-500">
            <Pill size={36} />
          </div>
        )}
        {/* Category badge — top-right (customer app parity). */}
        <div className="absolute right-2 top-2 flex max-w-[80%] flex-wrap justify-end gap-1">
          {cats.map((c) => (
            <span key={c} className="rounded-full bg-white/95 px-2 py-0.5 text-[10px] font-semibold text-slate-700 shadow-sm backdrop-blur dark:bg-slate-950/80 dark:text-slate-200">
              {c}
            </span>
          ))}
        </div>
        {m.prescription_required && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-rose-600/95 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow"
            title="এই ঔষধ order করতে prescription upload করতে হবে"
          >
            📋 Rx
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-3">
        <p className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-tight">{m.name}</p>
        {m.short_description && (
          <p className="mt-0.5 line-clamp-2 text-xs opacity-70">{m.short_description}</p>
        )}

        <Link
          href={`/store/${m.pharmacy.id}`}
          onClick={(e) => e.stopPropagation()}
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300"
        >
          {m.pharmacy.name}
          {m.pharmacy.is_verified && <BadgeCheck size={12} className="text-emerald-500" />}
          <ChevronRight size={11} />
        </Link>

        <div className="mt-1 flex items-center gap-2 text-[11px] opacity-70">
          {(m.pharmacy.rating_count ?? 0) > 0 ? (
            <>
              <Star size={11} className="fill-amber-400 text-amber-400" />
              {m.pharmacy.rating.toFixed(1)}
            </>
          ) : (
            <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">নতুন</span>
          )}
          {m.distance_km != null && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-0.5">
                <MapPin size={10} /> {fmtDistance(m.distance_km)}
              </span>
            </>
          )}
          <span>·</span>
          <span className={m.delivery_fee > 0 ? "" : "font-semibold text-emerald-600 dark:text-emerald-400"}>
            {m.delivery_fee > 0 ? `ডেলিভারি ৳${m.delivery_fee.toFixed(0)}` : "ডেলিভারি ফ্রি"}
          </span>
        </div>

        <div className="mt-auto flex items-center justify-between gap-2 pt-3">
          <p className="text-base font-bold">৳ {m.price.toFixed(0)}</p>
          <div className="flex items-center gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                requestPharmacyChat({
                  pharmacy_id: m.pharmacy.id,
                  prefill: inquiryPrefill(m.name),
                });
              }}
              className="inline-flex items-center justify-center rounded-full border border-brand-500/40 bg-brand-500/10 p-1.5 text-brand-700 hover:bg-brand-500/20 transition dark:text-brand-300"
              aria-label="Message pharmacy about this medicine"
              title="Message pharmacy"
            >
              <MessageCircle size={13} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                requestPharmacyChat({
                  pharmacy_id: m.pharmacy.id,
                  prefill: buyPrefill(m.name, m.price),
                });
              }}
              className="rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 transition"
            >
              Buy
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/* ===================================================================== */

function SymptomStrip({ state }: { state: SymptomState }) {
  if (state.loading && !state.is_symptom) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-2xl border border-brand-300/40 bg-brand-50/60 dark:bg-brand-500/10 px-4 py-3 text-sm text-brand-800 dark:text-brand-200">
        <Loader2 size={14} className="animate-spin" />
        <span>medi AI আপনার search বুঝে nearby medicine খুঁজছে…</span>
      </div>
    );
  }
  if (state.quotaExceeded) {
    return (
      <div className="mb-4 flex items-start gap-3 rounded-2xl border border-amber-300/60 bg-amber-50 dark:bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
        <AlertCircle size={18} className="mt-0.5 shrink-0" />
        <div className="flex-1">
          <p className="font-semibold">এই মাসের free AI symptom search শেষ ({state.usage?.used ?? 5}/{state.usage?.limit ?? 5})</p>
          <p className="mt-1 text-xs opacity-80">
            ঔষধের নাম দিয়ে search করলে আগের মতই unlimited চলবে। পরের মাসে quota reset হবে — অথবা subscribe করুন।
          </p>
        </div>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="mb-4 rounded-2xl border border-red-300/50 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300">
        AI symptom search ব্যর্থ — আবার চেষ্টা করুন।
      </div>
    );
  }
  if (!state.is_symptom || !state.ai) return null;
  const ai = state.ai;
  return (
    <div className="mb-5 overflow-hidden rounded-2xl border border-brand-400/40 bg-gradient-to-br from-brand-50 via-white to-emerald-50 dark:from-brand-500/15 dark:via-[#0b1018] dark:to-emerald-500/10 shadow-md">
      <div className="flex items-start gap-3 border-b border-brand-300/30 px-4 py-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-500/15 text-brand-700 dark:text-brand-300">
          <Sparkles size={16} />
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-brand-900 dark:text-brand-100">
            medi AI: <span className="opacity-80">{ai.condition || "আপনার symptom"}</span> এর জন্য সম্ভাব্য ঔষধ
          </p>
          {ai.short_advice && (
            <p className="mt-0.5 text-xs opacity-75">{ai.short_advice}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(ai.generic_names || []).slice(0, 6).map((g) => (
              <span key={g} className="rounded-full bg-white/70 dark:bg-white/10 px-2 py-0.5 text-[11px] font-medium">
                {g}
              </span>
            ))}
          </div>
        </div>
        {state.usage && (
          <span className="shrink-0 rounded-full bg-white/80 dark:bg-white/10 px-2 py-1 text-[10px] font-medium opacity-80">
            {state.usage.used}/{state.usage.limit} this month
          </span>
        )}
      </div>
      {state.items.length === 0 ? (
        <p className="px-4 py-3 text-xs opacity-70">
          আপনার আশেপাশের pharmacy-তে এই ধরনের ঔষধ এখন পাওয়া যাচ্ছে না — radius বাড়িয়ে চেষ্টা করুন বা ঔষধের নাম লিখে search করুন।
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {state.items.slice(0, 10).map((m) => (
            <ProductCard key={`ai-${m.id}`} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}


