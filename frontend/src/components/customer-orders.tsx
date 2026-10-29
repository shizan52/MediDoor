"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronRight,
  Home as HomeIcon,
  Loader2,
  MapPin,
  MessageCircle,
  Package,
  Receipt,
  ScanLine,
  Star,
  User as UserIcon,
  XCircle,
} from "lucide-react";
import { api, session } from "@/lib/api";
import { ThemeToggle } from "@/components/theme-toggle";
import { MobileTabBar } from "@/components/mobile-nav";
import { MessengerDock } from "@/components/messenger-dock";

type OrderItem = { name: string; qty: number };
type Order = {
  id: string;
  status: string;
  items: OrderItem[];
  item_count: number;
  total: number;
  created_at: string | null;
  pharmacy: { id: string; name: string; banner_photo_url: string | null; rating: number | null };
  conversation_id: string | null;
};
type OrdersResp = {
  orders: Order[];
  totals: { spent_delivered: number; delivered_count: number; order_count?: number };
};

const STATUS_CLASS: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  confirmed: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  preparing: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  awaiting_rider: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  in_transit: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  out_for_delivery: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  delivered: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  cancelled: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  rejected: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "Pending", confirmed: "Confirmed", preparing: "Preparing",
  awaiting_rider: "Finding rider", in_transit: "On the way",
  out_for_delivery: "Out for delivery", delivered: "Delivered",
  cancelled: "Cancelled", rejected: "Rejected",
};

function fmtDate(s: string | null): string {
  if (!s) return "";
  try {
    return new Date(s).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return s; }
}
const canCancel = (s: string) => ["pending", "confirmed"].includes(s);

/** App-style Orders page for the web-mobile experience (parity with the
 *  customer app's /orders). Chat opens the messenger dock on the landing. */
export function CustomerOrdersPage() {
  const router = useRouter();
  const [data, setData] = useState<OrdersResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = () =>
    api<OrdersResp>("/api/customer/me/orders")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Load failed"));

  useEffect(() => {
    if (!session.access()) { router.replace("/login?role=customer&next=/customer/orders"); return; }
    // A logged-in pharmacy/rider has a token but no customer order history —
    // calling the API would 403. Bounce to a clean customer-login notice
    // instead of surfacing that error.
    if (session.role() !== "customer") { router.replace("/login?role=customer&msg=customer-only"); return; }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // Open the order's conversation IN PLACE via the dock mounted on this page —
  // no navigation to the home screen.
  const openChat = (o: Order) => {
    window.dispatchEvent(new CustomEvent("medidoor-open-chat", {
      detail: { pharmacy_id: o.pharmacy.id, conversation_id: o.conversation_id },
    }));
  };

  const cancelOrder = async (id: string) => {
    if (typeof window !== "undefined" && !window.confirm("এই অর্ডারটি বাতিল করতে চান?")) return;
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/orders/${id}/cancel`, { method: "POST" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancel failed");
    } finally { setBusyId(null); }
  };

  return (
    <main className="relative min-h-screen bg-gradient-to-br from-brand-50 via-white to-brand-100 dark:from-[#070b12] dark:via-[#0b1018] dark:to-[#091622]">
      <header className="sticky top-0 z-30 border-b border-black/5 bg-white/80 backdrop-blur dark:border-white/10 dark:bg-[#0b1018]/80">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-3">
          <button onClick={() => router.push("/")} aria-label="Back" className="grid h-9 w-9 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10">
            <ArrowLeft size={18} />
          </button>
          <h1 className="flex-1 text-base font-bold">My Orders</h1>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 pb-28 pt-4 sm:pb-8">
        {data && (
          <div className="mb-3 grid grid-cols-2 gap-2">
            <div className="rounded-2xl border border-black/5 bg-white/85 p-3 shadow-sm dark:border-white/10 dark:bg-white/5">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">Spent</p>
              <p className="mt-1 text-lg font-bold">৳{data.totals.spent_delivered.toFixed(0)}</p>
            </div>
            <div className="rounded-2xl border border-black/5 bg-white/85 p-3 shadow-sm dark:border-white/10 dark:bg-white/5">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">Delivered</p>
              <p className="mt-1 text-lg font-bold">{data.totals.delivered_count}</p>
            </div>
          </div>
        )}

        {!data && !error && (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading orders…
          </div>
        )}
        {error && <p className="px-1 text-sm text-rose-500">{error}</p>}
        {data && data.orders.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-3xl border border-dashed border-black/10 bg-white/60 p-10 text-center text-xs text-slate-500 dark:border-white/10 dark:bg-white/5">
            <Package size={22} className="opacity-50" />
            <p>এখনও কোনও order নেই — Home থেকে browse শুরু করুন।</p>
          </div>
        )}

        <div className="space-y-2.5">
          {data?.orders.map((o) => (
            <div key={o.id} className="rounded-2xl border border-black/5 bg-white/85 p-3 shadow-sm dark:border-white/10 dark:bg-white/5">
              <div className="flex items-center gap-3">
                <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-xl bg-brand-100 dark:bg-brand-500/15">
                  {o.pharmacy.banner_photo_url ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={o.pharmacy.banner_photo_url} alt={o.pharmacy.name} className="h-full w-full object-cover" />
                  ) : (
                    <Package size={20} className="text-brand-600 dark:text-brand-200" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold">{o.pharmacy.name}</p>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_CLASS[o.status] ?? "bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-slate-200"}`}>
                      {STATUS_LABEL[o.status] ?? o.status}
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
                <button type="button" onClick={() => openChat(o)} className="flex items-center justify-center gap-1.5 rounded-full border border-black/10 py-2 text-[11px] font-semibold text-slate-700 hover:bg-black/5 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/5">
                  <MessageCircle size={12} /> Chat
                </button>
                <button type="button" onClick={() => openChat(o)} className="flex items-center justify-center gap-1.5 rounded-full bg-brand-500 py-2 text-[11px] font-semibold text-white hover:bg-brand-600">
                  <MapPin size={12} /> Track
                </button>
              </div>
              {canCancel(o.status) && (
                <button type="button" onClick={() => cancelOrder(o.id)} disabled={busyId === o.id} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-full border border-rose-300/70 bg-rose-50 py-2 text-[11px] font-semibold text-rose-700 disabled:opacity-60 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
                  {busyId === o.id ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />} Order cancel করুন
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <MobileTabBar
        tabs={[
          { key: "home", label: "হোম", icon: <HomeIcon size={20} />, onClick: () => router.push("/") },
          { key: "chats", label: "চ্যাট", icon: <MessageCircle size={20} />, onClick: () => router.push("/customer/chats") },
          { key: "rx", label: "Rx স্ক্যান", icon: <ScanLine size={20} />, onClick: () => { try { window.sessionStorage.setItem("medidoor_home_intent", "rx"); } catch { /* ignore */ } router.push("/"); } },
          { key: "orders", label: "অর্ডার", icon: <Receipt size={20} />, active: true, onClick: () => {} },
          { key: "profile", label: "প্রোফাইল", icon: <UserIcon size={20} />, onClick: () => router.push("/customer/profile") },
        ]}
      />

      {/* Mounted here so Chat / Track opens the conversation IN PLACE. */}
      <MessengerDock navInset />
    </main>
  );
}
