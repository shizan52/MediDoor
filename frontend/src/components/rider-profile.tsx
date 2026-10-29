"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bike,
  Phone,
  Mail,
  IdCard,
  ShieldCheck,
  BadgeCheck,
  Loader2,
  LogOut,
  Calendar,
  User,
  MapPin,
  Power,
  Package,
  Check,
  Truck,
  MessageCircle,
  Send,
  X,
  Wallet,
} from "lucide-react";
import { api, session, type Role } from "@/lib/api";
import { rider as riderApi, type RiderOffer, type RiderOrder, type RiderOrderMessage } from "@/lib/rider";
import {
  friendlyLocationLabel, geoApi, getPreciseLocation, locationErrorMessage,
  savedLocationApi,
  LOCATION_DEVICE_UNAVAILABLE_MESSAGE, MAX_FIX_ACCURACY_M,
} from "@/lib/geo";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { HeaderMenu, HeaderMenuItem, ThemeMenuItem, MobileTabBar } from "@/components/mobile-nav";
import { MessengerDock } from "@/components/messenger-dock";

const MediMap = dynamic(() => import("@/components/medi-map").then((m) => m.MediMap), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-xs opacity-60">
      Loading map…
    </div>
  ),
});

type RiderProfile = {
  full_name?: string;
  nick_name?: string | null;
  phone_number?: string;
  age?: number;
  nid_number?: string;
  nid_front_url?: string | null;
  nid_back_url?: string | null;
  profile_photo_url?: string | null;
  is_verified?: boolean;
  verification_status?: "pending" | "verified" | "rejected" | string;
  verification_note?: string | null;
};

type Me = {
  account_id: string;
  gmail: string;
  role: Role;
  is_registered: boolean;
  profile?: RiderProfile | null;
};

const PING_INTERVAL_MS = 30_000;
const OFFERS_POLL_MS = 5_000;
const ACTIVE_POLL_MS = 7_000;

export function RiderProfilePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [openingProfile, setOpeningProfile] = useState(false);

  // duty status
  const [online, setOnline] = useState(false);

  // live location
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  // Last accepted GPS accuracy (m) — sent with pings so the backend can
  // reject coarse fixes.
  const lastAccuracyRef = useRef<number | null>(null);
  const [locLabel, setLocLabel] = useState<string>("Locate me");
  const [locBusy, setLocBusy] = useState(false);

  // Written road/area name for the current coords ("Gorachand Das Road" —
  // never bare numbers). Re-resolved only when the rider moves to a new
  // ~110 m grid cell; the backend caches reverse lookups so this is cheap.
  const roadLabelRef = useRef<string | null>(null);
  const roadGridRef = useRef<string | null>(null);
  const refreshRoadLabel = useCallback(async (lat: number, lng: number): Promise<string | null> => {
    const grid = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (roadGridRef.current === grid) return roadLabelRef.current;
    roadGridRef.current = grid;
    const geo = await geoApi.reverse(lat, lng).catch(() => null);
    const label = friendlyLocationLabel(geo);
    roadLabelRef.current = label;
    return label;
  }, []);

  // offers + active
  const [offers, setOffers] = useState<RiderOffer[]>([]);
  const [active, setActive] = useState<RiderOrder[]>([]);

  useEffect(() => {
    if (!session.access()) {
      router.replace("/login");
      return;
    }
    api<Me>("/api/auth/me")
      .then((data) => {
        if (data.role !== "rider") {
          router.replace(`/${data.role}`);
          return;
        }
        if (!data.is_registered) {
          router.replace("/register/rider");
          return;
        }
        setMe(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, [router]);

  // geolocation watcher (only when online)
  useEffect(() => {
    if (!online) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError(locationErrorMessage());
      setOnline(false);
      return;
    }
    let watchId: number | null = null;
    let bestAcc = Number.POSITIVE_INFINITY;
    let gotUsableFix = false;
    const start = (highAccuracy: boolean) => {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const acc = pos.coords.accuracy ?? 9999;
          // Pin-point gate: a fix coarser than 1 km is an IP/coarse-WiFi
          // lookup, not GPS — never track or ping it.
          if (acc > MAX_FIX_ACCURACY_M) return;
          // Drop wildly inaccurate samples (> 200 m) once we have a good fix —
          // they come from Wi-Fi/IP fallback and would teleport the rider pin.
          if (bestAcc < 100 && acc > 200) return;
          if (acc < bestAcc) bestAcc = acc;
          gotUsableFix = true;
          lastAccuracyRef.current = acc;
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          setCoords({ lat, lng });
          // Show the written place name, not bare numbers.
          setLocLabel(roadLabelRef.current ? `📍 ${roadLabelRef.current}` : `📍 Live · ±${Math.round(acc)} m`);
          void refreshRoadLabel(lat, lng).then((label) => {
            if (label) setLocLabel(`📍 ${label}`);
          });
        },
        (err) => {
          // If high-accuracy times out / fails, fall back to low-accuracy.
          if (highAccuracy && (err.code === 3 || err.code === 2)) {
            if (watchId !== null) navigator.geolocation.clearWatch(watchId);
            start(false);
          } else {
            setError(locationErrorMessage(err));
            setOnline(false);
          }
        },
        {
          enableHighAccuracy: highAccuracy,
          maximumAge: 5_000,
          timeout: highAccuracy ? 15_000 : 30_000,
        },
      );
    };
    start(true);
    // GPS-less devices only ever produce coarse fixes: after a grace window
    // with no usable fix, tell the rider to use a GPS device and go offline.
    const gpsGrace = setTimeout(() => {
      if (!gotUsableFix) {
        setError(LOCATION_DEVICE_UNAVAILABLE_MESSAGE);
        setOnline(false);
      }
    }, 30_000);
    return () => {
      clearTimeout(gpsGrace);
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [online]);

  // ping loop
  useEffect(() => {
    if (!online || !coords) return;
    let cancelled = false;
    const send = () => {
      if (cancelled) return;
      riderApi.ping(coords.lat, coords.lng, lastAccuracyRef.current ?? undefined)
        .then((res) => {
          if (!cancelled && res && res.ok === false && res.code === "gps_accuracy_poor") {
            setError(res.message || LOCATION_DEVICE_UNAVAILABLE_MESSAGE);
            setOnline(false);
          }
        })
        .catch(() => {});
    };
    send();
    const t = setInterval(send, PING_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [online, coords]);

  // offers poll
  useEffect(() => {
    if (!online) { setOffers([]); return; }
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await riderApi.offers();
        if (!cancelled) setOffers(data.items);
      } catch { /* ignore */ }
    };
    tick();
    const t = setInterval(tick, OFFERS_POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [online]);

  // active poll (always)
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await riderApi.activeOrders();
        if (!cancelled) setActive(data.items);
      } catch { /* ignore */ }
    };
    tick();
    const t = setInterval(tick, ACTIVE_POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [me]);

  const onLogout = () => {
    setLoggingOut(true);
    void api("/api/auth/logout", { method: "POST" }).catch(() => {});
    session.clear();
    router.replace("/login");
  };

  const onLocateMe = useCallback(async (): Promise<boolean> => {
    if (!navigator.geolocation) {
      setError(locationErrorMessage());
      return false;
    }
    setError(null);
    setLocBusy(true);
    try {
      const fix = await getPreciseLocation({ desiredAccuracyM: 25, bestEffortAfterMs: 12_000, timeoutMs: 22_000 });
      setCoords({ lat: fix.lat, lng: fix.lng });
      const geo = await geoApi.reverse(fix.lat, fix.lng).catch(() => null);
      const label = friendlyLocationLabel(geo);
      roadLabelRef.current = label;
      roadGridRef.current = `${fix.lat.toFixed(3)},${fix.lng.toFixed(3)}`;
      setLocLabel(`📍 ${label}`);
      lastAccuracyRef.current = fix.accuracy;
      riderApi.ping(fix.lat, fix.lng, fix.accuracy).catch(() => {});
      // Persist server-side too (works even before admin verification, when
      // ping is still 403) so other devices can show this location.
      void savedLocationApi.save(fix.lat, fix.lng, fix.accuracy);
      return true;
    } catch (err) {
      setError(locationErrorMessage(err));
      return false;
    } finally {
      setLocBusy(false);
    }
  }, []);

  // No live fix yet (fresh page load / GPS-less desktop) → show the last
  // location saved server-side (mobile Locate-me / last ping) on the pill.
  useEffect(() => {
    if (!me || coords) return;
    let cancelled = false;
    savedLocationApi.get().then((saved) => {
      if (!cancelled && saved && !coords) setLocLabel(`সর্বশেষ: ${saved.label}`);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  // Verification gate — mirror mobile-rider logic. Rider cannot go online
  // until admin approves (verification_status === "verified").
  const isVerified = ((): boolean => {
    const p = me?.profile;
    if (!p) return false;
    if (typeof p.verification_status === "string") return p.verification_status === "verified";
    return !!p.is_verified;
  })();

  // If verification is revoked / pending, force OFFLINE.
  useEffect(() => {
    if (!isVerified && online) setOnline(false);
  }, [isVerified, online]);

  const toggleOnline = () => {
    if (!isVerified) {
      setError("Verification পেন্ডিং — admin approve করার পর online হতে পারবেন।");
      return;
    }
    if (!online && !coords) {
      void onLocateMe().then((ok) => {
        if (ok) setOnline(true);
      });
      return;
    }
    setOnline((v) => !v);
  };

  const onAccept = async (offerId: string) => {
    try {
      await riderApi.accept(offerId);
      const [o, a] = await Promise.all([riderApi.offers(), riderApi.activeOrders()]);
      setOffers(o.items);
      setActive(a.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Accept failed");
    }
  };

  const p = me?.profile ?? {};
  const verified = isVerified;
  const photo = p.profile_photo_url || null;
  const verifyStatus = (p.verification_status as string | undefined) ?? (p.is_verified ? "verified" : "pending");
  const verifyNote = p.verification_note ?? null;

  return (
    <main className="min-h-screen bg-gradient-to-br from-brand-50 via-white to-brand-100 dark:from-[#070b12] dark:via-[#0b1018] dark:to-[#091622]">
      <header className="sticky top-0 z-30 border-b border-black/5 dark:border-white/10 bg-white/80 dark:bg-[#0b1018]/80 backdrop-blur">
        <div className="flex w-full items-center justify-between gap-3 px-4 py-3 lg:px-6">
          <BrandLogo className="h-14 w-auto" />

          <div className="flex items-center justify-end gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => void onLocateMe()}
              disabled={locBusy}
              className="inline-flex items-center gap-1.5 rounded-full border border-black/10 dark:border-white/10 bg-white/70 dark:bg-white/5 px-3 py-1.5 text-xs font-medium hover:bg-white disabled:opacity-60"
              title={locLabel}
            >
              <MapPin size={14} className={locBusy ? "animate-pulse" : ""} />
              <span className="max-w-[180px] truncate">{locLabel}</span>
            </button>

            <button
              type="button"
              onClick={toggleOnline}
              disabled={!isVerified}
              title={!isVerified ? "Verification পেন্ডিং — admin approve করার পর online হতে পারবেন।" : undefined}
              className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-bold transition ${
                !isVerified
                  ? "cursor-not-allowed bg-slate-200/70 text-slate-400 dark:bg-white/5 dark:text-slate-500"
                  : online
                  ? "bg-emerald-500 text-white shadow-lg shadow-emerald-500/30"
                  : "bg-gray-300 dark:bg-white/10 text-gray-700 dark:text-gray-200"
              }`}
            >
              <Power size={13} /> {!isVerified ? "LOCKED" : locBusy && !online ? "Locating…" : online ? "ONLINE" : "OFFLINE"}
            </button>

            {/* Desktop secondary controls (unchanged) */}
            <div className="hidden items-center gap-2 sm:flex">
              <ThemeToggle />
              <button
                onClick={() => {
                  setOpeningProfile(true);
                  router.push("/rider/profile");
                }}
                disabled={openingProfile}
                className="inline-flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1.5 text-xs font-semibold hover:bg-black/10 transition disabled:opacity-70 dark:bg-white/10 dark:hover:bg-white/20"
              >
                {openingProfile ? <Loader2 size={13} className="animate-spin" /> : <Wallet size={13} />} {openingProfile ? "Opening…" : "My profile"}
              </button>
              <button
                onClick={onLogout}
                disabled={loggingOut}
                className="inline-flex items-center gap-1.5 rounded-full glass px-3 py-1.5 text-xs font-medium hover:scale-105 transition disabled:opacity-60 disabled:hover:scale-100"
              >
                {loggingOut ? <Loader2 size={13} className="animate-spin" /> : <LogOut size={13} />} {loggingOut ? "Logging out…" : "Logout"}
              </button>
            </div>

            {/* Mobile: single overflow menu (G2) */}
            <div className="sm:hidden">
              <HeaderMenu>
                <HeaderMenuItem
                  icon={<Wallet size={16} />}
                  label="My profile"
                  onClick={() => {
                    setOpeningProfile(true);
                    router.push("/rider/profile");
                  }}
                />
                <ThemeMenuItem />
                <HeaderMenuItem icon={<LogOut size={16} />} label="Logout" danger onClick={onLogout} />
              </HeaderMenu>
            </div>
          </div>
        </div>
      </header>

      <section className="grid w-full grid-cols-1 gap-6 px-4 pt-6 pb-28 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)_minmax(0,1fr)] lg:px-6 sm:pb-6">
        {me && (
          <motion.div
            initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
            className={`overflow-hidden rounded-3xl border border-black/5 dark:border-white/10 bg-white/70 dark:bg-white/5 backdrop-blur shadow-xl h-fit ${active.length > 0 ? "order-3 lg:order-none" : ""}`}
          >
            <div className="relative">
              <div className="h-24 bg-gradient-to-r from-brand-400 to-brand-700" />
            </div>
            <div className="-mt-12 px-5 pb-5">
              {/* Standard avatar overlapping the banner, name on its own line
                  below — left-aligned & never cramped beside the avatar (R3). */}
              <div className="relative h-20 w-20 overflow-hidden rounded-full border-4 border-white dark:border-[#0b1018] bg-white shadow-lg">
                {photo ? (
                  <Image src={photo} alt="profile" fill className="object-cover" sizes="80px" unoptimized />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-brand-100 text-brand-700">
                    <User size={24} />
                  </div>
                )}
              </div>
              <div className="mt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-xl font-extrabold leading-tight break-words">
                    {p.nick_name || p.full_name || "—"}
                  </h1>
                  {verified ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/90 px-2 py-0.5 text-[10px] font-semibold text-white">
                      <BadgeCheck size={11} /> Verified
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/90 px-2 py-0.5 text-[10px] font-semibold text-white">
                      Pending
                    </span>
                  )}
                </div>
                {p.full_name && p.nick_name && p.full_name !== p.nick_name && (
                  <p className="text-xs opacity-70 truncate">{p.full_name}</p>
                )}
                <p className="text-xs opacity-70">MediDoor rider</p>
              </div>

              <div className="mt-4 grid gap-3">
                <InfoRow Icon={Mail}        label="Email"      value={me.gmail} />
                <InfoRow Icon={Phone}       label="Phone"      value={p.phone_number} />
                <InfoRow Icon={Calendar}    label="Age"        value={p.age ? String(p.age) : null} />
                <InfoRow Icon={IdCard}      label="NID"        value={p.nid_number} />
                <InfoRow Icon={Bike}        label="Role"       value="Rider" />
              </div>
            </div>
          </motion.div>
        )}

        <div id="offers" className={`space-y-4 scroll-mt-24 lg:col-span-1 ${active.length > 0 ? "order-2 lg:order-none" : ""}`}>
          {!isVerified && (
            <div className={`rounded-xl border px-3 py-3 text-sm ${
              verifyStatus === "rejected"
                ? "border-red-300/50 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
                : "border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200"
            }`}>
              <div className="font-bold">
                {verifyStatus === "rejected" ? "❌ Verification Rejected" : "⏳ Verification Pending"}
              </div>
              <div className="mt-1 text-xs">
                {verifyStatus === "rejected"
                  ? "আপনার rider verification reject হয়েছে। নিচের note দেখুন এবং profile update করে আবার submit করুন।"
                  : "Admin আপনার documents review করছেন। Approve হলে আপনি ONLINE হয়ে offer accept করতে পারবেন।"}
              </div>
              {verifyNote && (
                <div className="mt-2 rounded-lg bg-white/60 dark:bg-black/20 px-2 py-1 text-xs">
                  📝 <b>Admin note:</b> {verifyNote}
                </div>
              )}
            </div>
          )}
          {error && (
            <p className="rounded-xl border border-red-300/50 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Package size={16} className="text-brand-600 dark:text-brand-300" />
            <h2 className="text-sm font-bold uppercase tracking-wider">New offers</h2>
            {offers.length > 0 && (
              <span className="rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-bold text-white">
                {offers.length}
              </span>
            )}
          </div>
          <div className="space-y-3">
            {!online && (
              <div className="rounded-2xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm">
                {!coords ? (
                  <>
                    🔴 এখন <b>OFFLINE</b>। Online হতে আপনার <b>location</b> দরকার — ওপরের <b>OFFLINE</b> button চাপুন,
                    permission দিলে নিজে থেকেই location নিয়ে আপনি online হয়ে যাবেন। (চাইলে আগে <b>“Locate me”</b> চেপেও location দিতে পারেন।)
                  </>
                ) : (
                  <>Online না হলে নতুন offer আসবে না। ওপরে <b>OFFLINE</b> button-এ tap করে duty শুরু করুন।</>
                )}
              </div>
            )}
            {online && offers.length === 0 && (
              <div className="rounded-2xl border border-black/5 dark:border-white/10 bg-white/60 dark:bg-white/5 p-6 text-center text-sm opacity-70">
                নতুন offer-এর অপেক্ষায়… কাছাকাছি pharmacy থেকে order এলে এখানে দেখাবে।
              </div>
            )}
            {offers.map((o) => (
              <OfferCard key={o.id} offer={o} rider={coords} onAccept={() => onAccept(o.id)} />
            ))}
          </div>
        </div>

        <div id="active" className={`space-y-4 scroll-mt-24 ${active.length > 0 ? "order-1 lg:order-none" : ""}`}>
          <div className="flex items-center gap-2">
            <Truck size={16} className="text-emerald-600 dark:text-emerald-300" />
            <h2 className="text-sm font-bold uppercase tracking-wider">Active</h2>
            {active.length > 0 && (
              <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold text-white">
                {active.length}
              </span>
            )}
          </div>
          <div className="space-y-3">
            {active.length === 0 && (
              <div className="rounded-2xl border border-black/5 dark:border-white/10 bg-white/60 dark:bg-white/5 p-6 text-center text-sm opacity-70">
                কোনো active delivery নেই।
              </div>
            )}
            {active.map((o) => (
              <ActiveOrderCard
                key={o.id}
                order={o}
                rider={coords}
                onOpenChat={() => {
                  // Open the global 3-party MessengerDock for this order's
                  // conversation. The legacy per-order RiderMessengerDock
                  // popover was removed to avoid showing two chats for the
                  // same delivery.
                  if (o.conversation_id) {
                    window.dispatchEvent(
                      new CustomEvent("medidoor-open-chat", {
                        detail: { conversation_id: o.conversation_id },
                      }),
                    );
                  }
                }}
              />
            ))}
          </div>
        </div>
      </section>

      {/* Global messenger dock: rider sees the customer↔pharmacy chat
          for any conversation they have accepted (rider_id == this rider). */}
      <MessengerDock />

      {/* Mobile bottom tab bar (G3) */}
      <MobileTabBar
        tabs={[
          {
            key: "duty",
            label: "Duty",
            icon: <Package size={20} />,
            onClick: () =>
              document.getElementById("offers")?.scrollIntoView({ behavior: "smooth", block: "start" }),
            badge: offers.length,
          },
          {
            key: "active",
            label: "Active",
            icon: <Truck size={20} />,
            onClick: () =>
              document.getElementById("active")?.scrollIntoView({ behavior: "smooth", block: "start" }),
            badge: active.length,
          },
          {
            key: "profile",
            label: "Profile",
            icon: <User size={20} />,
            onClick: () => {
              setOpeningProfile(true);
              router.push("/rider/profile");
            },
          },
        ]}
      />
    </main>
  );
}

function InfoRow({
  Icon, label, value,
}: { Icon: React.ComponentType<{ size?: number | string }>; label: string; value?: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-black/5 dark:border-white/10 bg-white/60 dark:bg-white/5 px-3 py-2">
      <span className="inline-flex items-center gap-2 text-xs uppercase tracking-wider opacity-60">
        <Icon size={13} /> {label}
      </span>
      <span className="text-sm font-medium truncate max-w-[60%]">{value || "—"}</span>
    </div>
  );
}

function OfferCard({
  offer, rider, onAccept,
}: {
  offer: RiderOffer;
  rider: { lat: number; lng: number } | null;
  onAccept: () => void;
}) {
  const pickup = offer.pickup;
  const drop = offer.drop;
  const mapsLink = (lat?: number | null, lng?: number | null, q?: string | null) =>
    lat != null && lng != null
      ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
      : q
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
      : null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-brand-300/40 bg-gradient-to-br from-brand-50 to-white dark:from-brand-950/40 dark:to-white/5 p-4 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider opacity-60">Order</p>
          <p className="font-mono text-sm">#{offer.order_id.slice(0, 8)}</p>
          <p className="mt-2 text-xs opacity-80">
            <MapPin size={11} className="inline" /> {offer.distance_km} km away
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wider opacity-60">Payout</p>
          <p className="text-2xl font-extrabold text-brand-700 dark:text-brand-300">৳{offer.payout_amount}</p>
        </div>
      </div>

      <DeliveryMiniMap
        rider={rider}
        pickup={pickup ?? null}
        drop={drop ?? null}
        mode="offer"
        title="Pickup route"
      />

      {/* Pickup → Drop summary */}
      <div className="mt-3 space-y-2 rounded-xl bg-white/60 dark:bg-white/5 p-2.5 text-xs">
        {pickup && (
          <div className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-white">P</span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold truncate">{pickup.name}</p>
              {pickup.address && <p className="opacity-70 truncate">{pickup.address}</p>}
              <div className="mt-0.5 flex items-center gap-2 text-[10px]">
                {pickup.phone && <a href={`tel:${pickup.phone}`} className="text-brand-600 dark:text-brand-300">📞 {pickup.phone}</a>}
                {mapsLink(pickup.lat, pickup.lng, pickup.address) && (
                  <a target="_blank" rel="noreferrer" href={mapsLink(pickup.lat, pickup.lng, pickup.address)!} className="text-brand-600 dark:text-brand-300">
                    🗺 Map
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
        {drop && (
          <div className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white">D</span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold truncate">{drop.name}</p>
              {drop.address && <p className="opacity-70 truncate">{drop.address}</p>}
              <div className="mt-0.5 flex items-center gap-2 text-[10px]">
                {drop.phone && <a href={`tel:${drop.phone}`} className="text-brand-600 dark:text-brand-300">📞 {drop.phone}</a>}
                {mapsLink(drop.lat, drop.lng, drop.address) && (
                  <a target="_blank" rel="noreferrer" href={mapsLink(drop.lat, drop.lng, drop.address)!} className="text-brand-600 dark:text-brand-300">
                    🗺 Map
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
        {offer.total != null && (
          <p className="border-t border-black/5 dark:border-white/10 pt-1.5 text-[10px] opacity-70">
            Order total: ৳{offer.total}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={onAccept}
        className="mt-3 w-full rounded-xl bg-emerald-500 py-2.5 text-sm font-bold text-white hover:bg-emerald-600 transition"
      >
        <Check size={15} className="inline mr-1" /> Accept
      </button>
    </motion.div>
  );
}

function DeliveryMiniMap({
  rider,
  pickup,
  drop,
  mode,
  title,
}: {
  rider: { lat: number; lng: number } | null;
  pickup?: {
    pharmacy_id?: string;
    name: string;
    address: string | null;
    lat: number | null;
    lng: number | null;
    phone: string | null;
    banner_photo_url?: string | null;
  } | null;
  drop?: {
    name: string;
    address: string | null;
    phone: string | null;
    lat?: number | null;
    lng?: number | null;
    profile_photo_url?: string | null;
  } | null;
  mode: "offer" | "active";
  title: string;
}) {
  const [route, setRoute] = useState<string | null>(null);
  const pickupPoint = pickup?.lat != null && pickup.lng != null ? { lat: pickup.lat, lng: pickup.lng } : null;
  const dropPoint = drop?.lat != null && drop.lng != null ? { lat: drop.lat, lng: drop.lng } : null;
  const target = pickupPoint && dropPoint ? dropPoint : mode === "active" ? (dropPoint ?? pickupPoint) : (pickupPoint ?? dropPoint);

  useEffect(() => {
    const start = pickupPoint ?? rider;
    if (!start || !target) { setRoute(null); return; }
    let cancelled = false;
    geoApi.route(start, target)
      .then((r) => { if (!cancelled) setRoute(r.geometry); })
      .catch(() => { if (!cancelled) setRoute(null); });
    return () => { cancelled = true; };
  }, [rider?.lat, rider?.lng, pickupPoint?.lat, pickupPoint?.lng, target?.lat, target?.lng]);

  if (!rider && !pickupPoint && !dropPoint) return null;

  const markers = [
    pickupPoint && pickup && {
      id: pickup.pharmacy_id ?? `pickup-${pickup.name}`,
      name: `Pickup: ${pickup.name}`,
      business_name: "Pharmacy",
      address: pickup.address,
      phone: pickup.phone,
      lat: pickupPoint.lat,
      lng: pickupPoint.lng,
      rating: 0,
      rating_count: 0,
      is_verified: true,
      is_open: true,
      banner_photo_url: pickup.banner_photo_url || null,
    },
  ].filter(Boolean) as import("@/lib/geo").PharmacyMarker[];

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-black/5 bg-white/70 dark:border-white/10 dark:bg-white/5">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px]">
        <span className="inline-flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-100">
          <MapPin size={12} className="text-brand-600 dark:text-brand-300" /> {title}
        </span>
        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-semibold text-emerald-700 dark:text-emerald-300">
          {mode === "offer" ? "Offer map" : "Live route"}
        </span>
      </div>
      <div className="h-40 sm:h-56">
        <MediMap
          height="100%"
          center={rider ?? pickupPoint ?? dropPoint}
          zoom={14}
          userLocation={rider}
          userLabel="Rider live location"
          customerLocation={dropPoint}
          customerLabel={drop?.name ? `Customer: ${drop.name}` : "Customer"}
          customerAvatarUrl={drop?.profile_photo_url ?? null}
          customerFallbackImageUrl="/brand/logo-outside-bg.png"
          pharmacies={markers}
          routePolyline={route}
          pickEnabled={false}
          showSearch={false}
          showLocateButton={false}
        />
      </div>
    </div>
  );
}

/* ----------------------------- live trip map ------------------------------ */
/**
 * Shows the rider's own location, the active order's pickup (pharmacy) and
 * drop (customer), and a route polyline between them. When there's no active
 * order, just shows the rider's location and nearby pharmacies as context.
 */
function RiderTripMap({
  rider,
  active,
}: {
  rider: { lat: number; lng: number } | null;
  active: RiderOrder | null;
}) {
  const [route, setRoute] = useState<string | null>(null);
  const [pharmacy, setPharmacy] = useState<{ lat: number; lng: number; name: string } | null>(null);

  // Pull the pickup pharmacy's coords from the track endpoint (also used by
  // pharmacy + customer for live tracking).
  useEffect(() => {
    if (!active) { setPharmacy(null); setRoute(null); return; }
    let cancelled = false;
    async function load() {
      try {
        const t = await geoApi.track(active!.id);
        if (cancelled) return;
        if (t.pharmacy.lat != null && t.pharmacy.lng != null) {
          setPharmacy({ lat: t.pharmacy.lat, lng: t.pharmacy.lng, name: t.pharmacy.name ?? "Pharmacy" });
        }
      } catch { /* ignore */ }
    }
    load();
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute route: rider → pickup → drop. We draw the most useful single leg:
  // before pickup → rider→pickup; after pickup (status = dispatched but
  // we don't track pickup explicitly here, so prefer pickup→drop when both
  // pharmacy + drop exist).
  useEffect(() => {
    if (!rider || !active) { setRoute(null); return; }
    let cancelled = false;
    async function build() {
      try {
        const drop = active!.delivery_lat != null && active!.delivery_lng != null
          ? { lat: active!.delivery_lat, lng: active!.delivery_lng }
          : null;
        const target = pharmacy ?? drop;
        if (!target) return;
        const r = await geoApi.route(rider!, target);
        if (!cancelled) setRoute(r.geometry);
      } catch { /* ignore */ }
    }
    build();
  }, [rider?.lat, rider?.lng, pharmacy?.lat, pharmacy?.lng, active?.id]); // eslint-disable-line

  if (!rider && !active) return null;

  const center = rider ?? pharmacy ?? null;
  const drop = active && active.delivery_lat != null && active.delivery_lng != null
    ? { lat: active.delivery_lat, lng: active.delivery_lng }
    : null;

  // Render pickup + drop as pharmacy-style markers (reuse the pharmacy pin look).
  const markers = [
    pharmacy && {
      id: `pickup-${active?.id ?? "x"}`,
      name: `🏪 Pickup: ${pharmacy.name}`,
      address: null,
      phone: null,
      lat: pharmacy.lat,
      lng: pharmacy.lng,
      rating: 0,
      rating_count: 0,
      is_verified: false,
      is_open: true,
      banner_photo_url: null,
    },
    drop && active && {
      id: `drop-${active.id}`,
      name: `🎯 Drop: ${active.customer_name}`,
      address: active.delivery_address,
      phone: active.customer_phone,
      lat: drop.lat,
      lng: drop.lng,
      rating: 0,
      rating_count: 0,
      is_verified: false,
      is_open: false, // grey pin to distinguish drop
      banner_photo_url: null,
    },
  ].filter(Boolean) as import("@/lib/geo").PharmacyMarker[];

  return (
    <div className="overflow-hidden rounded-3xl border border-black/5 dark:border-white/10 bg-white/60 dark:bg-white/5 backdrop-blur shadow-md">
      <div className="flex items-center justify-between gap-2 border-b border-black/5 dark:border-white/10 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <MapPin size={14} className="text-brand-600 dark:text-brand-300" />
          {active ? `Trip · #${active.id.slice(0, 8)}` : "Your location"}
        </div>
        {active && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            Live
          </span>
        )}
      </div>
      <div className="h-[220px] sm:h-[320px]">
        <MediMap
          height="100%"
          center={center}
          userLocation={rider}
          userLabel="You"
          pharmacies={markers}
          routePolyline={route}
          pickEnabled={false}
          showSearch={false}
        />
      </div>
    </div>
  );
}

function ActiveOrderCard({
  order, rider, onOpenChat,
}: { order: RiderOrder; rider: { lat: number; lng: number } | null; onOpenChat: () => void }) {
  return (
    <div className="rounded-2xl border border-emerald-300/40 bg-white/70 dark:bg-white/5 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider opacity-60">Customer</p>
          <p className="font-semibold">{order.customer_name}</p>
          <p className="text-xs opacity-70">{order.customer_phone}</p>
          <p className="mt-2 text-xs opacity-80">
            <MapPin size={11} className="inline" /> {order.delivery_address}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wider opacity-60">Total</p>
          <p className="text-lg font-bold">৳{order.total}</p>
          <p className="text-[10px] opacity-60">status: {order.status}</p>
        </div>
      </div>
      <DeliveryMiniMap
        rider={rider}
        pickup={order.pickup ?? null}
        drop={{
          name: order.customer_name,
          address: order.delivery_address,
          phone: order.customer_phone,
          lat: order.delivery_lat,
          lng: order.delivery_lng,
          profile_photo_url: order.customer_profile_photo_url ?? null,
        }}
        mode="active"
        title="Active delivery route"
      />
      <button
        type="button"
        onClick={onOpenChat}
        className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600"
      >
        <MessageCircle size={13} /> Open chat & status
      </button>
    </div>
  );
}

function RiderMessengerDock({
  orderId, onClose, onStatusChange,
}: { orderId: string; onClose: () => void; onStatusChange: () => void }) {
  const [msgs, setMsgs] = useState<RiderOrderMessage[]>([]);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await riderApi.messages(orderId);
      setMsgs(data.items);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    }
  }, [orderId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs.length]);

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setSending(true);
    try {
      await riderApi.sendMessage(orderId, text);
      setBody("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  };

  const doPickup = async () => {
    setActionBusy("pickup");
    try {
      await riderApi.pickedUp(orderId);
      await refresh();
      onStatusChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Pickup failed");
    } finally {
      setActionBusy(null);
    }
  };

  const doDeliver = async () => {
    setActionBusy("deliver");
    try {
      await riderApi.delivered(orderId);
      await refresh();
      onStatusChange();
      setTimeout(onClose, 1200);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Deliver failed");
    } finally {
      setActionBusy(null);
    }
  };

  const hasPickedUp = msgs.some((m) => m.preset_key === "picked_up");

  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 30 }}
      className="fixed bottom-4 right-4 z-50 flex h-[520px] w-[380px] max-w-[calc(100vw-2rem)] flex-col rounded-2xl border border-black/10 dark:border-white/10 bg-white dark:bg-[#0b1018] shadow-2xl overflow-hidden"
    >
      <div className="flex items-center justify-between border-b border-black/5 dark:border-white/10 bg-brand-500 px-4 py-2.5 text-white">
        <div className="flex items-center gap-2">
          <MessageCircle size={16} />
          <span className="text-sm font-semibold">Order #{orderId.slice(0, 8)}</span>
        </div>
        <button onClick={onClose} className="rounded-full p-1 hover:bg-white/10">
          <X size={16} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto bg-gray-50 dark:bg-white/5 px-3 py-3">
        {msgs.map((m) => (
          <div
            key={m.id}
            className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-[12px] ${
              m.sender_role === "rider"
                ? "ml-auto bg-brand-500 text-white"
                : m.sender_role === "system"
                  ? "mx-auto bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 text-center"
                  : "bg-white border border-black/5 dark:bg-white/10 dark:border-white/10"
            }`}
          >
            {m.sender_role !== "rider" && m.sender_role !== "system" && (
              <p className="text-[9px] uppercase opacity-60 mb-0.5">{m.sender_role}</p>
            )}
            <p>{m.body}</p>
          </div>
        ))}
        {msgs.length === 0 && (
          <p className="text-center text-xs opacity-60 mt-4">No messages yet.</p>
        )}
      </div>

      {err && (
        <p className="bg-rose-100 px-3 py-1 text-[11px] text-rose-700">{err}</p>
      )}

      <div className="flex gap-1.5 border-t border-black/5 dark:border-white/10 bg-emerald-500/5 px-2 py-2">
        {!hasPickedUp ? (
          <button
            type="button"
            onClick={doPickup}
            disabled={actionBusy === "pickup"}
            className="inline-flex items-center gap-1 rounded-full bg-amber-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
          >
            <Truck size={11} /> Picked up
          </button>
        ) : (
          <button
            type="button"
            onClick={doDeliver}
            disabled={actionBusy === "deliver"}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-600 disabled:opacity-60"
          >
            <Check size={11} /> Delivered
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-black/5 dark:border-white/10 px-2 py-2">
        <input
          type="text"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          placeholder="Message customer/pharmacy…"
          className="flex-1 rounded-full border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-brand-400"
        />
        <button
          type="button"
          onClick={send}
          disabled={sending || !body.trim()}
          className="rounded-full bg-brand-500 p-2 text-white hover:bg-brand-600 disabled:opacity-60"
        >
          <Send size={13} />
        </button>
      </div>
    </motion.div>
  );
}
