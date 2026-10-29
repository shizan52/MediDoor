"use client";

/**
 * Rider home dashboard.
 *
 *  • ONLINE / OFFLINE toggle (geolocation watchPosition kicks in only when online)
 *  • Locate-me pill — single high-accuracy fix via getPreciseLocation()
 *  • Ping loop (30s) keeps the rider's coordinates fresh on the backend
 *  • Offers section (5s poll) — accept-able offers within range
 *  • Active section (7s poll) — currently assigned deliveries with quick actions
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bike, Check, Loader2, MapPin, MessageCircle, Package, Phone, Power,
  RefreshCw, Truck, Bell,
} from "lucide-react";
import { api, session, type Role, resolveMediaUrl } from "@/lib/api";
import { riderApi, type RiderOffer, type RiderOrder } from "@/lib/rider";
import {
  friendlyLocationLabel, geoApi, getPreciseLocation, googleMapsLink,
  locationErrorMessage, savedLocationApi,
  LOCATION_DEVICE_UNAVAILABLE_MESSAGE, MAX_FIX_ACCURACY_M,
} from "@/lib/geo";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { OfferMiniMap } from "@/components/offer-mini-map";

type RiderProfile = {
  full_name?: string;
  nick_name?: string | null;
  profile_photo_url?: string | null;
  is_verified?: boolean;
  verification_status?: "pending" | "verified" | "rejected" | null;
  verification_note?: string | null;
  verification_reviewed_at?: string | null;
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

export default function HomePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [online, setOnline] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  // Last accepted GPS accuracy (m) — sent with pings so the backend can
  // reject coarse fixes.
  const lastAccuracyRef = useRef<number | null>(null);
  const [locLabel, setLocLabel] = useState("লোকেশন নিন");
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

  const [offers, setOffers] = useState<RiderOffer[]>([]);
  const [active, setActive] = useState<RiderOrder[]>([]);
  const [accepting, setAccepting] = useState<string | null>(null);
  // Bell badge for /notifications inbox.
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    if (!me) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await api<{ unread: number }>("/api/notifications/me?limit=1");
        if (alive) setUnreadCount(r.unread || 0);
      } catch {}
    };
    void tick();
    const id = setInterval(tick, 20_000);
    return () => { alive = false; clearInterval(id); };
  }, [me]);

  // Auth gate + me
  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    api<Me>("/api/auth/me")
      .then((d) => {
        if (d.role !== "rider") { router.replace("/login?msg=wrong-role"); return; }
        if (!d.is_registered) {
          window.location.href =
            `${process.env.NEXT_PUBLIC_WEBSITE_URL ?? "http://localhost:3000"}/register/rider`;
          return;
        }
        setMe(d);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, [router]);

  // Geolocation watcher (only when ONLINE)
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
          // Pin-point gate: coarser than 1 km = IP/coarse-WiFi lookup, not
          // GPS — never track or ping it.
          if (acc > MAX_FIX_ACCURACY_M) return;
          if (bestAcc < 100 && acc > 200) return;
          if (acc < bestAcc) bestAcc = acc;
          gotUsableFix = true;
          lastAccuracyRef.current = acc;
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          setCoords({ lat, lng });
          // Show the written place name, not bare numbers.
          setLocLabel(roadLabelRef.current ? `📍 ${roadLabelRef.current}` : `±${Math.round(acc)} m`);
          void refreshRoadLabel(lat, lng).then((label) => {
            if (label) setLocLabel(`📍 ${label}`);
          });
        },
        (err) => {
          if (highAccuracy && (err.code === 3 || err.code === 2)) {
            if (watchId !== null) navigator.geolocation.clearWatch(watchId);
            start(false);
          } else {
            setError(locationErrorMessage(err));
            setOnline(false);
          }
        },
        { enableHighAccuracy: highAccuracy, maximumAge: 5_000, timeout: highAccuracy ? 15_000 : 30_000 },
      );
    };
    start(true);
    // No usable (≤1 km) fix within the grace window → GPS-less device.
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

  // Ping loop
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

  // Offers poll
  useEffect(() => {
    if (!online) { setOffers([]); return; }
    let cancelled = false;
    const tick = () => riderApi.offers()
      .then((d) => { if (!cancelled) setOffers(d.items); })
      .catch(() => {});
    tick();
    const t = setInterval(tick, OFFERS_POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [online]);

  // Active poll (always)
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    const tick = () => riderApi.activeOrders()
      .then((d) => { if (!cancelled) setActive(d.items); })
      .catch(() => {});
    tick();
    const t = setInterval(tick, ACTIVE_POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [me]);

  const onLocateMe = useCallback(async (): Promise<boolean> => {
    setError(null);
    setLocBusy(true);
    try {
      const fix = await getPreciseLocation({ desiredAccuracyM: 25, bestEffortAfterMs: 12_000, timeoutMs: 22_000 });
      setCoords({ lat: fix.lat, lng: fix.lng });
      lastAccuracyRef.current = fix.accuracy;
      const geo = await geoApi.reverse(fix.lat, fix.lng).catch(() => null);
      const label = friendlyLocationLabel(geo);
      roadLabelRef.current = label;
      roadGridRef.current = `${fix.lat.toFixed(3)},${fix.lng.toFixed(3)}`;
      setLocLabel(`📍 ${label}`);
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

  // No live fix yet (fresh app open / GPS-less device) → show the last
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

  // Verification gate — pending or rejected riders cannot go online.
  const verificationStatus =
    me?.profile?.verification_status ?? (me?.profile?.is_verified ? "verified" : "pending");
  const isVerified = verificationStatus === "verified";

  // Force OFFLINE whenever the rider is not verified (e.g. admin just rejected
  // them mid-session). Without this the toggle could remain stuck in ONLINE.
  useEffect(() => {
    if (!isVerified && online) setOnline(false);
  }, [isVerified, online]);

  const toggleOnline = () => {
    if (!isVerified) {
      setError(
        verificationStatus === "rejected"
          ? "আপনার documents reject হয়েছে — Messages tab দেখুন এবং documents আবার submit করুন।"
          : "আপনার details এখনো MediDoor admin checking করছে। Approve হলে online হতে পারবেন।",
      );
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
    setAccepting(offerId);
    try {
      await riderApi.accept(offerId);
      const [o, a] = await Promise.all([riderApi.offers(), riderApi.activeOrders()]);
      setOffers(o.items);
      setActive(a.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Accept failed");
    } finally { setAccepting(null); }
  };

  const photo = me?.profile?.profile_photo_url || null;

  return (
    <main
      className="min-h-full bg-gradient-to-b from-brand-50/60 via-white to-white dark:from-[#0b1018] dark:via-[#070b12] dark:to-[#070b12]"
      style={{
        // This page has NO fixed <MobileHeader>, but `.app-scroll` (globals.css)
        // unconditionally reserves `header-h + safe-top` of padding-top for
        // pages that DO have one — cancel that reservation here, then apply
        // only the small top offset this custom in-flow header actually needs.
        marginTop: "calc(-1 * (var(--header-h) + var(--safe-top)))",
        paddingTop: "calc(var(--safe-top) + 8px)",
      }}
    >
      {/* Top bar */}
      <header className="px-4 pt-2">
        <div className="flex items-center justify-between">
          <BrandLogo className="h-8 w-auto" />
          <div className="flex items-center gap-1.5">
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
            <ThemeToggle />
            <Link
              href="/profile"
              className="tap relative h-9 w-9 overflow-hidden rounded-full ring-2 ring-brand-500/40"
              aria-label="Profile"
            >
              {photo ? (
                <Image src={photo} alt="me" fill sizes="36px" className="object-cover" />
              ) : (
                <span className="grid h-full w-full place-items-center bg-brand-500 text-xs font-bold text-white">
                  {(me?.profile?.nick_name || me?.profile?.full_name || "R").charAt(0).toUpperCase()}
                </span>
              )}
            </Link>
          </div>
        </div>

        {/* Verification gate — blocks going online until admin approves */}
        {me && !isVerified && (
          <div
            className={[
              "mt-3 overflow-hidden rounded-2xl border-2 shadow-lg",
              verificationStatus === "rejected"
                ? "border-rose-400 bg-gradient-to-br from-rose-50 to-rose-100 dark:border-rose-500/60 dark:from-rose-950/60 dark:to-rose-900/40"
                : "border-amber-400 bg-gradient-to-br from-amber-50 to-amber-100 dark:border-amber-500/60 dark:from-amber-950/60 dark:to-amber-900/40",
            ].join(" ")}
          >
            <div className="flex items-start gap-3 p-4">
              <div
                className={[
                  "grid h-12 w-12 shrink-0 place-items-center rounded-full text-2xl shadow-inner",
                  verificationStatus === "rejected" ? "bg-rose-500 text-white" : "bg-amber-500 text-white",
                ].join(" ")}
              >
                {verificationStatus === "rejected" ? "⛔" : "⏳"}
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className={[
                    "text-[14px] font-extrabold leading-tight",
                    verificationStatus === "rejected" ? "text-rose-700 dark:text-rose-200" : "text-amber-800 dark:text-amber-200",
                  ].join(" ")}
                >
                  {verificationStatus === "rejected"
                    ? "Verification reject হয়েছে"
                    : "আপনার details checking চলছে"}
                </p>
                <p
                  className={[
                    "mt-1 text-[12px] leading-snug",
                    verificationStatus === "rejected" ? "text-rose-700/90 dark:text-rose-200/90" : "text-amber-800/90 dark:text-amber-200/90",
                  ].join(" ")}
                >
                  {verificationStatus === "rejected"
                    ? (me.profile?.verification_note
                        ? `Reason: ${me.profile.verification_note}`
                        : "MediDoor admin আপনার documents গ্রহণ করেননি।")
                    : "MediDoor admin verify না করা পর্যন্ত আপনি online হতে পারবেন না বা delivery নিতে পারবেন না। Verify হলে notification পাবেন।"}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    href="/messages"
                    className="tap inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[11px] font-bold text-slate-700 shadow-sm dark:bg-white/15 dark:text-white"
                  >
                    <MessageCircle size={12} /> Admin কে message
                  </Link>
                  <Link
                    href="/notifications"
                    className="tap inline-flex items-center gap-1.5 rounded-full bg-white/70 px-3 py-1.5 text-[11px] font-semibold text-slate-700 shadow-sm dark:bg-white/10 dark:text-white"
                  >
                    নোটিফিকেশন
                  </Link>
                  {verificationStatus === "rejected" && (
                    <a
                      href={`${process.env.NEXT_PUBLIC_WEBSITE_URL ?? "http://localhost:3000"}/register/rider`}
                      className="tap inline-flex items-center gap-1.5 rounded-full bg-rose-500 px-3 py-1.5 text-[11px] font-bold text-white shadow-sm"
                    >
                      <RefreshCw size={12} /> Documents resubmit
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ONLINE / OFFLINE + Locate me */}
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={toggleOnline}
            disabled={!isVerified}
            title={!isVerified ? "Verification পেন্ডিং — admin approve করার পর online হতে পারবেন।" : undefined}
            className={[
              "tap inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold shadow-md transition",
              !isVerified
                ? "cursor-not-allowed bg-slate-200/70 text-slate-400 dark:bg-white/5 dark:text-slate-500"
                : online
                ? "bg-emerald-500 text-white shadow-emerald-500/30"
                : "bg-slate-200 text-slate-700 dark:bg-white/10 dark:text-slate-200",
            ].join(" ")}
          >
            {online && isVerified && <span className="online-dot" />}
            <Power size={14} />
            {!isVerified ? "লকড" : online ? "অনলাইন" : "অফলাইন"}
          </button>

          <button
            onClick={() => void onLocateMe()}
            disabled={locBusy}
            className="tap inline-flex flex-1 items-center justify-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-300"
            title={coords ? `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}` : "লোকেশন নিন"}
          >
            <MapPin size={13} className={locBusy ? "animate-pulse" : ""} />
            <span className="truncate">{locLabel}</span>
          </button>
        </div>
      </header>

      {error && (
        <p className="mx-4 mt-3 rounded-xl border border-rose-300/50 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/40 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </p>
      )}

      {!isVerified ? (
        // While verification is pending/rejected we replace the entire
        // operational area with a single locked placeholder so the rider
        // can't even *try* to look at offers / active deliveries.
        <section className="px-4 pt-6 pb-24">
          <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/60 p-6 text-center dark:border-white/10 dark:bg-white/[0.02]">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-slate-200 text-2xl text-slate-500 dark:bg-white/10">
              🔒
            </div>
            <p className="mt-3 text-[13px] font-bold text-slate-700 dark:text-slate-200">
              Dashboard locked
            </p>
            <p className="mx-auto mt-1 max-w-xs text-[11.5px] leading-snug text-slate-500 dark:text-slate-400">
              MediDoor admin আপনার documents verify করার পরই চলতি ডেলিভারি এবং নতুন অফার এখানে দেখতে পাবেন।
            </p>
          </div>
        </section>
      ) : (
        <>
      {/* Active deliveries */}
      <section className="px-4 pt-5">
        <div className="mb-2 flex items-center gap-2">
          <Truck size={15} className="text-emerald-600 dark:text-emerald-300" />
          <h2 className="text-[12px] font-bold tracking-wide">চলতি ডেলিভারি</h2>
          {active.length > 0 && (
            <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold text-white">
              {active.length}
            </span>
          )}
        </div>
        {active.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-5 text-center text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.02]">
            কোনো চলতি ডেলিভারি নেই।
          </div>
        ) : (
          <ul className="space-y-3">
            {active.map((o) => <ActiveOrderCard key={o.id} order={o} rider={coords} />)}
          </ul>
        )}
      </section>

      {/* New offers */}
      <section className="px-4 pt-5 pb-2">
        <div className="mb-2 flex items-center gap-2">
          <Package size={15} className="text-brand-600 dark:text-brand-300" />
          <h2 className="text-[12px] font-bold tracking-wide">নতুন অফার</h2>
          {offers.length > 0 && (
            <span className="rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-bold text-white">
              {offers.length}
            </span>
          )}
        </div>

        {!online ? (
          <div className="flex items-start gap-2 rounded-2xl border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200">
            <Bike size={14} className="mt-0.5 shrink-0" />
            <p>
              অনলাইন না হলে নতুন অফার আসবে না। ওপরে <b>অফলাইন</b> বাটনে tap করে ডিউটি শুরু করুন।
            </p>
          </div>
        ) : offers.length === 0 ? (
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-5 text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.02]">
            <RefreshCw size={12} className="animate-spin" /> নতুন offer-এর অপেক্ষায়…
          </div>
        ) : (
          <ul className="space-y-3">
            {offers.map((o) => (
              <OfferCard
                key={o.id}
                offer={o}
                rider={coords}
                accepting={accepting === o.id}
                onAccept={() => onAccept(o.id)}
              />
            ))}
          </ul>
        )}
      </section>
        </>
      )}
    </main>
  );
}

function OfferCard({
  offer, rider, accepting, onAccept,
}: { offer: RiderOffer; rider: { lat: number; lng: number } | null; accepting: boolean; onAccept: () => void }) {
  const pickup = offer.pickup;
  const drop = offer.drop;
  const pickupPt = pickup?.lat != null && pickup.lng != null ? { lat: pickup.lat, lng: pickup.lng } : null;
  const dropPt = drop?.lat != null && drop?.lng != null ? { lat: drop.lat, lng: drop.lng } : null;
  return (
    <li className="rounded-2xl border border-brand-300/40 bg-gradient-to-br from-brand-50 to-white p-3 shadow-sm dark:border-brand-500/30 dark:from-brand-950/40 dark:to-white/[0.03]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-500">অর্ডার</p>
          <p className="font-mono text-[13px] font-bold">#{offer.order_id.slice(0, 8)}</p>
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300">
            <MapPin size={11} /> {offer.distance_km} km
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wider text-slate-500">পেমেন্ট</p>
          <p className="text-2xl font-extrabold text-brand-700 dark:text-brand-300">৳{offer.payout_amount}</p>
        </div>
      </div>

      {(pickupPt || dropPt) && (
        <OfferMiniMap rider={rider} pickup={pickupPt} drop={dropPt} mode="offer" title="Pickup route" />
      )}

      <div className="mt-2 space-y-1.5 rounded-xl bg-white/70 p-2 text-[12px] dark:bg-white/[0.04]">
        {pickup && <Pin label="P" tone="emerald" name={pickup.name} address={pickup.address} phone={pickup.phone} lat={pickup.lat} lng={pickup.lng} />}
        {drop && <Pin label="D" tone="rose" name={drop.name} address={drop.address} phone={drop.phone} lat={drop.lat ?? null} lng={drop.lng ?? null} />}
        {offer.total != null && (
          <p className="border-t border-slate-200/60 pt-1 text-[10px] text-slate-500 dark:border-white/10">
            অর্ডার total: ৳{offer.total}
          </p>
        )}
      </div>

      <button
        onClick={onAccept}
        disabled={accepting}
        className="tap mt-3 inline-flex w-full items-center justify-center gap-1 rounded-xl bg-emerald-500 py-2.5 text-sm font-bold text-white shadow-md shadow-emerald-500/20 disabled:opacity-60"
      >
        {accepting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
        Accept করুন
      </button>
    </li>
  );
}

function ActiveOrderCard({ order, rider }: { order: RiderOrder; rider: { lat: number; lng: number } | null }) {
  const [busy, setBusy] = useState<"pickup" | "deliver" | null>(null);
  const [status, setStatus] = useState(order.status);
  const pickupPt = order.pickup?.lat != null && order.pickup.lng != null ? { lat: order.pickup.lat, lng: order.pickup.lng } : null;
  const dropPt = order.delivery_lat != null && order.delivery_lng != null ? { lat: order.delivery_lat, lng: order.delivery_lng } : null;
  const pickedUp = status === "picked_up" || status === "on_the_way" || status === "delivered";

  const onPickup = async () => {
    setBusy("pickup");
    try { await riderApi.pickedUp(order.id); setStatus("picked_up"); }
    catch {} finally { setBusy(null); }
  };
  const onDeliver = async () => {
    setBusy("deliver");
    try { await riderApi.delivered(order.id); setStatus("delivered"); }
    catch {} finally { setBusy(null); }
  };

  const statusTone =
    status === "delivered" ? "bg-emerald-500"
    : status === "on_the_way" ? "bg-blue-500"
    : status === "picked_up" ? "bg-purple-500"
    : "bg-amber-500";

  return (
    <li className="rounded-2xl border border-emerald-300/40 bg-white p-3 shadow-sm dark:border-emerald-500/30 dark:bg-white/[0.04]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[13px] font-bold">#{order.id.slice(0, 8)}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            ৳{order.total} • ফি ৳{order.delivery_fee}
          </p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white ${statusTone}`}>
          {status.replace(/_/g, " ")}
        </span>
      </div>

      {(pickupPt || dropPt) && (
        <OfferMiniMap
          rider={rider}
          pickup={pickupPt}
          drop={dropPt}
          mode={pickedUp ? "active" : "offer"}
          title={pickedUp ? "Drop route" : "Pickup route"}
        />
      )}

      <div className="mt-2 space-y-1.5 rounded-xl bg-slate-50 p-2 text-[12px] dark:bg-white/[0.03]">
        {order.pickup && (
          <Pin label="P" tone="emerald"
               name={order.pickup.name}
               address={order.pickup.address}
               phone={order.pickup.phone}
               lat={order.pickup.lat}
               lng={order.pickup.lng} />
        )}
        <Pin label="D" tone="rose"
             name={order.customer_name}
             address={order.delivery_address}
             phone={order.customer_phone}
             lat={order.delivery_lat}
             lng={order.delivery_lng} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1.5">
        {order.conversation_id && (
          <Link
            href={`/chats/${order.conversation_id}`}
            className="tap inline-flex items-center justify-center gap-1 rounded-xl border border-slate-200 bg-white py-2 text-[11px] font-semibold text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
          >
            <MessageCircle size={12} /> চ্যাট
          </Link>
        )}
        <button
          onClick={onPickup}
          disabled={busy === "pickup" || status !== "dispatched"}
          className="tap inline-flex items-center justify-center gap-1 rounded-xl bg-purple-500 py-2 text-[11px] font-bold text-white disabled:opacity-50"
        >
          {busy === "pickup" ? <Loader2 size={12} className="animate-spin" /> : <Package size={12} />}
          Pickup হয়েছে
        </button>
        <button
          onClick={onDeliver}
          disabled={busy === "deliver" || !pickedUp || status === "delivered"}
          className="tap inline-flex items-center justify-center gap-1 rounded-xl bg-emerald-500 py-2 text-[11px] font-bold text-white disabled:opacity-50"
          title={pickedUp ? "Complete delivery" : "Pickup আগে confirm করুন"}
        >
          {busy === "deliver" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          Delivered
        </button>
      </div>
    </li>
  );
}

function Pin({
  label, tone, name, address, phone, lat, lng,
}: {
  label: "P" | "D";
  tone: "emerald" | "rose";
  name: string;
  address: string | null;
  phone: string | null;
  lat: number | null;
  lng: number | null;
}) {
  const map = googleMapsLink(lat, lng, address);
  return (
    <div className="flex items-start gap-2">
      <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white ${
        tone === "emerald" ? "bg-emerald-500" : "bg-rose-500"
      }`}>{label}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-semibold">{name}</p>
        {address && <p className="truncate text-[10.5px] text-slate-500 dark:text-slate-400">{address}</p>}
        <div className="mt-0.5 flex items-center gap-2 text-[10.5px]">
          {phone && (
            <a href={`tel:${phone}`} className="inline-flex items-center gap-0.5 text-brand-600 dark:text-brand-300">
              <Phone size={10} /> {phone}
            </a>
          )}
          {map && (
            <a href={map} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand-600 dark:text-brand-300">
              <MapPin size={10} /> Map
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
