"use client";

/**
 * Rider notification inbox — 1:1 port of
 * mobile-rider/src/app/notifications/page.tsx.
 *
 * Producers (today):
 *   - rider_offer: pharmacy dispatched a new offer to this rider.
 *   - order_status: pharmacy / system events while the rider is on a job.
 *
 * Tapping a `rider_offer` deep-links back to `/rider` so the rider can
 * accept; `order_status` for an in-progress job links to `/rider/active`.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Bell, Bike, CheckCheck, Loader2, Package, ShieldAlert, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";

type Item = {
  id: string;
  kind: string;
  title: string;
  body_bn: string;
  payload: Record<string, unknown> | null;
  is_read: boolean;
  created_at: string | null;
};
type ListResp = { items: Item[]; unread: number };

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "এইমাত্র";
  if (diff < 3600) return `${Math.floor(diff / 60)} মিনিট আগে`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ঘণ্টা আগে`;
  return d.toLocaleDateString("bn-BD");
}

export function RiderNotificationsScreen() {
  const router = useRouter();
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<ListResp>("/api/notifications/me");
      setItems(r.items || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
      setItems([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const markAll = async () => {
    setBusy(true);
    try {
      await api<{ ok: boolean }>("/api/notifications/me/read-all", { method: "POST" });
      await load();
    } finally { setBusy(false); }
  };

  const onTap = async (n: Item) => {
    if (!n.is_read) {
      try { await api(`/api/notifications/me/${n.id}/read`, { method: "POST" }); } catch {}
    }
    if (n.kind === "rider_offer") { router.push("/rider"); return; }
    if (n.kind === "order_status") { router.push("/rider/active"); return; }
    if (n.kind === "rider_verification" || n.kind === "admin_message") {
      // Verification rejection → send rider back to registration to resubmit.
      const status = (n.payload && typeof n.payload === "object" && "verification_status" in n.payload)
        ? String((n.payload as Record<string, unknown>).verification_status)
        : "";
      if (status === "rejected") {
        router.push("/register/rider");
        return;
      }
      // admin_message and verified → open the two-way thread.
      if (n.kind === "admin_message") { router.push("/rider/messages"); return; }
      router.push("/rider"); return;
    }
    void load();
  };

  const isAdmin = (n: Item) => n.kind === "rider_verification" || n.kind === "admin_message";
  const adminVariant = (n: Item): "verified" | "rejected" | "info" => {
    if (!n.payload || typeof n.payload !== "object") return "info";
    const s = (n.payload as Record<string, unknown>).verification_status;
    if (s === "verified") return "verified";
    if (s === "rejected") return "rejected";
    return "info";
  };

  const unread = (items || []).filter((n) => !n.is_read).length;

  return (
    <main
      className="min-h-full bg-gradient-to-b from-brand-50/60 via-white to-white dark:from-[#0b1018] dark:via-[#070b12] dark:to-[#070b12]"
      style={{ paddingTop: "calc(var(--safe-top) + 8px)" }}
    >
      <header className="px-4 pt-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => router.back()}
            aria-label="Back"
            className="tap -ml-1 flex h-10 w-10 items-center justify-center rounded-full text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-white/5"
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="flex-1 text-base font-semibold">নোটিফিকেশন</h1>
          {unread > 0 && (
            <button
              type="button"
              onClick={markAll}
              disabled={busy}
              className="tap flex items-center gap-1 rounded-full bg-brand-500 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-60"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <CheckCheck size={12} />}
              সব read
            </button>
          )}
        </div>
      </header>

      <section className="px-4 pt-4 pb-24">
        {error && (
          <div className="rounded-2xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-700">
            {error}
          </div>
        )}
        {items === null && (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        )}
        {items !== null && items.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-16 text-center text-xs text-slate-500">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-slate-400 dark:bg-white/5">
              <Bell size={20} />
            </span>
            <p className="font-semibold">কোনও নোটিফিকেশন নেই</p>
            <p>নতুন offer এলে এখানে দেখাবে।</p>
            <Link
              href="/rider"
              className="mt-2 rounded-full bg-brand-500 px-4 py-1.5 text-[11px] font-semibold text-white"
            >
              Go online
            </Link>
          </div>
        )}
        {items !== null && items.length > 0 && (
          <ul className="space-y-2">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onTap(n)}
                  className={[
                    "tap flex w-full items-start gap-2.5 rounded-2xl border p-3 text-left",
                    n.is_read
                      ? "border-slate-200/70 bg-white dark:border-white/10 dark:bg-white/[0.04]"
                      : "border-brand-300 bg-brand-50 dark:border-brand-500/30 dark:bg-brand-500/10",
                  ].join(" ")}
                >
                  <span
                    className={[
                      "grid h-9 w-9 shrink-0 place-items-center rounded-full shadow-sm",
                      isAdmin(n)
                        ? adminVariant(n) === "rejected"
                          ? "bg-rose-500 text-white"
                          : adminVariant(n) === "verified"
                          ? "bg-emerald-500 text-white"
                          : "bg-brand-500 text-white"
                        : "bg-white text-brand-600 dark:bg-white/10 dark:text-brand-300",
                    ].join(" ")}
                  >
                    {n.kind === "rider_offer" ? <Package size={14} />
                      : n.kind === "rider_verification"
                        ? (adminVariant(n) === "rejected" ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />)
                        : n.kind === "admin_message" ? <ShieldCheck size={14} />
                        : <Bike size={14} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100">
                        {n.title}
                      </p>
                      {!n.is_read && (
                        <span className="shrink-0 rounded-full bg-brand-500 px-1.5 py-0.5 text-[9px] font-bold text-white">
                          NEW
                        </span>
                      )}
                    </div>
                    {isAdmin(n) && (
                      <p className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-brand-600 dark:text-brand-300">
                        MediDoor Admin
                      </p>
                    )}
                    <p className="mt-0.5 whitespace-pre-line text-[11.5px] leading-snug text-slate-600 dark:text-slate-300">
                      {n.body_bn}
                    </p>
                    <p className="mt-1 text-[10px] text-slate-400">{fmtTime(n.created_at)}</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
