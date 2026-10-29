"use client";

/**
 * Pharmacy orders list. Tabs: New / Active / Done. Each tap →
 * /orders/[id] for full detail + actions.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ChevronRight, ChevronUp, ChevronDown, ClipboardList, LayoutGrid, List as ListIcon, Loader2, Package } from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { NotificationsBell } from "@/components/notifications-bell";
import { resolveMediaUrl, session } from "@/lib/api";
import { pharmacyApi, type OrderStatus, type PharmacyOrder } from "@/lib/pharmacy";

type Bucket = "new" | "active" | "done";
type View = "list" | "table";
type SortKey = "created_at" | "customer_name" | "total" | "status" | "items";
type SortDir = "asc" | "desc";

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

const STATUS_CLASS: Record<OrderStatus, string> = {
  pending:    "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  confirmed:  "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  packaging:  "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  ready:      "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  dispatched: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  delivered:  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  rejected:   "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  cancelled:  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};

const BUCKET_OF: Record<OrderStatus, Bucket> = {
  pending: "new",
  confirmed: "active",
  packaging: "active",
  ready: "active",
  dispatched: "active",
  delivered: "done",
  rejected: "done",
  cancelled: "done",
};

function fmtDate(s: string | null): string {
  if (!s) return "";
  try {
    return new Date(s).toLocaleString(undefined, {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch { return s; }
}

export default function OrdersListPage() {
  const router = useRouter();
  const [items, setItems] = useState<PharmacyOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket>("new");
  const [view, setView] = useState<View>("list");
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    if (session.role() !== "pharmacy") { router.replace("/login?msg=wrong-role"); return; }

    let cancelled = false;
    const load = () =>
      pharmacyApi
        .listOrders()
        .then((d) => { if (!cancelled) setItems(d.items); })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Load failed"); });
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [router]);

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { new: 0, active: 0, done: 0 };
    items?.forEach((o) => { c[BUCKET_OF[o.status]]++; });
    return c;
  }, [items]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const list = items.filter((o) => BUCKET_OF[o.status] === bucket);
    if (view !== "table") return list;
    const dir = sortDir === "asc" ? 1 : -1;
    const cmp = (a: PharmacyOrder, b: PharmacyOrder): number => {
      switch (sortKey) {
        case "created_at":
          return ((a.created_at ?? "") < (b.created_at ?? "") ? -1 : 1) * dir;
        case "customer_name":
          return a.customer_name.localeCompare(b.customer_name) * dir;
        case "total":
          return (a.total - b.total) * dir;
        case "status":
          return a.status.localeCompare(b.status) * dir;
        case "items":
          return (a.items.length - b.items.length) * dir;
      }
    };
    return [...list].sort(cmp);
  }, [items, bucket, view, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  return (
    <>
      <MobileHeader title="Orders" subtitle={items ? `${items.length} total` : undefined} right={<NotificationsBell />} />

      {/* Tabs */}
      <div className="flex items-center gap-2 px-4 pt-3">
        <div className="flex flex-1 gap-1 rounded-full bg-slate-100 p-1 dark:bg-white/5">
          {(["new", "active", "done"] as Bucket[]).map((b) => (
            <button
              key={b}
              onClick={() => setBucket(b)}
              className={[
                "tap flex-1 rounded-full py-2 text-[11px] font-semibold capitalize transition",
                bucket === b
                  ? "bg-white text-slate-900 shadow dark:bg-slate-900 dark:text-white"
                  : "text-slate-500 dark:text-slate-300",
              ].join(" ")}
            >
              {b} <span className="opacity-60">({counts[b]})</span>
            </button>
          ))}
        </div>
        {/* List vs Table view toggle */}
        <div className="flex gap-1 rounded-full bg-slate-100 p-1 dark:bg-white/5">
          <button
            onClick={() => setView("list")}
            aria-label="List view"
            className={[
              "tap grid h-8 w-8 place-items-center rounded-full",
              view === "list" ? "bg-white text-slate-900 shadow dark:bg-slate-900 dark:text-white" : "text-slate-500",
            ].join(" ")}
          >
            <ListIcon size={14} />
          </button>
          <button
            onClick={() => setView("table")}
            aria-label="Table view"
            className={[
              "tap grid h-8 w-8 place-items-center rounded-full",
              view === "table" ? "bg-white text-slate-900 shadow dark:bg-slate-900 dark:text-white" : "text-slate-500",
            ].join(" ")}
          >
            <LayoutGrid size={14} />
          </button>
        </div>
      </div>

      <div className="px-2 pt-3">
        {!items && !error && (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        )}
        {error && <p className="px-4 text-sm text-rose-500">{error}</p>}
        {filtered && filtered.length === 0 && (
          <div className="m-4 flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-8 text-center text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.02]">
            <ClipboardList size={22} className="opacity-50" />
            <p>{bucket === "new" ? "নতুন কোনো order নেই।" : `কোনো ${bucket} order নেই।`}</p>
          </div>
        )}
        {filtered && filtered.length > 0 && view === "list" &&
          filtered.map((o) => <OrderRow key={o.id} order={o} />)}
        {filtered && filtered.length > 0 && view === "table" && (
          <OrdersTable
            rows={filtered}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={toggleSort}
          />
        )}
      </div>
    </>
  );
}

function OrderRow({ order: o }: { order: PharmacyOrder }) {
  const firstImg = o.items.find((it) => it.image_url)?.image_url;
  const banner = firstImg ? resolveMediaUrl(firstImg) : "";
  return (
    <Link
      href={`/orders/${o.id}`}
      className="tap mb-2 flex items-center gap-3 rounded-2xl border border-slate-200/70 bg-white p-2.5 active:bg-slate-100 dark:border-white/10 dark:bg-white/[0.04] dark:active:bg-white/10"
    >
      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-slate-200 dark:bg-white/10">
        {banner ? (
          <Image src={banner} alt="" fill sizes="56px" className="object-cover" />
        ) : (
          <div className="grid h-full w-full place-items-center text-slate-400">
            <Package size={20} />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-semibold">{o.customer_name}</p>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_CLASS[o.status]}`}>
            {STATUS_LABEL[o.status]}
          </span>
        </div>
        <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
          {o.items.length} item · ৳{o.total} · {fmtDate(o.created_at)}
        </p>
        {o.delivery_address && (
          <p className="truncate text-[10px] text-slate-400">📍 {o.delivery_address}</p>
        )}
      </div>
      <ChevronRight size={16} className="text-slate-400" />
    </Link>
  );
}

/* -------------------------- table view -------------------------- */

function OrdersTable({
  rows,
  sortKey,
  sortDir,
  onSort,
}: {
  rows: PharmacyOrder[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const Header = ({ k, label, align }: { k: SortKey; label: string; align?: "right" | "left" }) => {
    const active = sortKey === k;
    return (
      <button
        type="button"
        onClick={() => onSort(k)}
        className={[
          "flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wider",
          active ? "text-brand-600 dark:text-brand-300" : "text-slate-500 dark:text-slate-400",
          align === "right" ? "ml-auto" : "",
        ].join(" ")}
      >
        {label}
        {active && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
      </button>
    );
  };
  return (
    <div className="mx-2 overflow-hidden rounded-2xl border border-slate-200/70 bg-white dark:border-white/10 dark:bg-white/[0.04]">
      {/* Sortable header row */}
      <div className="grid grid-cols-[1.4fr_0.5fr_0.7fr_0.8fr_14px] items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 dark:border-white/5 dark:bg-white/[0.03]">
        <Header k="customer_name" label="Customer" />
        <Header k="items" label="Qty" align="right" />
        <Header k="total" label="Total" align="right" />
        <Header k="created_at" label="When" align="right" />
        <span />
      </div>
      {rows.map((o) => (
        <Link
          key={o.id}
          href={`/orders/${o.id}`}
          className="tap grid grid-cols-[1.4fr_0.5fr_0.7fr_0.8fr_14px] items-center gap-2 border-b border-slate-100 px-3 py-2.5 text-[12px] active:bg-slate-100 dark:border-white/5 dark:active:bg-white/5"
        >
          <div className="min-w-0">
            <p className="truncate font-semibold">{o.customer_name}</p>
            <span
              className={`mt-0.5 inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${STATUS_CLASS[o.status]}`}
            >
              {STATUS_LABEL[o.status]}
            </span>
          </div>
          <span className="text-right tabular-nums">{o.items.length}</span>
          <span className="text-right font-semibold tabular-nums">৳{o.total}</span>
          <span className="text-right text-[10px] text-slate-500 dark:text-slate-400">
            {fmtDate(o.created_at)}
          </span>
          <ChevronRight size={12} className="text-slate-400" />
        </Link>
      ))}
    </div>
  );
}
