"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  AlertTriangle, ArrowLeft, BadgeCheck, Crown, Loader2, LogOut, MessageSquare,
  Send, ShoppingBag, Truck, X,
} from "lucide-react";
import { api, session } from "@/lib/api";
import {
  TIER_INFO, pharmacyApi,
  type OrderStatus, type PharmacyAnalytics, type PharmacyMe, type PharmacyOrder,
  type SubscriptionTier,
} from "@/lib/pharmacy";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { MessengerDock } from "@/components/messenger-dock";
import { Card, ConfirmModal, Pill } from "@/components/pharmacy-profile";

type Tab = "sales" | "subscription";

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "অপেক্ষায়",
  confirmed: "Confirm হয়েছে",
  packaging: "প্যাকিং চলছে",
  ready: "Ready",
  dispatched: "Rider পথে",
  delivered: "ডেলিভার্ড",
  rejected: "রিজেক্ট হয়েছে",
  cancelled: "বাতিল",
};


export function PharmacyMyProfilePage() {
  const router = useRouter();
  const [me, setMe] = useState<PharmacyMe | null>(null);
  const [tab, setTab] = useState<Tab>("sales");
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    if (session.role() !== "pharmacy") { router.replace("/"); return; }
    pharmacyApi.me().then(setMe).catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
  }, [router]);

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
      </div>

      <header className="sticky top-0 z-30 border-b border-black/5 bg-white/70 backdrop-blur dark:border-white/10 dark:bg-[#0b1018]/70">
        <div className="flex w-full flex-wrap items-center gap-2 px-3 py-2 sm:gap-3 sm:px-6 sm:py-3 lg:px-10">
          <BrandLogo className="h-8 w-auto sm:h-9" />
          <button
            onClick={() => router.push("/pharmacy")}
            className="ml-1 inline-flex items-center gap-1.5 rounded-full bg-black/5 px-2.5 py-1.5 text-[11px] font-semibold hover:bg-black/10 sm:ml-2 sm:px-3 sm:text-xs dark:bg-white/10 dark:hover:bg-white/20"
            aria-label="ড্যাশবোর্ড"
          >
            <ArrowLeft size={12} />
            <span className="hidden sm:inline">ড্যাশবোর্ড</span>
          </button>

          <div className="flex gap-1 sm:ml-4">
            {([
              { k: "sales", label: "Sales ও অর্ডার", short: "Sales", icon: <ShoppingBag size={12} /> },
              { k: "subscription", label: "Subscription plan", short: "Plan", icon: <Crown size={12} /> },
            ] as const).map((t) => (
              <button
                key={t.k}
                onClick={() => setTab(t.k)}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[11px] font-semibold transition sm:px-3 sm:text-xs ${
                  tab === t.k
                    ? "bg-brand-500 text-white shadow-md shadow-brand-500/30"
                    : "bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
                }`}
              >
                {t.icon}
                <span className="sm:hidden">{t.short}</span>
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            <ThemeToggle />
            <button
              onClick={onLogout}
              disabled={loggingOut}
              className="inline-flex items-center gap-1.5 rounded-full bg-black/5 px-2.5 py-1.5 text-[11px] font-medium hover:bg-black/10 disabled:opacity-60 sm:px-3 sm:text-xs dark:bg-white/10 dark:hover:bg-white/20"
              aria-label="Logout"
            >
              {loggingOut ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />}
              <span className="hidden sm:inline">{loggingOut ? "লগআউট হচ্ছে…" : "লগআউট"}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="px-3 py-4 sm:px-6 sm:py-6 lg:px-10">
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-2xl border border-red-300/60 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-300">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
            <p className="flex-1">{error}</p>
            <button onClick={() => setError(null)}><X size={14} /></button>
          </div>
        )}

        {!me && <p className="opacity-60">লোড হচ্ছে…</p>}

        {me && tab === "sales" && <SalesTab me={me} setError={setError} />}
        {me && tab === "subscription" && <SubscriptionTab me={me} onSaved={setMe} />}
      </div>
      <MessengerDock />
    </main>
  );
}

/* ---------------------------- sales (excel-like) ---------------------------- */

const STATUS_COLORS: Record<OrderStatus, string> = {
  pending:    "bg-amber-100  text-amber-800  dark:bg-amber-500/20  dark:text-amber-300",
  confirmed:  "bg-sky-100    text-sky-800    dark:bg-sky-500/20    dark:text-sky-300",
  packaging:  "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-300",
  ready:      "bg-cyan-100   text-cyan-800   dark:bg-cyan-500/20   dark:text-cyan-300",
  dispatched: "bg-blue-100   text-blue-800   dark:bg-blue-500/20   dark:text-blue-300",
  delivered:  "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300",
  rejected:   "bg-rose-100   text-rose-800   dark:bg-rose-500/20   dark:text-rose-300",
  cancelled:  "bg-slate-200  text-slate-800  dark:bg-slate-500/20  dark:text-slate-300",
};

type SortKey = "created_at" | "customer_name" | "total" | "status" | "items";
type SortDir = "asc" | "desc";

function SalesTab({ me, setError }: { me: PharmacyMe; setError: (s: string | null) => void }) {
  const [stats, setStats] = useState<PharmacyAnalytics | null>(null);
  const [orders, setOrders] = useState<PharmacyOrder[]>([]);
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [active, setActive] = useState<PharmacyOrder | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [a, o] = await Promise.all([
        pharmacyApi.analytics().catch(() => null),
        pharmacyApi.listOrders(statusFilter === "all" ? undefined : statusFilter),
      ]);
      if (a) setStats(a);
      setOrders(o.items);
      if (active) setActive(o.items.find((x) => x.id === active.id) ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : "Load failed"); }
  }, [statusFilter, setError, active]);

  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [statusFilter]);

  // Auto-refresh every 15s so chat-driven order status changes show up
  // in Sales & Orders without the pharmacy having to reload the page.
  useEffect(() => {
    const id = window.setInterval(() => { reload(); }, 15000);
    return () => window.clearInterval(id);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [statusFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let arr = orders;
    if (q) {
      arr = arr.filter((o) =>
        o.customer_name.toLowerCase().includes(q) ||
        o.customer_phone.includes(q) ||
        o.id.toLowerCase().includes(q) ||
        o.delivery_address.toLowerCase().includes(q)
      );
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...arr].sort((a, b) => {
      switch (sortKey) {
        case "created_at":   return (((a.created_at ?? "") < (b.created_at ?? "")) ? -1 : 1) * dir;
        case "customer_name": return a.customer_name.localeCompare(b.customer_name) * dir;
        case "total":        return (a.total - b.total) * dir;
        case "status":       return a.status.localeCompare(b.status) * dir;
        case "items":        return (a.items.length - b.items.length) * dir;
      }
    });
  }, [orders, search, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir(k === "created_at" || k === "total" ? "desc" : "asc"); }
  };

  const pharmacyAct = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : "Action failed"); }
    finally { setBusy(false); }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
      {/* Top stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MiniStat label="এই মাস" value={`৳ ${stats?.this_month_revenue ?? 0}`} />
        <MiniStat label="মোট আয়" value={`৳ ${stats?.lifetime_revenue ?? 0}`} />
        <MiniStat label="বাতিল" value={`${stats?.cancelled_count ?? 0}`} />
        <MiniStat label="Rx রিজেক্ট" value={`${stats?.rejected_count ?? 0}`} />
      </div>

      {/* Top products — header sticky inside the card, body capped with
          internal scroll so the Orders table below is always reachable
          without long page scrolling even if many products are listed. */}
      {stats?.top_products && stats.top_products.length > 0 && (
        <Card className="!p-0 overflow-hidden">
          <div className="flex items-center justify-between border-b border-black/5 px-4 py-3 dark:border-white/10">
            <h3 className="text-base font-semibold">সেরা বিক্রি হওয়া প্রোডাক্ট</h3>
            <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
              {stats.top_products.length}
            </span>
          </div>
          <div className="max-h-[260px] overflow-y-auto overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white/95 text-xs font-semibold opacity-70 backdrop-blur dark:bg-[#0b1018]/95">
                <tr>
                  <th className="px-4 py-2 text-left">প্রোডাক্ট</th>
                  <th className="px-4 py-2 text-right">Unit</th>
                  <th className="px-4 py-2 text-right">আয়</th>
                </tr>
              </thead>
              <tbody>
                {stats.top_products.map((p, i) => (
                  <tr key={i} className="border-t border-black/5 dark:border-white/10">
                    <td className="px-4 py-1.5">{p.name}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{p.qty}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">৳ {Math.round(p.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Excel-like orders table */}
      <Card className="!p-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-black/5 px-4 py-3 dark:border-white/10">
          <h3 className="text-base font-bold">অর্ডার</h3>
          <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">{filtered.length}</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="কাস্টমার, ফোন, address বা ID search করুন…"
            className="ml-2 min-w-[220px] flex-1 rounded-full border border-black/10 bg-white/70 px-3 py-1.5 text-xs dark:border-white/10 dark:bg-white/5"
          />
          <div className="flex flex-wrap gap-1">
            {(["all", "pending", "confirmed", "packaging", "ready", "dispatched", "delivered", "rejected", "cancelled"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`rounded-full px-2.5 py-1 text-xs font-semibold transition ${
                  statusFilter === s
                    ? "bg-brand-500 text-white"
                    : "bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
                }`}
              >{s === "all" ? "সব" : STATUS_LABELS[s]}</button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-[960px] w-full text-sm">
            <thead className="bg-black/[0.04] text-xs font-semibold opacity-70 dark:bg-white/5">
              <tr>
                <Th label="Order #" />
                <Th label="তারিখ" k="created_at" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <Th label="কাস্টমার" k="customer_name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <Th label="ফোন" />
                <Th label="ঠিকানা" />
                <Th label="আইটেম" k="items" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                <Th label="ঔষধ" align="right" />
                <Th label="ডেলিভারি" align="right" />
                <Th label="মোট" k="total" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                <Th label="Status" k="status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={10} className="py-8 text-center text-sm opacity-60">কোন order নেই।</td></tr>
              )}
              {filtered.map((o) => {
                const isActive = active?.id === o.id;
                return (
                  <tr
                    key={o.id}
                    onClick={() => setActive(o)}
                    className={`cursor-pointer border-t border-black/5 transition hover:bg-brand-50/50 dark:border-white/10 dark:hover:bg-brand-500/10 ${
                      isActive ? "bg-brand-50 dark:bg-brand-500/10" : ""
                    }`}
                  >
                    <td className="px-3 py-2 font-mono text-xs">#{o.id.slice(0, 8)}</td>
                    <td className="px-3 py-2 text-xs opacity-70">{fmtDate(o.created_at ?? "")}</td>
                    <td className="px-3 py-2 font-medium">{o.customer_name}</td>
                    <td className="px-3 py-2 text-xs opacity-70">{o.customer_phone}</td>
                    <td className="px-3 py-2 max-w-[220px] truncate text-xs opacity-70" title={displayAddress(o.delivery_address)}>{displayAddress(o.delivery_address)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{o.items.length}</td>
                    <td className="px-3 py-2 text-right tabular-nums">৳ {o.subtotal}</td>
                    <td className="px-3 py-2 text-right tabular-nums opacity-70">৳ {o.delivery_fee}</td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums">৳ {o.total}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_COLORS[o.status]}`}>
                        {STATUS_LABELS[o.status] ?? o.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {active && (
        <OrderPanel
          order={active}
          pharmacy={me}
          busy={busy}
          onClose={() => setActive(null)}
          onConfirm={() => pharmacyAct(() => pharmacyApi.confirmOrder(active.id))}
          onReject={(reason) => pharmacyAct(() => pharmacyApi.rejectOrder(active.id, reason))}
          onStatus={(s) => pharmacyAct(() => pharmacyApi.setOrderStatus(active.id, s))}
          onMessage={(b, k) => pharmacyAct(() => pharmacyApi.postMessage(active.id, b, k))}
          onDispatch={() => pharmacyAct(() => pharmacyApi.dispatchRiders(active.id))}
        />
      )}
    </motion.div>
  );
}

function fmtDate(iso: string) {
  try { return new Date(iso).toLocaleString("bn-BD", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }); }
  catch { return iso; }
}

function displayAddress(address: string): string {
  if (address === "AI prescription order — see chat") return "AI prescription order — chat দেখুন";
  return address;
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="!p-4">
      <p className="text-xs font-semibold opacity-60">{label}</p>
      <p className="mt-1 text-2xl font-extrabold tabular-nums">{value}</p>
    </Card>
  );
}

function Th({
  label, k, sortKey, sortDir, onSort, align,
}: {
  label: string;
  k?: SortKey;
  sortKey?: SortKey;
  sortDir?: SortDir;
  onSort?: (k: SortKey) => void;
  align?: "right";
}) {
  const isSorted = k && sortKey === k;
  const cls = `px-3 py-2 ${align === "right" ? "text-right" : "text-left"} ${k ? "cursor-pointer select-none hover:opacity-100" : ""}`;
  return (
    <th onClick={k && onSort ? () => onSort(k) : undefined} className={cls}>
      {label}{isSorted && (sortDir === "asc" ? " ▲" : " ▼")}
    </th>
  );
}

function OrderPanel({
  order, pharmacy, busy, onClose, onConfirm, onReject, onStatus, onMessage, onDispatch,
}: {
  order: PharmacyOrder;
  pharmacy: PharmacyMe;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onReject: (reason: string) => void;
  onStatus: (s: OrderStatus) => void;
  onMessage: (body: string, preset?: string) => void;
  onDispatch: () => void;
}) {
  const [composer, setComposer] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  return (
    <Card>
      <div className="mb-3 flex items-start gap-3">
        <div className="flex-1">
          <h3 className="text-base font-semibold">অর্ডার #{order.id.slice(0, 8)}</h3>
          <p className="text-sm opacity-70">
            {order.customer_name} • <a href={`tel:${order.customer_phone}`} className="text-brand-600">{order.customer_phone}</a>
          </p>
          <p className="text-xs opacity-60">{order.delivery_address}</p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_COLORS[order.status]}`}>{STATUS_LABELS[order.status] ?? order.status}</span>
        <button onClick={onClose} className="rounded-full bg-black/5 p-1.5 hover:bg-black/10 dark:bg-white/10"><X size={14} /></button>
      </div>

      <div className="mb-4 overflow-hidden rounded-xl border border-black/5 dark:border-white/10">
        {order.items.map((it, i) => (
          <div key={i} className="flex items-center justify-between border-b border-black/5 px-3 py-2 text-sm last:border-0 dark:border-white/10">
            <span className="flex-1 truncate">{it.name}</span>
            <span className="opacity-70">×{it.qty}</span>
            <span className="ml-3 w-20 text-right font-semibold tabular-nums">৳ {Math.round(it.price * it.qty)}</span>
          </div>
        ))}
        <div className="flex items-center justify-between bg-black/[0.03] px-3 py-2 text-sm font-bold dark:bg-white/5">
          <span>মোট (৳{order.delivery_fee} ডেলিভারি সহ)</span>
          <span>৳ {order.total}</span>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {order.status === "pending" && (
          <>
            <button onClick={onConfirm} disabled={busy} className="rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50">Confirm করুন</button>
            <input
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="কারণ (optional)"
              className="flex-1 min-w-[140px] rounded-full border border-black/10 bg-white/70 px-3 py-1.5 text-xs dark:border-white/10 dark:bg-white/5"
            />
            <button onClick={() => onReject(rejectReason)} disabled={busy} className="rounded-full bg-rose-500 px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50">Reject করুন</button>
          </>
        )}
        {(order.status === "confirmed" || order.status === "packaging") && (
          <button onClick={() => onStatus("packaging")} disabled={busy} className="rounded-full bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white">প্যাকিং চলছে</button>
        )}
        {(order.status === "confirmed" || order.status === "packaging" || order.status === "ready") && (
          <button onClick={() => onStatus("ready")} disabled={busy} className="rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white">Ready mark করুন</button>
        )}
        {(order.status === "ready" || order.status === "confirmed" || order.status === "packaging") && pharmacy.lat && pharmacy.lng && (
          <button onClick={onDispatch} disabled={busy} className="inline-flex items-center gap-1 rounded-full bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white">
            <Truck size={12} /> ৫ km rider broadcast
          </button>
        )}
        {order.status === "dispatched" && (
          <button onClick={() => onStatus("delivered")} disabled={busy} className="rounded-full bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white">Delivered mark করুন</button>
        )}
      </div>

      <div className="rounded-2xl border border-black/5 dark:border-white/10">
        <div className="flex items-center gap-2 border-b border-black/5 px-3 py-2 text-xs font-semibold dark:border-white/10">
          <MessageSquare size={12} /> Customer chat
        </div>
        <div className="max-h-72 space-y-2 overflow-y-auto p-3">
          {(order.messages || []).map((m) => {
            const mine = m.sender_role === "pharmacy";
            const sys = m.sender_role === "system";
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[75%] rounded-2xl px-3 py-1.5 text-sm ${
                  sys ? "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200" :
                  mine ? "bg-brand-500 text-white" : "bg-black/5 dark:bg-white/10"
                }`}>
                  {!sys && <p className="text-[9px] font-bold uppercase opacity-70">{m.sender_role}</p>}
                  <p>{m.body}</p>
                </div>
              </div>
            );
          })}
        </div>
        <div className="border-t border-black/5 p-2 dark:border-white/10">
          <div className="flex gap-2">
            <input
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              placeholder="বার্তা লিখুন…"
              className="flex-1 rounded-full border border-black/10 bg-white/70 px-3 py-1.5 text-sm dark:border-white/10 dark:bg-white/5"
              onKeyDown={(e) => {
                if (e.key === "Enter" && composer.trim()) {
                  onMessage(composer.trim());
                  setComposer("");
                }
              }}
            />
            <button
              onClick={() => { if (composer.trim()) { onMessage(composer.trim()); setComposer(""); } }}
              disabled={busy || !composer.trim()}
              className="rounded-full bg-brand-500 p-2 text-white disabled:opacity-50"
            ><Send size={14} /></button>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ---------------------------- subscription ---------------------------- */

function SubscriptionTab({ me, onSaved }: { me: PharmacyMe; onSaved: (m: PharmacyMe) => void }) {
  const [pendingTier, setPendingTier] = useState<SubscriptionTier | null>(null);

  const switchTo = async (t: SubscriptionTier) => {
    setPendingTier(null);
    try { onSaved(await pharmacyApi.update({ subscription_tier: t })); } catch {}
  };

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
      <Card>
        <h2 className="mb-1 text-lg font-bold">Subscription plan</h2>
        <p className="text-sm opacity-70">
          আপনার current plan: <strong>{TIER_INFO[me.subscription_tier].label}</strong>। যেকোনো সময় switch করতে পারেন।
        </p>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        {(["C", "B", "A"] as SubscriptionTier[]).map((t) => {
          const info = TIER_INFO[t];
          const current = me.subscription_tier === t;
          return (
            <div key={t}
              className={`group relative overflow-hidden rounded-2xl border-2 bg-white/70 p-5 backdrop-blur dark:bg-white/5 ${
                current ? "border-brand-500" : "border-black/5 dark:border-white/10"
              }`}
            >
              <div className={`absolute inset-x-0 top-0 h-2 bg-gradient-to-r ${info.color}`} />
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-xl font-extrabold">{info.label}</h3>
                {current && <Pill tone="brand">Current plan</Pill>}
              </div>
              <Pill tone="emerald"><BadgeCheck size={11} /> {info.badge}</Pill>
              <ul className="mt-4 space-y-1.5 text-sm">
                <li>📊 {info.impressions}</li>
                <li>📋 {info.rx_offers}</li>
                <li className="opacity-70">{info.blurb}</li>
              </ul>
              {!current && (
                <button
                  onClick={() => setPendingTier(t)}
                  className={`mt-4 w-full rounded-full bg-gradient-to-r ${info.color} px-3 py-2 text-sm font-semibold text-white hover:brightness-110`}
                >
                  {info.label}-এ switch করুন
                </button>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmModal
        open={!!pendingTier}
        onClose={() => setPendingTier(null)}
        onConfirm={() => pendingTier && switchTo(pendingTier)}
        title={`Switch to ${pendingTier ? TIER_INFO[pendingTier].label : ""}?`}
        body="Plan পরিবর্তন করলে আপনার impression count, prescription offer ratio আর map badge পরিবর্তন হবে। নিশ্চিত?"
        confirmText="হ্যাঁ, switch করুন"
      />
    </motion.div>
  );
}


