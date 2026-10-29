"use client";

/**
 * Order detail + action panel — 1:1 port of
 * mobile-pharmacy/src/app/orders/[id]/page.tsx.
 *
 * Actions per status:
 *   pending    → Confirm / Reject (with reason)
 *   confirmed  → Mark packaging
 *   packaging  → Mark ready
 *   ready      → Dispatch riders (broadcasts 5 km offers)
 *   dispatched → Mark delivered (manual fallback if rider didn't)
 */
import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, Bike, CheckCircle2, ClipboardList, Loader2, MapPin,
  MessageCircle, Package, Phone, X,
} from "lucide-react";
import { MobileHeader } from "@/components/pharmacy-app/mobile-header";
import { resolveMediaUrl, session } from "@/lib/api";
import { pharmacyApi, type OrderStatus, type PharmacyOrder } from "@/lib/pharmacy";

const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  packaging: "Packaging",
  ready: "Ready",
  dispatched: "Dispatched",
  delivered: "Delivered",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export function PharmacyOrderDetailScreen({ id }: { id: string }) {
  const router = useRouter();
  const [order, setOrder] = useState<PharmacyOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const refresh = useCallback(async () => {
    try {
      // Backend exposes the full order via the listing endpoint; pull it
      // and find the row. (Avoids needing a /orders/{id} pharmacy route.)
      const d = await pharmacyApi.listOrders();
      const found = d.items.find((o) => o.id === id);
      if (!found) throw new Error("Order not found");
      setOrder(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, [id]);

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    if (session.role() !== "pharmacy") { router.replace("/"); return; }
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh, router]);

  const doAction = async (fn: () => Promise<PharmacyOrder | { order: PharmacyOrder; offers_sent: number }>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      const updated = "order" in res ? res.order : res;
      setOrder(updated);
      if ("offers_sent" in res) {
        setError(`✓ ${res.offers_sent} জন rider-এর কাছে offer পাঠানো হয়েছে।`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const onConfirm   = () => doAction(() => pharmacyApi.confirmOrder(id));
  const onReject    = () => {
    if (!rejectReason.trim()) { setError("Reject কারণ লিখুন।"); return; }
    setRejectOpen(false);
    return doAction(() => pharmacyApi.rejectOrder(id, rejectReason.trim()));
  };
  const onPackaging = () => doAction(() => pharmacyApi.setOrderStatus(id, "packaging"));
  const onReady     = () => doAction(() => pharmacyApi.setOrderStatus(id, "ready"));
  const onDispatch  = () => doAction(() => pharmacyApi.dispatchRiders(id));
  const onDelivered = () => doAction(() => pharmacyApi.setOrderStatus(id, "delivered"));

  return (
    <>
      <MobileHeader
        title={order ? `Order #${order.id.slice(0, 6)}` : "Order"}
        subtitle={order ? STATUS_LABEL[order.status] : undefined}
        back
      />

      <div className="px-4 pt-3">
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-2xl border border-rose-300/60 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <p className="flex-1">{error}</p>
            <button onClick={() => setError(null)}><X size={12} /></button>
          </div>
        )}

        {!order && !error && (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        )}

        {order && (
          <>
            {/* Customer card */}
            <div className="rounded-2xl border border-slate-200/70 bg-white p-3 dark:border-white/10 dark:bg-white/[0.04]">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Customer</p>
              <p className="mt-1 text-base font-bold">{order.customer_name}</p>
              {order.customer_phone && (
                <a href={`tel:${order.customer_phone}`} className="mt-1 inline-flex items-center gap-1 text-[12px] text-brand-600 dark:text-brand-300">
                  <Phone size={12} /> {order.customer_phone}
                </a>
              )}
              {order.delivery_address && (
                <p className="mt-1 flex items-start gap-1 text-[11px] text-slate-600 dark:text-slate-300">
                  <MapPin size={12} className="mt-0.5 shrink-0" /> {order.delivery_address}
                </p>
              )}
            </div>

            {/* Items */}
            <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200/70 bg-white dark:border-white/10 dark:bg-white/[0.04]">
              <div className="flex items-center gap-1 border-b border-slate-100 px-3 py-2 text-sm font-semibold dark:border-white/5">
                <Package size={14} /> Items ({order.items.length})
              </div>
              {order.items.map((it, i) => (
                <div key={i} className={`flex items-center gap-3 p-3 ${i ? "border-t border-slate-100 dark:border-white/5" : ""}`}>
                  <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-slate-200 dark:bg-white/10">
                    {it.image_url && (
                      <Image src={resolveMediaUrl(it.image_url)} alt="" fill sizes="48px" className="object-cover" unoptimized />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{it.name}</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      {it.qty} × ৳{it.price}
                    </p>
                  </div>
                  <p className="text-sm font-semibold">৳{it.qty * it.price}</p>
                </div>
              ))}
            </div>

            {/* Totals */}
            <div className="mt-3 rounded-2xl border border-slate-200/70 bg-white p-3 text-sm dark:border-white/10 dark:bg-white/[0.04]">
              <Row label="Subtotal" value={`৳${order.subtotal}`} />
              <Row label="Delivery" value={`৳${order.delivery_fee}`} />
              <Row label="Total" value={`৳${order.total}`} bold />
            </div>

            {/* Note + Rejection reason */}
            {order.note && (
              <div className="mt-3 rounded-2xl border border-slate-200/70 bg-white p-3 text-[12px] dark:border-white/10 dark:bg-white/[0.04]">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Customer note</p>
                <p className="mt-1">{order.note}</p>
              </div>
            )}
            {order.rejection_reason && (
              <div className="mt-3 rounded-2xl border border-rose-300/60 bg-rose-50 p-3 text-[12px] text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-200">
                <p className="text-[10px] uppercase tracking-wider opacity-70">Rejection reason</p>
                <p className="mt-1">{order.rejection_reason}</p>
              </div>
            )}

            {/* Chat shortcut */}
            <Link
              href="/pharmacy/chats"
              className="tap mt-3 flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white py-2.5 text-[12px] font-semibold dark:border-white/10 dark:bg-white/[0.04]"
            >
              <MessageCircle size={14} /> Customer-এর সাথে chat
            </Link>

            {/* Actions */}
            <div className="mt-4 grid gap-2">
              <ActionPanel
                status={order.status}
                busy={busy}
                onConfirm={onConfirm}
                onReject={() => setRejectOpen(true)}
                onPackaging={onPackaging}
                onReady={onReady}
                onDispatch={onDispatch}
                onDelivered={onDelivered}
              />
            </div>
          </>
        )}
      </div>

      {/* Reject modal */}
      {rejectOpen && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-4">
          <div className="w-full max-w-[420px] rounded-3xl bg-white p-4 dark:bg-[#0b1018]">
            <p className="text-base font-semibold">Reject reason</p>
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              Customer-কে কেন reject করছেন সেটা বাংলায় লিখুন।
            </p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              className="mt-3 w-full rounded-xl border border-slate-200 bg-white p-2 text-sm dark:border-white/10 dark:bg-white/5"
              placeholder="যেমন: ওষুধ stock-এ নেই"
            />
            <div className="mt-3 flex gap-2">
              <button onClick={() => setRejectOpen(false)} className="tap flex-1 rounded-full border border-slate-200 py-2.5 text-sm dark:border-white/10">Cancel</button>
              <button onClick={onReject} className="tap flex-1 rounded-full bg-rose-500 py-2.5 text-sm font-semibold text-white">Reject</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1 ${bold ? "border-t border-slate-100 pt-2 dark:border-white/5" : ""}`}>
      <span className={bold ? "font-semibold" : "text-slate-500 dark:text-slate-400"}>{label}</span>
      <span className={bold ? "text-base font-bold" : ""}>{value}</span>
    </div>
  );
}

function ActionPanel({
  status, busy, onConfirm, onReject, onPackaging, onReady, onDispatch, onDelivered,
}: {
  status: OrderStatus; busy: boolean;
  onConfirm: () => void; onReject: () => void;
  onPackaging: () => void; onReady: () => void;
  onDispatch: () => void; onDelivered: () => void;
}) {
  if (status === "pending") {
    return (
      <div className="grid grid-cols-2 gap-2">
        <Btn busy={busy} onClick={onReject} variant="danger" icon={X}>Reject</Btn>
        <Btn busy={busy} onClick={onConfirm} variant="primary" icon={CheckCircle2}>Confirm</Btn>
      </div>
    );
  }
  if (status === "confirmed") {
    return <Btn busy={busy} onClick={onPackaging} variant="primary" icon={Package}>Packaging শুরু</Btn>;
  }
  if (status === "packaging") {
    return <Btn busy={busy} onClick={onReady} variant="primary" icon={ClipboardList}>Ready for pickup</Btn>;
  }
  if (status === "ready") {
    return <Btn busy={busy} onClick={onDispatch} variant="primary" icon={Bike}>Broadcast riders 5 km</Btn>;
  }
  if (status === "dispatched") {
    return <Btn busy={busy} onClick={onDelivered} variant="primary" icon={CheckCircle2}>Mark delivered</Btn>;
  }
  return null;
}

function Btn({ children, onClick, busy, variant, icon: Icon }: {
  children: React.ReactNode; onClick: () => void; busy: boolean;
  variant: "primary" | "danger"; icon: any;
}) {
  return (
    <button
      disabled={busy}
      onClick={onClick}
      className={[
        "tap flex items-center justify-center gap-1.5 rounded-full py-3 text-sm font-semibold disabled:opacity-60",
        variant === "primary" ? "bg-brand-500 text-white" : "border border-rose-400 text-rose-600 dark:text-rose-300",
      ].join(" ")}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
      {children}
    </button>
  );
}
