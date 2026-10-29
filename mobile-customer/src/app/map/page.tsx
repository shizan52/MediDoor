"use client";

/**
 * Mobile map page — full-screen MapLibre with bottom-sheet controls.
 * Reuses the same MediMap component as the website, but wraps it with a
 * mobile-native surface for nearby pharmacies and live order tracking.
 */
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Bike,
  Loader2,
  MapPin,
  MessageCircle,
  Navigation,
  Phone,
  RefreshCw,
  Star,
  Store,
} from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { MediMap, type MapPickResult } from "@/components/medi-map";
import {
  friendlyLocationLabel,
  geoApi,
  getPreciseLocation,
  locationErrorMessage,
  savedLocationApi,
  type PharmacyMarker,
  type TrackResponse,
} from "@/lib/geo";
import { userLocation, requestPharmacyChat } from "@/lib/storefront";

type LatLng = { lat: number; lng: number };

function distanceKm(a: LatLng | null, b: LatLng): number | null {
  if (!a) return null;
  const r = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function fmtKm(km: number | null): string {
  if (km == null) return "";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

function fmtSeen(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

export default function MapPage() {
  return (
    <Suspense
      fallback={
        <>
          <MobileHeader title="MediDoor map" subtitle="লোড হচ্ছে" back />
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-brand-500" />
          </div>
        </>
      }
    >
      <MapPageInner />
    </Suspense>
  );
}

function MapPageInner() {
  const router = useRouter();
  const search = useSearchParams();
  const focusLat = search?.get("lat");
  const focusLng = search?.get("lng");
  const focusPharmacyId = search?.get("pid");
  const orderId = search?.get("order_id") || search?.get("orderId");

  const [user, setUser] = useState<{ lat: number; lng: number } | null>(() => {
    if (focusLat && focusLng) return { lat: Number(focusLat), lng: Number(focusLng) };
    const cached = userLocation.load();
    return cached ? { lat: cached.lat, lng: cached.lng } : null;
  });
  const [pharms, setPharms] = useState<PharmacyMarker[]>([]);
  const [selected, setSelected] = useState<PharmacyMarker | null>(null);
  const [track, setTrack] = useState<TrackResponse | null>(null);
  const [route, setRoute] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locationNotice, setLocationNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Try to upgrade the cached location to a precise GPS fix in the
  // background. Never blocks the first paint.
  useEffect(() => {
    (async () => {
      try {
        const fix = await getPreciseLocation({ timeoutMs: 6000 });
        if (fix) {
          setUser({ lat: fix.lat, lng: fix.lng });
          // Resolve a written place name (never coordinates) for the label
          // and persist server-side so other devices show it too.
          const geo = await geoApi.reverse(fix.lat, fix.lng).catch(() => null);
          userLocation.save({
            lat: fix.lat,
            lng: fix.lng,
            label: friendlyLocationLabel(geo),
            ts: Date.now(),
          });
          void savedLocationApi.save(fix.lat, fix.lng, fix.accuracy);
        }
      } catch (err) {
        if (!user) setLocationNotice(locationErrorMessage(err));
      }
    })();
  }, []);

  const loadPharmacies = () => {
    setLoading(true);
    setError(null);
    geoApi
      // Server clips pins to the 5 km connect radius around the customer.
      .pharmacies(user)
      .then((items) => {
        setPharms(items);
        if (focusPharmacyId) {
          setSelected(items.find((p) => p.id === focusPharmacyId) ?? null);
        } else if (focusLat && focusLng) {
          const lat = Number(focusLat);
          const lng = Number(focusLng);
          setSelected(
            items
              .map((p) => ({ p, d: distanceKm({ lat, lng }, p) ?? Infinity }))
              .sort((a, b) => a.d - b.d)[0]?.p ?? null,
          );
        }
      })
      .catch((e) => {
        setPharms([]);
        setError(e instanceof Error ? e.message : "Could not load pharmacies");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadPharmacies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.lat, user?.lng]);

  // Live order tracking mode: /map?order_id=... polls the same endpoint
  // used by the website MessengerDock tracking map.
  useEffect(() => {
    if (!orderId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const data = await geoApi.track(orderId);
        if (!cancelled) setTrack(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not track order");
      }
    };
    load();
    const timer = setInterval(load, 7_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [orderId]);

  const pharmacyPoint =
    track?.pharmacy.lat != null && track.pharmacy.lng != null
      ? { lat: track.pharmacy.lat, lng: track.pharmacy.lng }
      : null;
  const customerPoint =
    track?.customer.lat != null && track.customer.lng != null
      ? { lat: track.customer.lat, lng: track.customer.lng }
      : null;
  const riderPoint =
    track?.rider?.lat != null && track.rider.lng != null
      ? { lat: track.rider.lat, lng: track.rider.lng }
      : null;

  // Draw a route in two modes:
  // - tracking: pharmacy -> customer (website parity)
  // - browsing: user -> selected pharmacy
  useEffect(() => {
    const from = track ? pharmacyPoint : user;
    const to = track ? customerPoint : selected;
    if (!from || !to) {
      setRoute(null);
      return;
    }
    let cancelled = false;
    geoApi
      .route(from, to)
      .then((r) => {
        if (!cancelled) setRoute(r.geometry);
      })
      .catch(() => {
        if (!cancelled) setRoute(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    track,
    pharmacyPoint?.lat,
    pharmacyPoint?.lng,
    customerPoint?.lat,
    customerPoint?.lng,
    user?.lat,
    user?.lng,
    selected?.lat,
    selected?.lng,
  ]);

  const sortedPharms = useMemo(() => {
    return pharms
      .map((p) => ({ p, d: distanceKm(user, p) }))
      .sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity));
  }, [pharms, user]);

  const trackingMarkers = useMemo(() => {
    if (!track || !pharmacyPoint) return [] as PharmacyMarker[];
    return [
      {
        id: track.pharmacy.id ?? "pharmacy",
        name: track.pharmacy.name ? `Pharmacy: ${track.pharmacy.name}` : "Pharmacy",
        business_name: "Pickup",
        address: track.pharmacy.address,
        phone: null,
        lat: pharmacyPoint.lat,
        lng: pharmacyPoint.lng,
        rating: 0,
        rating_count: 0,
        is_verified: true,
        is_open: true,
        banner_photo_url: track.pharmacy.banner_photo_url ?? null,
      },
    ];
  }, [track, pharmacyPoint?.lat, pharmacyPoint?.lng]);

  const onPick = (_r: MapPickResult) => {
    /* placeholder — picking is disabled by default. */
  };

  const onPharmacyClick = (p: PharmacyMarker) => {
    setSelected(p);
  };

  const mapCenter =
    riderPoint ?? pharmacyPoint ?? customerPoint ?? selected ?? user ?? null;
  const markers = track ? trackingMarkers : pharms;

  return (
    <>
      <MobileHeader
        title={track ? "Live tracking" : "ফার্মেসি map"}
        subtitle={track ? `Order #${track.order_id.slice(0, 8)}` : "কাছের ফার্মেসি"}
        back
      />

      <main className="relative min-h-[calc(100dvh-var(--header-h)-var(--safe-top)-var(--bottom-nav-total))] overflow-hidden bg-gradient-to-b from-brand-50/80 via-slate-50/90 to-emerald-50/70 px-5 pb-5 pt-3 dark:from-brand-500/10 dark:via-[#070b12] dark:to-emerald-500/10">
        {/* Blurred home-like backdrop. This keeps the map feeling like a
            focused overlay presented on top of the app, instead of a flat
            white standalone page. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
          <div className="absolute inset-x-5 top-4 h-10 rounded-full bg-white/90 shadow-sm blur-[2px] dark:bg-white/10" />
          <div className="absolute inset-x-5 top-16 h-28 rounded-[26px] bg-gradient-to-r from-brand-500/35 to-emerald-500/25 shadow-lg blur-[5px] dark:from-brand-400/[0.14] dark:to-emerald-400/[0.12]" />
          <div className="absolute left-5 right-5 top-48 flex gap-2 opacity-80 blur-[3px]">
            <div className="h-8 w-20 rounded-full bg-white dark:bg-white/[0.08]" />
            <div className="h-8 w-28 rounded-full bg-white dark:bg-white/[0.08]" />
            <div className="h-8 w-24 rounded-full bg-white dark:bg-white/[0.08]" />
          </div>
          <div className="absolute inset-x-5 top-64 grid grid-cols-2 gap-3 opacity-90 blur-[4px]">
            <div className="h-40 rounded-[22px] bg-white shadow-sm dark:bg-white/[0.08]" />
            <div className="h-40 rounded-[22px] bg-white shadow-sm dark:bg-white/[0.08]" />
            <div className="h-40 rounded-[22px] bg-white shadow-sm dark:bg-white/[0.08]" />
            <div className="h-40 rounded-[22px] bg-white shadow-sm dark:bg-white/[0.08]" />
          </div>
          <div className="absolute inset-x-5 bottom-8 h-28 rounded-[28px] bg-white/75 shadow-lg blur-[3px] dark:bg-white/[0.06]" />
          <div className="absolute inset-0 bg-white/[0.08] backdrop-blur-[12px] dark:bg-black/25" />
        </div>

        {/* Framed tall map surface. The box is no longer full-screen, but
            it is taller than a square so the route and markers have room.
            Layered shadows give the subtle 3D lift the user requested. */}
        <div className="relative z-10 mx-auto h-[60dvh] max-h-[585px] min-h-[455px] w-[96%] overflow-hidden rounded-[30px] border border-white/75 bg-slate-100 shadow-[0_38px_90px_-32px_rgba(15,23,42,0.8),0_18px_44px_-30px_rgba(15,23,42,0.65),inset_0_1px_0_rgba(255,255,255,0.85)] ring-1 ring-slate-900/5 dark:border-white/10 dark:bg-white/[0.04] dark:shadow-[0_38px_90px_-32px_rgba(0,0,0,0.95),0_18px_44px_-30px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.08)] dark:ring-white/10">
          {loading && (
            <div className="absolute inset-x-0 top-3 z-10 flex justify-center">
              <span className="inline-flex items-center gap-2 rounded-full bg-white/95 px-3 py-1 text-[12px] font-semibold text-slate-700 shadow dark:bg-[#0b1220]/90 dark:text-slate-200">
                <Loader2 size={12} className="animate-spin" /> কাছের ফার্মেসি loading…
              </span>
            </div>
          )}

          <MediMap
            height="100%"
            center={mapCenter}
            zoom={selected || track ? 14 : 12}
            userLocation={track ? null : user}
            userLabel="আপনার অবস্থান"
            customerLocation={customerPoint}
            customerLabel={track?.customer.name ? `Customer: ${track.customer.name}` : "Customer"}
            customerAvatarUrl={track?.customer.profile_photo_url ?? null}
            customerFallbackImageUrl="/brand/logo-outside-bg.png"
            riderLocation={riderPoint}
            riderLabel={track?.rider?.name ?? "Rider"}
            pharmacies={markers}
            onPharmacyClick={onPharmacyClick}
            routePolyline={route}
            onPick={onPick}
            pickEnabled={false}
            showSearch
            showLocateButton
          />
        </div>

        <section className="relative z-10 mt-9 rounded-3xl border border-white/70 bg-white/[0.92] p-3 shadow-[0_28px_64px_-34px_rgba(15,23,42,0.78),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-xl dark:border-white/10 dark:bg-[#0b1220]/[0.88]">
        {track ? (
          <TrackingSheet track={track} route={route} />
        ) : (
          <NearbySheet
            loading={loading}
            error={locationNotice || error}
            selected={selected}
            sorted={sortedPharms}
            onSelect={setSelected}
            onRefresh={loadPharmacies}
            onStore={(p) => router.push(`/store/${p.id}`)}
            onChat={(p) => requestPharmacyChat(router, { pharmacy_id: p.id })}
          />
        )}
        </section>
      </main>
    </>
  );
}

function TrackingSheet({ track, route }: { track: TrackResponse; route: string | null }) {
  const riderLive = track.rider?.lat != null && track.rider.lng != null;
  return (
    <div>
      <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-300 dark:bg-white/20" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold">Live order tracking</p>
          <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
            #{track.order_id.slice(0, 8)} · {track.status}
          </p>
        </div>
        <span className="rounded-full bg-brand-500/10 px-2 py-1 text-[10px] font-bold text-brand-700 dark:text-brand-300">
          {riderLive ? "Rider live" : "Rider অপেক্ষায়"}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <InfoTile icon={<Store size={13} />} label="Pickup" value={track.pharmacy.name || "Pharmacy"} />
        <InfoTile icon={<Bike size={13} />} label="Rider" value={track.rider?.name || "Assign হয়নি"} />
        <InfoTile icon={<Navigation size={13} />} label="Route" value={route ? "দেখানো হচ্ছে" : "Pending"} />
      </div>
      {track.rider?.last_seen_at && (
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          Rider last seen {fmtSeen(track.rider.last_seen_at)}
        </p>
      )}
      <p className="mt-2 line-clamp-2 text-[11px] text-slate-500 dark:text-slate-400">
        <MapPin size={11} className="-mt-0.5 mr-1 inline text-brand-500" />
        {track.customer.address || "Customer delivery location"}
      </p>
    </div>
  );
}

function NearbySheet({
  loading,
  error,
  selected,
  sorted,
  onSelect,
  onRefresh,
  onStore,
  onChat,
}: {
  loading: boolean;
  error: string | null;
  selected: PharmacyMarker | null;
  sorted: Array<{ p: PharmacyMarker; d: number | null }>;
  onSelect: (p: PharmacyMarker) => void;
  onRefresh: () => void;
  onStore: (p: PharmacyMarker) => void;
  onChat: (p: PharmacyMarker) => void;
}) {
  return (
    <div>
      <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-300 dark:bg-white/20" />
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-bold">কাছের ফার্মেসি</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {loading ? "Loading…" : `${sorted.length} ফার্মেসি map-এ আছে`}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="tap grid h-9 w-9 place-items-center rounded-full border border-slate-200 text-slate-600 dark:border-white/10 dark:text-slate-200"
          aria-label="ফার্মেসি refresh"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {error && <p className="mt-2 text-[11px] text-rose-500">{error}</p>}

      {selected && (
        <div className="mt-3 rounded-2xl border border-brand-200 bg-brand-50/70 p-3 dark:border-brand-500/30 dark:bg-brand-500/10">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{selected.name}</p>
              <p className="truncate text-[11px] text-slate-600 dark:text-slate-300">
                {selected.address || selected.business_name || "Pharmacy"}
              </p>
            </div>
            <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-brand-700 dark:bg-white/10 dark:text-brand-300">
              {selected.is_open ? "Open" : "Closed"}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300">
            {selected.rating > 0 && (
              <span>
                <Star size={11} fill="currentColor" className="-mt-0.5 mr-0.5 inline text-amber-500" />
                {selected.rating.toFixed(1)} ({selected.rating_count})
              </span>
            )}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => onStore(selected)}
              className="tap flex items-center justify-center gap-1 rounded-full bg-brand-500 px-2 py-2 text-[11px] font-bold text-white"
            >
              <Store size={12} /> Store
            </button>
            <button
              type="button"
              onClick={() => onChat(selected)}
              className="tap flex items-center justify-center gap-1 rounded-full border border-brand-200 bg-white px-2 py-2 text-[11px] font-bold text-brand-700 dark:border-brand-500/30 dark:bg-white/10 dark:text-brand-300"
            >
              <MessageCircle size={12} /> Chat
            </button>
            <a
              href={selected.phone ? `tel:${selected.phone}` : undefined}
              className="tap flex items-center justify-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-2 text-[11px] font-bold text-slate-700 dark:border-white/10 dark:bg-white/10 dark:text-slate-200"
            >
              <Phone size={12} /> Call
            </a>
          </div>
        </div>
      )}

      <div className="no-scrollbar mt-3 flex max-h-28 gap-2 overflow-x-auto pb-1">
        {sorted.slice(0, 12).map(({ p, d }) => {
          const active = selected?.id === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p)}
              className={[
                "tap w-40 shrink-0 rounded-2xl border p-2 text-left",
                active
                  ? "border-brand-500 bg-brand-500 text-white"
                  : "border-slate-200 bg-white text-slate-800 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100",
              ].join(" ")}
            >
              <p className="truncate text-[12px] font-bold">{p.name}</p>
              <p className={active ? "text-[10px] text-white/80" : "text-[10px] text-slate-500 dark:text-slate-400"}>
                {fmtKm(d) || (p.is_open ? "Open" : "Closed")}
              </p>
              <p className={active ? "mt-1 text-[10px] text-white/80" : "mt-1 text-[10px] text-slate-400"}>
                {p.rating > 0 ? `★ ${p.rating.toFixed(1)}` : "Details দেখুন"}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function InfoTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-2xl bg-slate-50 p-2 dark:bg-white/[0.04]">
      <div className="flex items-center gap-1 text-brand-600 dark:text-brand-300">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1 truncate text-[11px] font-semibold">{value}</p>
    </div>
  );
}
