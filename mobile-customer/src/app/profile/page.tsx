"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  LogOut,
  Sparkles,
  RefreshCw,
  Pill,
  Loader2,
  ChevronRight,
  Map as MapIcon,
  Pencil,
  Mail,
  Phone,
  CalendarDays,
  ShieldCheck,
  MessageCircle,
  ClipboardList,
} from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { InitialAvatar } from "@/components/initial-avatar";
import { ThemeToggle } from "@/components/theme-toggle";
import { api, resolveMediaUrl, session, type Role } from "@/lib/api";

type CustomerProfile = {
  first_name?: string;
  last_name?: string;
  phone_number?: string;
  date_of_birth?: string | null;
  gender?: "male" | "female" | "other" | null;
  profile_photo_url?: string | null;
};

type Me = {
  account_id: string;
  gmail: string;
  role: Role;
  is_registered: boolean;
  profile?: CustomerProfile | null;
};

type UsageEntry = { used: number; limit: number; remaining: number; month: string };
type UsageResp = { smart_prescription?: UsageEntry; symptom_search?: UsageEntry };
type OrdersResp = {
  totals?: { order_count?: number; delivered_count?: number; spent_delivered?: number };
};

export default function ProfilePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [usage, setUsage] = useState<UsageResp | null>(null);
  const [orders, setOrders] = useState<OrdersResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [renewing, setRenewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!session.access()) {
      router.replace("/login?next=/profile");
      return;
    }
    (async () => {
      try {
        const [m, u] = await Promise.all([
          api<Me>("/api/auth/me"),
          api<UsageResp>("/api/ai/usage").catch(() => ({} as UsageResp)),
        ]);
        if (m.role !== "customer") {
          router.replace("/login?msg=customer-only");
          return;
        }
        setMe(m);
        setUsage(u || null);
        api<OrdersResp>("/api/customer/me/orders")
          .then(setOrders)
          .catch(() => setOrders(null));
      } catch (ex) {
        setError(ex instanceof Error ? ex.message : "Load failed");
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  const onLogout = async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    session.clear();
    router.replace("/login");
  };

  const onRenew = async () => {
    setRenewing(true);
    setError(null);
    try {
      const r = await api<{ ok: boolean; usage: UsageResp }>("/api/ai/usage/renew", { method: "POST" });
      setUsage(r.usage);
      setOkMsg("medi AI free monthly quota renewed!");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Renew failed");
    } finally {
      setRenewing(false);
    }
  };

  const profile = me?.profile ?? null;
  const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || me?.gmail;
  const avatar = resolveMediaUrl(profile?.profile_photo_url);
  const totalRemaining = (usage?.smart_prescription?.remaining ?? 0) + (usage?.symptom_search?.remaining ?? 0);
  const totalLimit = (usage?.smart_prescription?.limit ?? 0) + (usage?.symptom_search?.limit ?? 0);
  const joinedLabel = useMemo(() => {
    if (!profile?.date_of_birth) return "Not added";
    return new Date(profile.date_of_birth).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }, [profile?.date_of_birth]);

  return (
    <>
      <MobileHeader title="My Profile" right={<ThemeToggle />} />

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-brand-500" />
        </div>
      ) : error ? (
        <p className="px-4 pt-6 text-sm text-rose-500">{error}</p>
      ) : (
        <>
          <main className="px-4 pb-3 pt-3">
            <section className="overflow-hidden rounded-[28px] border border-white/80 bg-gradient-to-br from-brand-500 via-emerald-500 to-cyan-500 p-4 text-white shadow-xl shadow-brand-500/20 dark:border-white/10">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <InitialAvatar name={name || "Customer"} src={avatar || null} size={70} className="ring-4 ring-white/35" />
                  <div className="min-w-0">
                    <p className="truncate text-xl font-bold leading-tight">{name}</p>
                    <p className="mt-1 truncate text-xs text-white/85">{me?.gmail}</p>
                    <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-white/18 px-2.5 py-1 text-[11px] font-semibold backdrop-blur">
                      <ShieldCheck size={12} /> Verified customer
                    </span>
                  </div>
                </div>
                <Link
                  href="/profile/edit"
                  aria-label="Edit profile"
                  className="tap grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/18 backdrop-blur hover:bg-white/25"
                >
                  <Pencil size={16} />
                </Link>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2">
                <Stat label="Orders" value={orders?.totals?.order_count ?? 0} />
                <Stat label="Delivered" value={orders?.totals?.delivered_count ?? 0} />
                <Stat label="AI left" value={totalLimit ? totalRemaining : "--"} />
              </div>
            </section>

            <section className="mt-4 grid grid-cols-2 gap-3">
              <Action href="/profile/edit" icon={<Pencil size={17} />} label="Edit profile" />
              <Action href="/orders" icon={<ClipboardList size={17} />} label="Orders" />
              <Action href="/map" icon={<MapIcon size={17} />} label="Nearby map" />
              <Action href="/chats" icon={<MessageCircle size={17} />} label="Messages" />
            </section>

            <section className="mt-4 rounded-[24px] border border-slate-200/80 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Sparkles size={17} className="text-brand-600 dark:text-brand-300" />
                  <p className="text-sm font-bold">medi AI quota</p>
                </div>
                <button
                  type="button"
                  onClick={onRenew}
                  disabled={renewing}
                  className="tap inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-3 py-1.5 text-[11px] font-semibold text-brand-700 disabled:opacity-60 dark:border-brand-500/25 dark:bg-brand-500/10 dark:text-brand-300"
                >
                  {renewing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  Renew
                </button>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                <QuotaTile label="Smart Rx" entry={usage?.smart_prescription} />
                <QuotaTile label="Symptom" entry={usage?.symptom_search} />
              </div>
              {okMsg && <p className="mt-2 text-[11px] text-brand-700 dark:text-brand-300">{okMsg}</p>}
            </section>

            <section className="mt-4 rounded-[24px] border border-slate-200/80 bg-white p-2 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
              <Detail icon={<Mail size={15} />} label="Email" value={me?.gmail || "Not added"} />
              <Detail icon={<Phone size={15} />} label="Phone" value={profile?.phone_number || "Not added"} />
              <Detail icon={<CalendarDays size={15} />} label="Birthday" value={joinedLabel} />
              <Detail icon={<Pill size={15} />} label="Gender" value={profile?.gender || "Not added"} capitalize />
            </section>

            <section className="mt-4">
            <button
              type="button"
              onClick={onLogout}
              className="tap flex w-full items-center justify-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 py-3 text-sm font-semibold text-rose-600 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300"
            >
              <LogOut size={14} /> Logout
            </button>
            </section>
          </main>
        </>
      )}
    </>
  );
}

function QuotaTile({ label, entry }: { label: string; entry?: UsageEntry }) {
  if (!entry) {
    return (
      <div className="rounded-2xl bg-slate-50 p-3 text-slate-500 dark:bg-white/[0.05] dark:text-slate-400">
        <p>{label}</p>
        <p className="mt-1 font-semibold">--</p>
      </div>
    );
  }
  const percent = Math.max(0, Math.min(100, Math.round((entry.remaining / Math.max(entry.limit, 1)) * 100)));
  return (
    <div className="rounded-2xl bg-slate-50 p-3 dark:bg-white/[0.05]">
      <p className="text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 font-semibold">
        <span className="text-brand-600 dark:text-brand-400">{entry.remaining}</span> / {entry.limit}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
        <div className="h-full rounded-full bg-brand-500" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white/16 px-3 py-2 text-center backdrop-blur">
      <p className="text-base font-bold leading-none">{value}</p>
      <p className="mt-1 text-[10px] font-medium text-white/80">{label}</p>
    </div>
  );
}

function Action({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <Link
      href={href}
      className="tap flex items-center gap-2 rounded-2xl border border-slate-200/80 bg-white p-3 text-sm font-semibold shadow-sm dark:border-white/10 dark:bg-white/[0.04]"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ChevronRight size={15} className="shrink-0 text-slate-400" />
    </Link>
  );
}

function Detail({
  icon,
  label,
  value,
  capitalize = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  capitalize?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl px-2 py-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</p>
        <p className={`truncate text-sm font-semibold${capitalize ? " capitalize" : ""}`}>{value}</p>
      </div>
    </div>
  );
}

