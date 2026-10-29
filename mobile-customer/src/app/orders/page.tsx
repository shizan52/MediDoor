"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Package, ChevronRight, Star, MapPin, MessageCircle, XCircle } from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { api, resolveMediaUrl, session } from "@/lib/api";

type OrderItem = {
  medicine_id?: string;
  name: string;
  qty: number;
  price?: number;
  unit_price?: number;
  image_url?: string | null;
};

type Order = {
  id: string;
  status: string;
  items: OrderItem[];
  item_count: number;
  subtotal: number;
  delivery_fee: number;
  total: number;
  created_at: string | null;
  pharmacy: {
    id: string;
    name: string;
    banner_photo_url: string | null;
    rating: number | null;
    address: string | null;
  };
  conversation_id: string | null;
};

type OrdersResp = {
  orders: Order[];
  totals: { spent_delivered: number; delivered_count: number; order_count?: number };
};

const STATUS_CLASS: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  preparing: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  awaiting_rider: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  in_transit: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  out_for_delivery: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  delivered: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  cancelled: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  rejected: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  ready: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  dispatched: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  preparing: "Preparing",
  ready: "Ready",
  awaiting_rider: "Finding rider",
  dispatched: "On the way",
  in_transit: "On the way",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  rejected: "Rejected",
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

function fmtDate(s: string | null): string {
  if (!s) return "";
  try {
    return new Date(s).toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return s;
  }
}

function canTrack(status: string): boolean {
  return !["delivered", "cancelled", "rejected"].includes(status);
}

function canCancel(status: string): boolean {
  return ["pending", "confirmed"].includes(status);
}

export default function OrdersPage() {
  const router = useRouter();
  const [data, setData] = useState<OrdersResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Order | null>(null);

  const refresh = () => {
    api<OrdersResp>("/api/customer/me/orders")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
  };

  useEffect(() => {
    if (!session.access()) {
      router.replace("/login?next=/orders");
      return;
    }
    refresh();
  }, [router]);

  const cancelOrder = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/orders/${id}/cancel`, { method: "POST" });
      refresh();
      setCancelTarget(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <MobileHeader title="My Orders" />

      <div className="px-4 pt-3">
        {data && (
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Spent" value={`৳${data.totals.spent_delivered.toFixed(0)}`} />
            <Stat label="Delivered" value={String(data.totals.delivered_count)} />
          </div>
        )}
      </div>

      <div className="px-2 pt-3">
        {!data && !error && (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading orders…
          </div>
        )}
        {error && <p className="px-4 text-sm text-rose-500">{error}</p>}
        {data && data.orders.length === 0 && (
          <div className="m-4 flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-8 text-center text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.02]">
            <Package size={22} className="opacity-50" />
            <p>এখনও কোনও order নেই — Home থেকে browse শুরু করুন।</p>
          </div>
        )}
        {data?.orders.map((o) => {
          const banner = resolveMediaUrl(o.pharmacy.banner_photo_url);
          return (
            <div
              key={o.id}
              className="mb-2 rounded-2xl border border-slate-200/70 bg-white p-2.5 dark:border-white/10 dark:bg-white/[0.04]"
            >
              <div className="flex items-center gap-3">
                <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-slate-200 dark:bg-white/10">
                  {banner && (
                    <Image src={banner} alt={o.pharmacy.name} fill sizes="56px" className="object-cover" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold">{o.pharmacy.name}</p>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_CLASS[o.status] ?? "bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-slate-200"}`}>
                      {statusLabel(o.status)}
                    </span>
                  </div>
                  <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                    {o.item_count} item · ৳{o.total} · {fmtDate(o.created_at)}
                  </p>
                  {o.pharmacy.rating != null && o.pharmacy.rating > 0 && (
                    <p className="text-[10px] text-amber-500">
                      <Star size={10} fill="currentColor" className="-mt-0.5 mr-0.5 inline" />
                      {o.pharmacy.rating.toFixed(1)}
                    </p>
                  )}
                </div>
                <ChevronRight size={16} className="text-slate-400" />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Link
                  href={o.conversation_id ? `/chats/${o.conversation_id}` : "/chats"}
                  className="tap flex items-center justify-center gap-1.5 rounded-full border border-slate-200 py-2 text-[11px] font-semibold text-slate-700 dark:border-white/10 dark:text-slate-200"
                >
                  <MessageCircle size={12} /> Chat
                </Link>
                <Link
                  href={`/map?order_id=${o.id}`}
                  className={[
                    "tap flex items-center justify-center gap-1.5 rounded-full py-2 text-[11px] font-semibold",
                    canTrack(o.status)
                      ? "bg-brand-500 text-white"
                      : "border border-slate-200 text-slate-700 dark:border-white/10 dark:text-slate-200",
                  ].join(" ")}
                >
                  <MapPin size={12} /> {canTrack(o.status) ? "Track" : "Map"}
                </Link>
              </div>
              {canCancel(o.status) && (
                <button
                  type="button"
                  onClick={() => setCancelTarget(o)}
                  disabled={busyId === o.id}
                  className="tap mt-2 flex w-full items-center justify-center gap-1.5 rounded-full border border-rose-300/70 bg-rose-50 py-2 text-[11px] font-semibold text-rose-700 disabled:opacity-60 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300"
                >
                  {busyId === o.id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <XCircle size={12} />
                  )}
                  Order cancel করুন
                </button>
              )}
            </div>
          );
        })}
      </div>

      {cancelTarget && (
        <CancelOrderModal
          order={cancelTarget}
          busy={busyId === cancelTarget.id}
          onClose={() => setCancelTarget(null)}
          onConfirm={() => void cancelOrder(cancelTarget.id)}
        />
      )}
    </>
  );
}

function CancelOrderModal({
  order,
  busy,
  onClose,
  onConfirm,
}: {
  order: Order;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/35 px-3 pb-[calc(var(--safe-bottom)+12px)] backdrop-blur-sm">
      <div className="w-full max-w-[448px] rounded-3xl border border-white/70 bg-white p-4 shadow-2xl dark:border-white/10 dark:bg-[#101722]">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200 dark:bg-white/20" />
        <h2 className="text-base font-extrabold text-slate-950 dark:text-white">Order cancel করবেন?</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">
          {order.pharmacy.name} থেকে ৳{order.total} order cancel হবে। Pharmacy packaging শুরু করলে cancel নাও হতে পারে।
        </p>
        <div className="mt-3 rounded-2xl bg-slate-50 px-3 py-2 text-[12px] dark:bg-white/5">
          <p className="font-semibold text-slate-800 dark:text-slate-100">#{order.id.slice(0, 8)}</p>
          <p className="mt-0.5 text-slate-500 dark:text-slate-400">
            {order.item_count} item · {statusLabel(order.status)}
          </p>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="tap rounded-2xl border border-slate-200 bg-white px-3 py-2 text-[12px] font-bold text-slate-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
          >
            Back
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="tap inline-flex items-center justify-center gap-1.5 rounded-2xl bg-rose-600 px-3 py-2 text-[12px] font-bold text-white disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <XCircle size={13} />}
            Cancel order
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white p-3 dark:border-white/10 dark:bg-white/[0.04]">
      <p className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-lg font-bold">{value}</p>
    </div>
  );
}
