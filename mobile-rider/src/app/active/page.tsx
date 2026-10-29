"use client";

/**
 * Rider Active Deliveries page — re-uses the same active list and quick
 * actions from the home screen but without the offers + ONLINE toggle.
 * Polls /api/rider/orders/active every 7s.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, Loader2, MapPin, MessageCircle, Package, Phone, Radar, Truck } from "lucide-react";
import { session } from "@/lib/api";
import { riderApi, type RiderOrder } from "@/lib/rider";
import { googleMapsLink } from "@/lib/geo";
import { MobileHeader } from "@/components/mobile-header";
import { OfferMiniMap } from "@/components/offer-mini-map";

const ACTIVE_POLL_MS = 7_000;

export default function ActivePage() {
  const router = useRouter();
  const [items, setItems] = useState<RiderOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session.access()) { router.replace("/login?next=/active"); return; }
    if (session.role() !== "rider") { router.replace("/login?msg=wrong-role"); return; }
    let stop = false;
    const tick = () => riderApi.activeOrders()
      .then((d) => { if (!stop) setItems(d.items); })
      .catch((e) => { if (!stop) setError(e instanceof Error ? e.message : "Load failed"); });
    tick();
    const t = setInterval(tick, ACTIVE_POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [router]);

  return (
    <>
      <MobileHeader title="চলতি delivery" subtitle="Order খুলতে chat-এ tap করুন" />
      {/* `.app-scroll` already reserves `header-h + safe-top` for the fixed
          MobileHeader above — only the extra breathing room belongs here. */}
      <div className="px-4 pt-3">
        {error && (
          <p className="mb-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">
            {error}
          </p>
        )}
        {!items && !error && (
          <div className="flex items-center justify-center gap-2 p-8 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        )}
        {items && items.length === 0 && (
          <div className="rounded-3xl border border-emerald-200/70 bg-white p-4 text-center shadow-sm shadow-emerald-500/5 dark:border-emerald-500/20 dark:bg-white/[0.04]">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
              <Truck size={24} />
            </div>
            <h2 className="mt-3 text-sm font-extrabold text-slate-900 dark:text-slate-50">
              কোনো চলতি delivery নেই
            </h2>
            <p className="mx-auto mt-1 max-w-[280px] text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              নতুন offer পেতে Home থেকে online থাকুন। Order accept করলে pickup route, customer chat, আর delivery action এখানে দেখাবে।
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Link
                href="/"
                className="tap inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-[11px] font-bold text-white shadow-sm"
              >
                <Radar size={13} /> Online হন
              </Link>
              <Link
                href="/chats"
                className="tap inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-bold text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
              >
                চ্যাট <ChevronRight size={13} />
              </Link>
            </div>
          </div>
        )}
        <ul className="space-y-3">
          {items?.map((o) => <ActiveOrderCard key={o.id} order={o} />)}
        </ul>
      </div>
    </>
  );
}

function ActiveOrderCard({ order }: { order: RiderOrder }) {
  const [busy, setBusy] = useState<"pickup" | "deliver" | null>(null);
  const [status, setStatus] = useState(order.status);
  const pickupPt = order.pickup?.lat != null && order.pickup.lng != null
    ? { lat: order.pickup.lat, lng: order.pickup.lng } : null;
  const dropPt = order.delivery_lat != null && order.delivery_lng != null
    ? { lat: order.delivery_lat, lng: order.delivery_lng } : null;
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
    : status === "on_the_way" || status === "picked_up" ? "bg-purple-500"
    : "bg-amber-500";

  return (
    <li className="rounded-2xl border border-emerald-300/40 bg-white p-3 shadow-sm dark:border-emerald-500/30 dark:bg-white/[0.04]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[13px] font-bold">#{order.id.slice(0, 8)}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            ৳{order.total} • Fee ৳{order.delivery_fee}
          </p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white ${statusTone}`}>
          {status.replace(/_/g, " ")}
        </span>
      </div>

      {(pickupPt || dropPt) && (
        <OfferMiniMap
          rider={null}
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
            <MessageCircle size={12} /> Chat
          </Link>
        )}
        <button
          onClick={onPickup}
          disabled={busy === "pickup" || status !== "dispatched"}
          className="tap inline-flex items-center justify-center gap-1 rounded-xl bg-purple-500 py-2 text-[11px] font-bold text-white disabled:opacity-50"
        >
          {busy === "pickup" ? <Loader2 size={12} className="animate-spin" /> : <Package size={12} />}
          Picked up
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
