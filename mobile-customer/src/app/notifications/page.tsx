"use client";

/**
 * Per-account notification inbox for the customer app.
 *
 * Pulls from /api/notifications/me. Producers today:
 *   - order_status: pharmacy confirms / packages / readies / delivers; rider
 *     accepts / picks-up / delivers.
 *
 * Tapping an item with payload.conversation_id opens that chat; payload.order_id
 * deep-links into /orders. Mark-all-read is a single fetch to
 * /api/notifications/me/read-all.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, Loader2, ShoppingBag } from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
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

export default function NotificationsPage() {
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
    const orderId = n.payload && typeof n.payload === "object"
      ? (n.payload as Record<string, unknown>).order_id
      : undefined;
    const conversationId = n.payload && typeof n.payload === "object"
      ? (n.payload as Record<string, unknown>).conversation_id
      : undefined;
    if (typeof conversationId === "string" && conversationId) {
      router.push(`/chats/${conversationId}`);
      return;
    }
    if (typeof orderId === "string" && orderId) {
      router.push(`/orders?focus=${orderId}`);
      return;
    }
    void load();
  };

  const unread = (items || []).filter((n) => !n.is_read).length;

  return (
    <>
      <MobileHeader
        title="নোটিফিকেশন"
        back
        right={
          unread > 0 ? (
            <button
              type="button"
              onClick={markAll}
              disabled={busy}
              className="tap flex items-center gap-1 rounded-full bg-brand-500 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-60"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <CheckCheck size={12} />}
              সব read
            </button>
          ) : null
        }
      />

      <section className="px-4 pt-3 pb-24">
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
          <div className="flex flex-col items-center gap-2 py-16 text-center text-xs text-slate-500 dark:text-slate-400">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-slate-400 dark:bg-white/5">
              <Bell size={20} />
            </span>
            <p className="font-semibold">কোনও নোটিফিকেশন নেই</p>
            <p>Order status update এলে এখানে দেখাবে।</p>
            <Link
              href="/"
              className="mt-2 rounded-full bg-brand-500 px-4 py-1.5 text-[11px] font-semibold text-white"
            >
              Browse pharmacies
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
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-brand-600 shadow-sm dark:bg-white/10 dark:text-brand-300">
                    {n.kind === "order_status" ? <ShoppingBag size={14} /> : <Bell size={14} />}
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
                    <p className="mt-0.5 text-[11.5px] leading-snug text-slate-600 dark:text-slate-300">
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
    </>
  );
}
