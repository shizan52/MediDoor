"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  CheckCircle2,
  ChevronRight,
  Home as HomeIcon,
  Loader2,
  LogOut,
  Mail,
  MapPin,
  MessageCircle,
  Package,
  Phone,
  Receipt,
  ScanLine,
  Sparkles,
  Upload,
  User as UserIcon,
  X,
  XCircle,
} from "lucide-react";
import { api, session, type Role } from "@/lib/api";
import { BrandLogo } from "@/components/brand-logo";
import { ProfilePhotoEditor } from "@/components/profile-photo-editor";
import { ThemeToggle } from "@/components/theme-toggle";
import { MobileTabBar } from "@/components/mobile-nav";
import { MessengerDock } from "@/components/messenger-dock";

type CustomerProfile = {
  first_name?: string;
  last_name?: string;
  phone_number?: string;
  profile_photo_url?: string | null;
};

type Me = {
  account_id: string;
  gmail: string;
  role: Role;
  is_registered: boolean;
  profile?: CustomerProfile | null;
};

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

type UsageEntry = { used: number; limit: number; remaining: number; month: string };
type UsageResp = { smart_prescription?: UsageEntry; symptom_search?: UsageEntry };

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  accepted: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  preparing: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  awaiting_rider: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  in_transit: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  out_for_delivery: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  delivered: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  cancelled: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  rejected: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  accepted: "Accepted",
  preparing: "প্যাকিং চলছে",
  awaiting_rider: "Rider খোঁজা হচ্ছে",
  in_transit: "পথে আছে",
  out_for_delivery: "ডেলিভারি পথে",
  delivered: "ডেলিভার্ড",
  cancelled: "বাতিল",
  rejected: "রিজেক্ট হয়েছে",
};

function fmtDate(s: string | null): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString("bn-BD", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return s;
  }
}

export function CustomerMyProfilePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [totals, setTotals] = useState<OrdersResp["totals"] | null>(null);
  const [usage, setUsage] = useState<UsageResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [renewingQuota, setRenewingQuota] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!session.access()) {
      router.replace("/login?role=customer&next=/customer/profile");
      return;
    }
    // Role-gate BEFORE any customer-only call. Previously the Promise.all
    // fired `/api/customer/me/orders` for a logged-in pharmacy/rider too,
    // which 403'd and rejected the whole batch (the role check below never
    // ran). Bounce non-customers to a clean login notice up front.
    if (session.role() !== "customer") {
      router.replace("/login?role=customer&msg=customer-only");
      return;
    }
    (async () => {
      try {
        const [m, o, u] = await Promise.all([
          api<Me>("/api/auth/me"),
          api<OrdersResp>("/api/customer/me/orders"),
          api<UsageResp>("/api/ai/usage").catch(() => ({} as UsageResp)),
        ]);
        if (m.role !== "customer") {
          router.replace(`/${m.role}`);
          return;
        }
        setMe(m);
        setOrders(o.orders || []);
        setTotals(o.totals || null);
        setUsage(u || null);
      } catch (ex) {
        setError(ex instanceof Error ? ex.message : "Load failed");
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  const onLogout = () => {
    setLoggingOut(true);
    void api("/api/auth/logout", { method: "POST" }).catch(() => {});
    session.clear();
    router.replace("/login?role=customer");
  };

  const onMessagePharmacy = (o: Order) => {
    if (!o.conversation_id && !o.pharmacy.id) {
      setError("এই pharmacy-র সাথে chat খুলতে পারলাম না।");
      return;
    }
    // Open the conversation IN PLACE via the dock mounted on this page — no
    // navigation to the home screen.
    window.dispatchEvent(
      new CustomEvent("medidoor-open-chat", {
        detail: { pharmacy_id: o.pharmacy.id, conversation_id: o.conversation_id },
      })
    );
  };

  const onRenewAiQuota = async () => {
    // Quota reset is a paid action (each AI call costs us real money). Payment
    // isn't built yet, so we just inform the user — the free quota refills on
    // the 1st of every month automatically.
    setError(null);
    setOkMsg(
      "Free AI quota এই মাসে শেষ হলে reset করতে payment লাগবে — এই feature খুব শীঘ্রই আসছে। " +
      "আপাতত প্রতি মাসের ১ তারিখে quota নিজে থেকে reset হবে।",
    );
  };

  const profile = me?.profile ?? null;
  const displayName = useMemo(() => {
    const fn = profile?.first_name?.trim();
    const ln = profile?.last_name?.trim();
    return [fn, ln].filter(Boolean).join(" ") || me?.gmail?.split("@")[0] || "Customer";
  }, [profile, me]);

  // Persist a new (or removed) profile photo, then refresh local state so
  // every avatar on the page updates instantly.
  const onSavePhoto = async (url: string | null) => {
    const updated = await api<Me>("/api/auth/me/customer", {
      method: "PATCH",
      body: JSON.stringify({ profile_photo_url: url }),
    });
    setMe(updated);
    setOkMsg(url ? "প্রোফাইল ছবি আপডেট হয়েছে।" : "প্রোফাইল ছবি সরানো হয়েছে।");
  };

  const sym = usage?.symptom_search;
  const rx = usage?.smart_prescription;

  return (
    <main className="relative min-h-screen overflow-hidden bg-gradient-to-br from-brand-50 via-white to-brand-100 dark:from-[#070b12] dark:via-[#0b1018] dark:to-[#091622]">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-32 -left-24 h-[420px] w-[420px] rounded-full bg-brand-300/40 blur-3xl animate-blob" />
        <div className="absolute top-1/3 -right-24 h-[460px] w-[460px] rounded-full bg-emerald-300/30 blur-3xl animate-blob [animation-delay:2s]" />
      </div>

      <header className="sticky top-0 z-30 border-b border-black/5 bg-white/70 backdrop-blur dark:border-white/10 dark:bg-[#0b1018]/70">
        <div className="flex w-full items-center gap-3 px-6 py-3 lg:px-10">
          <BrandLogo className="h-9 w-auto" />
          <button
            onClick={() => router.push("/")}
            className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-black/10 dark:bg-white/10 dark:text-slate-100 dark:hover:bg-white/20"
          >
            <ArrowLeft size={12} /> হোম
          </button>

          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <button
              onClick={onLogout}
              disabled={loggingOut}
              className="inline-flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-black/10 disabled:opacity-60 dark:bg-white/10 dark:text-slate-100 dark:hover:bg-white/20"
            >
              {loggingOut ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />} {loggingOut ? "লগআউট হচ্ছে…" : "লগআউট"}
            </button>
          </div>
        </div>
      </header>

      <div className="px-4 py-4 pb-28 sm:px-6 sm:py-6 sm:pb-6 lg:px-10">
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="mb-4 flex items-start gap-2 rounded-2xl border border-red-300/60 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-200"
            >
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              <p className="flex-1">{error}</p>
              <button onClick={() => setError(null)}><X size={14} /></button>
            </motion.div>
          )}
          {okMsg && (
            <motion.div
              initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="mb-4 flex items-start gap-2 rounded-2xl border border-emerald-300/60 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-200"
            >
              <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
              <p className="flex-1">{okMsg}</p>
              <button onClick={() => setOkMsg(null)}><X size={14} /></button>
            </motion.div>
          )}
        </AnimatePresence>

        {loading && <p className="opacity-70">লোড হচ্ছে…</p>}

        {!loading && me && (
          <>
          {/* ===== Mobile: app-style profile — mirrors the customer app
                 (green hero card + stats + contact + action tiles).
                 Hidden ≥sm, where the original desktop layout takes over. ===== */}
          <div className="sm:hidden">
            <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-brand-500 to-emerald-500 p-4 text-white shadow-lg shadow-brand-500/25">
              <div className="flex items-center gap-3">
                <ProfilePhotoEditor
                  photoUrl={profile?.profile_photo_url}
                  displayName={displayName}
                  onSave={onSavePhoto}
                  className="h-16 w-16"
                  ringClassName="ring-2 ring-white/40"
                  fallbackClassName="bg-white/20 text-white"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-lg font-extrabold">{displayName}</p>
                  <p className="truncate text-[12px] text-white/85">{me.gmail}</p>
                  <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold">
                    <BadgeCheck size={11} /> Verified customer
                  </span>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-2xl bg-white/15 py-2">
                  <p className="text-lg font-extrabold leading-none">{totals?.order_count ?? orders.length}</p>
                  <p className="mt-1 text-[10px] font-medium text-white/80">Orders</p>
                </div>
                <div className="rounded-2xl bg-white/15 py-2">
                  <p className="text-lg font-extrabold leading-none">{totals?.delivered_count ?? 0}</p>
                  <p className="mt-1 text-[10px] font-medium text-white/80">Delivered</p>
                </div>
                <div className="rounded-2xl bg-white/15 py-2">
                  <p className="text-lg font-extrabold leading-none">{(rx?.remaining ?? 0) + (sym?.remaining ?? 0)}</p>
                  <p className="mt-1 text-[10px] font-medium text-white/80">AI left</p>
                </div>
              </div>
            </div>

            {/* Contact */}
            <div className="mt-3 space-y-2 rounded-2xl border border-black/5 bg-white/85 p-3 shadow-sm dark:border-white/10 dark:bg-white/5">
              <div className="flex items-center gap-2">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300"><Mail size={14} /></span>
                <span className="min-w-0"><span className="block text-[10px] uppercase tracking-wide text-slate-400">Email</span><span className="block truncate text-[13px] font-semibold">{me.gmail}</span></span>
              </div>
              <div className="flex items-center gap-2">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300"><Phone size={14} /></span>
                <span className="min-w-0"><span className="block text-[10px] uppercase tracking-wide text-slate-400">Phone</span><span className="block truncate text-[13px] font-semibold">{profile?.phone_number || "—"}</span></span>
              </div>
            </div>

            {/* Action tiles */}
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <button type="button" onClick={() => router.push("/")} className="flex items-center gap-2.5 rounded-2xl border border-black/5 bg-white/85 p-3 text-left shadow-sm dark:border-white/10 dark:bg-white/5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300"><HomeIcon size={17} /></span>
                <span className="flex-1 text-sm font-semibold">Home</span>
                <ChevronRight size={16} className="text-slate-400" />
              </button>
              <button type="button" onClick={() => router.push("/customer/orders")} className="flex items-center gap-2.5 rounded-2xl border border-black/5 bg-white/85 p-3 text-left shadow-sm dark:border-white/10 dark:bg-white/5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300"><Receipt size={17} /></span>
                <span className="flex-1 text-sm font-semibold">Orders</span>
                <ChevronRight size={16} className="text-slate-400" />
              </button>
              <button type="button" onClick={() => { try { window.sessionStorage.setItem("medidoor_home_intent", "nearby"); } catch { /* ignore */ } router.push("/"); }} className="flex items-center gap-2.5 rounded-2xl border border-black/5 bg-white/85 p-3 text-left shadow-sm dark:border-white/10 dark:bg-white/5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300"><MapPin size={17} /></span>
                <span className="flex-1 text-sm font-semibold">Nearby</span>
                <ChevronRight size={16} className="text-slate-400" />
              </button>
              <button type="button" onClick={() => router.push("/customer/chats")} className="flex items-center gap-2.5 rounded-2xl border border-black/5 bg-white/85 p-3 text-left shadow-sm dark:border-white/10 dark:bg-white/5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300"><MessageCircle size={17} /></span>
                <span className="flex-1 text-sm font-semibold">Messages</span>
                <ChevronRight size={16} className="text-slate-400" />
              </button>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
            {/* ---------------- Left: identity ---------------- */}
            <div className="space-y-6">
              <motion.div
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                className="hidden overflow-hidden rounded-3xl border border-black/5 bg-white/80 shadow-xl backdrop-blur sm:block dark:border-white/10 dark:bg-white/5"
              >
                <div className="flex items-center gap-4 p-5">
                  <ProfilePhotoEditor
                    photoUrl={profile?.profile_photo_url}
                    displayName={displayName}
                    onSave={onSavePhoto}
                    className="h-16 w-16"
                    rounded="rounded-2xl"
                    ringClassName="ring-2 ring-brand-400/40"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-bold text-slate-900 dark:text-slate-100">
                      {displayName}
                    </p>
                    <p className="truncate text-xs text-slate-600 dark:text-slate-400">
                      {me.gmail}
                    </p>
                    <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand-500/15 px-2 py-0.5 text-[10px] font-bold text-brand-700 dark:text-brand-200">
                      <UserIcon size={10} /> কাস্টমার
                    </span>
                  </div>
                </div>
                <div className="border-t border-black/5 px-5 py-3 text-xs text-slate-700 dark:border-white/10 dark:text-slate-300">
                  <p className="mb-1 flex items-center gap-2">
                    <Phone size={12} className="opacity-60" />
                    ফোন: <span className="font-medium">{profile?.phone_number || "—"}</span>
                  </p>
                  <p className="flex items-center gap-2">
                    <Package size={12} className="opacity-60" />
                    মোট অর্ডার: <span className="font-medium">{totals?.order_count ?? orders.length}</span>
                  </p>
                </div>
              </motion.div>

              {/* Spend summary */}
              <motion.div
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                className="hidden overflow-hidden rounded-3xl border border-emerald-200 bg-gradient-to-br from-emerald-500 to-brand-600 p-5 text-white shadow-xl sm:block dark:border-emerald-500/30"
              >
                <p className="text-xs font-semibold text-white/80">
                  ডেলিভার্ড অর্ডারে মোট খরচ
                </p>
                <p className="mt-1 text-3xl font-extrabold tabular-nums">
                  ৳ {(totals?.spent_delivered ?? 0).toFixed(2)}
                </p>
                <p className="mt-1 text-xs text-white/80">
                  {totals?.delivered_count ?? 0} ডেলিভার্ড অর্ডার
                </p>
              </motion.div>

              {/* AI quotas */}
              <motion.div
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                className="rounded-3xl border border-brand-200 bg-white/80 p-5 shadow-lg backdrop-blur dark:border-white/10 dark:bg-white/5"
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <p className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                    <Sparkles size={14} className="text-brand-600" />
                    medi AI মাসিক free quota
                  </p>
                  <button
                    type="button"
                    onClick={onRenewAiQuota}
                    disabled={renewingQuota}
                    title="Quota reset করতে payment লাগবে — শীঘ্রই আসছে। প্রতি মাসে নিজে থেকে reset হয়।"
                    className="inline-flex shrink-0 items-center gap-1 rounded-full border border-brand-300 bg-white px-3 py-1.5 text-[11px] font-bold text-brand-700 shadow-sm transition hover:bg-brand-50 disabled:cursor-wait disabled:opacity-60 dark:border-white/15 dark:bg-white/10 dark:text-brand-200"
                  >
                    Quota reset (payment) · শীঘ্রই
                  </button>
                </div>
                <div className="space-y-3">
                  <UsageBar
                    icon={<Upload size={12} />}
                    label="Smart Prescription"
                    used={rx?.used ?? 0}
                    limit={rx?.limit ?? 2}
                  />
                  <UsageBar
                    icon={<Sparkles size={12} />}
                    label="Symptom search"
                    used={sym?.used ?? 0}
                    limit={sym?.limit ?? 5}
                  />
                </div>
                <p className="mt-3 text-[11px] opacity-70">
                  ঔষধের নাম দিয়ে normal search unlimited — শুধু AI symptom mapping এই quota-তে count হয়।
                </p>
              </motion.div>
            </div>

            {/* ---------------- Right: order history ---------------- */}
            <div id="my-orders" className="scroll-mt-20">
              <div className="mb-4 flex items-center gap-2">
                <Package size={16} className="text-brand-600" />
                <h2 className="text-lg font-bold">আপনার অর্ডার</h2>
                <span className="text-xs opacity-60">({orders.length})</span>
              </div>

              {orders.length === 0 ? (
                <div className="rounded-3xl border border-dashed border-black/10 bg-white/60 p-10 text-center dark:border-white/10 dark:bg-white/5">
                  <Package className="mx-auto mb-3 text-brand-500" />
                  <p className="text-base font-medium">এখনও কোনো order করা হয়নি।</p>
                  <p className="mt-1 text-sm opacity-70">
                    Home page থেকে nearby pharmacy খুঁজে প্রথম order place করুন।
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {orders.map((o) => (
                    <OrderCard
                      key={o.id}
                      o={o}
                      onMessage={() => onMessagePharmacy(o)}
                      onCancel={async () => {
                        if (typeof window === "undefined") return;
                        if (!window.confirm("এই অর্ডারটি বাতিল করতে চান?")) return;
                        try {
                          await api(`/api/orders/${o.id}/cancel`, { method: "POST" });
                          const fresh = await api<OrdersResp>("/api/customer/me/orders");
                          setOrders(fresh.orders || []);
                          setTotals(fresh.totals || null);
                          setOkMsg("Order cancel করা হয়েছে।");
                        } catch (ex) {
                          setError(ex instanceof Error ? ex.message : "Cancel failed");
                        }
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Mobile bottom tab bar — app-parity navigation (self-hidden ≥sm). */}
          <MobileTabBar
            tabs={[
              { key: "home", label: "হোম", icon: <HomeIcon size={20} />, onClick: () => router.push("/") },
              { key: "chats", label: "চ্যাট", icon: <MessageCircle size={20} />, onClick: () => router.push("/customer/chats") },
              { key: "rx", label: "Rx স্ক্যান", icon: <ScanLine size={20} />, onClick: () => { try { window.sessionStorage.setItem("medidoor_home_intent", "rx"); } catch { /* ignore */ } router.push("/"); } },
              { key: "orders", label: "অর্ডার", icon: <Receipt size={20} />, onClick: () => router.push("/customer/orders") },
              { key: "profile", label: "প্রোফাইল", icon: <UserIcon size={20} />, active: true, onClick: () => {} },
            ]}
          />
          </>
        )}
      </div>

      {/* Mounted here so "message pharmacy" opens the conversation IN PLACE. */}
      <MessengerDock navInset />
    </main>
  );
}

function UsageBar({
  icon,
  label,
  used,
  limit,
}: {
  icon: React.ReactNode;
  label: string;
  used: number;
  limit: number;
}) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const exhausted = used >= limit;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 font-medium">
          <span className="text-brand-600">{icon}</span> {label}
        </span>
        <span className={exhausted ? "font-bold text-rose-600 dark:text-rose-300" : "opacity-70"}>
          {used} / {limit}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
        <div
          className={`h-full rounded-full transition-all ${
            exhausted
              ? "bg-rose-500"
              : pct >= 75
              ? "bg-amber-500"
              : "bg-gradient-to-r from-brand-500 to-emerald-500"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function OrderCard({ o, onMessage, onCancel }: { o: Order; onMessage: () => void; onCancel: () => void | Promise<void> }) {
  const badge = STATUS_BADGE[o.status] ?? "bg-slate-500/15 text-slate-700 dark:text-slate-300";
  const cancellable = ["pending", "confirmed"].includes(o.status);
  const itemsPreview = o.items
    .slice(0, 3)
    .map((it) => `${it.name}${it.qty > 1 ? ` × ${it.qty}` : ""}`)
    .join(", ");
  const more = o.items.length > 3 ? ` +${o.items.length - 3} আরও` : "";
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="overflow-hidden rounded-2xl border border-black/5 bg-white/85 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5"
    >
      <div className="flex flex-wrap items-start gap-3 p-4">
        <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-brand-100 dark:bg-brand-500/15">
          {o.pharmacy.banner_photo_url ? (
            <Image
              src={o.pharmacy.banner_photo_url}
              alt={o.pharmacy.name}
              fill
              sizes="56px"
              className="object-cover"
              unoptimized
            />
          ) : (
            <div className="grid h-full w-full place-items-center text-brand-700 dark:text-brand-200">
              <Package size={20} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {o.pharmacy.name}
            </p>
            {o.pharmacy.rating != null && o.pharmacy.rating > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[11px] opacity-70">
                <BadgeCheck size={10} className="text-emerald-500" />
                {o.pharmacy.rating.toFixed(1)}
              </span>
            )}
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${badge}`}>
              {STATUS_LABEL[o.status] ?? o.status.replace(/_/g, " ")}
            </span>
          </div>
          <p className="mt-1 line-clamp-1 text-xs opacity-75">
            {itemsPreview}{more}
          </p>
          <p className="mt-1 text-[11px] opacity-60">{fmtDate(o.created_at)}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-extrabold tabular-nums text-slate-900 dark:text-slate-100">
            ৳ {o.total.toFixed(0)}
          </p>
          <p className="text-[10px] opacity-60">{o.item_count} আইটেম</p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-black/5 bg-black/[0.02] px-4 py-2 dark:border-white/10 dark:bg-white/[0.03]">
        {cancellable && (
          <button
            onClick={() => void onCancel()}
            className="inline-flex items-center gap-1.5 rounded-full border border-rose-300/70 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 transition dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:bg-rose-500/20"
          >
            <XCircle size={12} /> অর্ডার বাতিল
          </button>
        )}
        <button
          onClick={onMessage}
          className="inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-brand-600 transition"
        >
          <MessageCircle size={12} /> ফার্মেসিকে message
        </button>
      </div>
    </motion.div>
  );
}
