"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useParams, useRouter } from "next/navigation";
import { BadgeCheck, MapPin, Phone, Star, MessageCircle } from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { ProductCard, ProductCardSkeleton } from "@/components/product-card";
import { resolveMediaUrl } from "@/lib/api";
import {
  fetchPharmacy,
  userLocation,
  requestPharmacyChat,
  buyPrefill,
  inquiryPrefill,
  type PharmacyDetail,
  type StorefrontMedicine,
} from "@/lib/storefront";

export default function StorePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;

  const [data, setData] = useState<PharmacyDetail | null>(null);
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const loc = userLocation.load();
    fetchPharmacy(id, { lat: loc?.lat, lng: loc?.lng })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Load failed"))
      .finally(() => setLoading(false));
  }, [id]);

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

  const onChatPharmacy = () => {
    if (!data) return;
    requestPharmacyChat(router, { pharmacy_id: data.pharmacy.id });
  };

  if (error) {
    return (
      <>
        <MobileHeader title="Pharmacy" back />
        <div className="px-4 pt-6 text-sm text-rose-500">{error}</div>
      </>
    );
  }

  const ph = data?.pharmacy;
  const banner = resolveMediaUrl(ph?.banner_photo_url);

  // Build the visible items list from the active category (or "All").
  const allItemsDeduped: StorefrontMedicine[] = (() => {
    if (!data) return [];
    if (activeCat) {
      const cat = data.categories.find((c) => c.name === activeCat);
      return cat?.items ?? [];
    }
    const seen = new Set<string>();
    const out: StorefrontMedicine[] = [];
    for (const cat of data.categories) {
      for (const it of cat.items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(it);
      }
    }
    return out;
  })();

  return (
    <>
      <MobileHeader title={ph?.name || "Pharmacy"} subtitle={ph?.business_name || undefined} back />

      {/* Banner with gradient fallback when the pharmacy hasn't uploaded
          a banner photo. The hue is derived from the pharmacy id so it
          stays stable across visits. */}
      <div
        className="relative h-44 w-full overflow-hidden"
        style={
          banner
            ? undefined
            : {
                background: gradientFor(ph?.id || ph?.name || "x"),
              }
        }
      >
        {banner && (
          <Image src={banner} alt={ph?.name || "Pharmacy"} fill sizes="480px" className="object-cover" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/20 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-4 text-white">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide opacity-90">
            {ph?.is_verified && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/90 px-2 py-0.5">
                <BadgeCheck size={11} /> Verified
              </span>
            )}
            {ph && ph.rating > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/90 px-2 py-0.5">
                <Star size={11} fill="currentColor" /> {ph.rating.toFixed(1)} ({ph.rating_count})
              </span>
            )}
          </div>
          <h1 className="mt-1.5 text-lg font-bold leading-tight">{ph?.name}</h1>
          {ph?.business_name && (
            <p className="text-xs opacity-90">{ph.business_name}</p>
          )}
        </div>
      </div>

      {/* Info row */}
      <div className="space-y-2 px-4 pt-3">
        {ph?.address && (
          <button
            type="button"
            onClick={() => {
              const lat = ph?.lat;
              const lng = ph?.lng;
              if (lat != null && lng != null) {
                router.push(`/map?lat=${lat}&lng=${lng}`);
              } else {
                router.push("/map");
              }
            }}
            className="tap flex w-full items-start gap-1.5 rounded-2xl border border-slate-200/70 bg-white px-3 py-2 text-left text-xs text-slate-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300"
          >
            <MapPin size={13} className="mt-0.5 shrink-0 text-brand-500" />
            <span className="min-w-0 flex-1">{ph.address}</span>
            {ph?.distance_km != null && (
              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] dark:bg-white/10">
                {ph.distance_km.toFixed(1)} km
              </span>
            )}
          </button>
        )}
        {ph?.phone_number && (
          <a
            href={`tel:${ph.phone_number}`}
            className="tap flex items-center gap-1.5 rounded-2xl border border-slate-200/70 bg-white px-3 py-2 text-xs text-slate-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300"
          >
            <Phone size={13} className="shrink-0 text-brand-500" />
            {ph.phone_number}
          </a>
        )}
        <button
          type="button"
          onClick={onChatPharmacy}
          className="tap mt-1 flex w-full items-center justify-center gap-2 rounded-full bg-brand-500 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
        >
          <MessageCircle size={15} /> Chat with pharmacy
        </button>
      </div>

      {/* Category tabs */}
      {data && data.categories.length > 0 && (
        <div className="no-scrollbar mt-4 flex gap-2 overflow-x-auto px-4 pb-1">
          <button
            type="button"
            onClick={() => setActiveCat(null)}
            className={[
              "tap shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-semibold",
              activeCat === null
                ? "border-brand-500 bg-brand-500 text-white"
                : "border-slate-200 bg-white text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200",
            ].join(" ")}
          >
            All ({data.total_medicines})
          </button>
          {data.categories.map((c) => {
            const active = activeCat === c.name;
            return (
              <button
                key={c.name}
                type="button"
                onClick={() => setActiveCat(active ? null : c.name)}
                className={[
                  "tap shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-semibold",
                  active
                    ? "border-brand-500 bg-brand-500 text-white"
                    : "border-slate-200 bg-white text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200",
                ].join(" ")}
              >
                {c.name} ({c.items.length})
              </button>
            );
          })}
        </div>
      )}

      {/* Grid */}
      <div className="mt-3 grid grid-cols-2 gap-3 px-4">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => <ProductCardSkeleton key={i} />)
          : allItemsDeduped.map((m) => (
              <ProductCard key={m.id} item={m} onBuy={() => onBuy(m)} onMessage={() => onMessage(m)} />
            ))}
      </div>
    </>
  );
}

// Stable colourful gradient derived from a string (pharmacy id or name).
// Used as the banner placeholder when the pharmacy hasn't uploaded one,
// so storefronts never look like empty grey boxes.
function gradientFor(seed: string): string {
  const palette = [
    ["#10b981", "#0ea5e9"],
    ["#6366f1", "#ec4899"],
    ["#f59e0b", "#ef4444"],
    ["#14b8a6", "#3b82f6"],
    ["#8b5cf6", "#06b6d4"],
    ["#f43f5e", "#f97316"],
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const [a, b] = palette[h % palette.length];
  return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
}
