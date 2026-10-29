"use client";

/**
 * Pharmacy conversations list. Each row = one customer. Tap → /chats/[id].
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, MessageCircle, Search, ShieldAlert } from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { NotificationsBell } from "@/components/notifications-bell";
import { InitialAvatar } from "@/components/initial-avatar";
import { conversationsApi, type ConversationSummary } from "@/lib/conversations";
import { resolveMediaUrl, session } from "@/lib/api";

function fmtRelTime(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

export default function ChatsListPage() {
  const router = useRouter();
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!session.access()) { router.replace("/login?next=/chats"); return; }
    if (session.role() !== "pharmacy") { router.replace("/login?msg=wrong-role"); return; }
    let cancelled = false;
    const load = () =>
      conversationsApi
        .list()
        .then((d) => { if (!cancelled) setItems(d); })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Load failed"); });
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [router]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) => c.customer_name.toLowerCase().includes(q));
  }, [items, query]);

  return (
    <>
      <MobileHeader title="Chats" subtitle="Customer conversations" right={<NotificationsBell />} />

      {items && items.length > 0 && (
        <div className="px-4 pt-3">
          <label className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-white/[0.04]">
            <Search size={14} className="text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Customer search…"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-slate-400"
            />
          </label>
        </div>
      )}

      <div className="px-2 pt-3">
        {!items && !error && (
          <div className="flex items-center justify-center gap-2 p-8 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading chats…
          </div>
        )}
        {error && <p className="px-4 py-6 text-sm text-rose-500">{error}</p>}
        {items && items.length === 0 && (
          <div className="m-4 flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-8 text-center text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.02]">
            <MessageCircle size={22} className="opacity-50" />
            <p>এখনও কোনো customer chat আসেনি।</p>
          </div>
        )}
        {filtered?.map((c) => {
          const blocked = !!c.blocked_at;
          const unreadCount = c.unread_count ?? 0;
          const unread = unreadCount > 0;
          const preview =
            c.last_message_preview ||
            (c.rider_name ? `Rider: ${c.rider_name}` : "Customer chat");
          return (
            <Link
              key={c.id}
              href={`/chats/${c.id}`}
              className="tap flex items-center gap-3 rounded-2xl px-3 py-2.5 active:bg-slate-100 dark:active:bg-white/5"
            >
              <InitialAvatar
                name={c.customer_name}
                src={resolveMediaUrl(c.customer_avatar)}
                size={44}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className={`truncate text-sm ${unread ? "font-bold" : "font-semibold"}`}>
                    {c.customer_name}
                  </p>
                  {blocked && <ShieldAlert size={12} className="shrink-0 text-rose-500" />}
                  <span
                    className={`ml-auto shrink-0 text-[10px] ${
                      unread ? "text-brand-500 font-semibold" : "text-slate-400"
                    }`}
                  >
                    {fmtRelTime(c.last_message_at)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <p
                    className={`min-w-0 flex-1 truncate text-[11px] ${
                      unread
                        ? "text-slate-700 dark:text-slate-200"
                        : "text-slate-500 dark:text-slate-400"
                    }`}
                  >
                    {preview}
                  </p>
                  {unread && (
                    <span className="grid h-5 min-w-[20px] place-items-center rounded-full bg-brand-500 px-1.5 text-[10px] font-bold text-white">
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
