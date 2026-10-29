"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Loader2, MessageCircle, Search, ShieldAlert, ShieldCheck, ChevronRight } from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { InitialAvatar } from "@/components/initial-avatar";
import { conversationsApi, type ConversationSummary } from "@/lib/conversations";
import { api, resolveMediaUrl, session } from "@/lib/api";
import { fetchSiteContent, type SiteContent } from "@/lib/site";

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
  const [site, setSite] = useState<SiteContent | null>(null);
  const [adminUnread, setAdminUnread] = useState(0);

  useEffect(() => {
    if (!session.access()) {
      router.replace("/login?next=/chats");
      return;
    }
    fetchSiteContent().then(setSite).catch(() => setSite(null));
    let cancelled = false;
    const load = () => {
      conversationsApi
        .list()
        .then((d) => { if (!cancelled) setItems(d); })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Load failed"); });
      // Admin-support unread badge (parity with the website dock).
      api<{ unread: number }>("/api/customer/me/admin-thread/unread")
        .then((r) => { if (!cancelled) setAdminUnread(r.unread || 0); })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [router]);

  const admin = site?.admin_support;
  const adminName = admin?.name || "MediDoor Admin";
  const adminTagline = admin?.tagline || "Verification & support";
  const adminAvatar = resolveMediaUrl(admin?.avatar_url) || null;

  // Client-side filter over pharmacy names.
  const filtered = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) => c.pharmacy_name.toLowerCase().includes(q));
  }, [items, query]);

  return (
    <>
      <MobileHeader title="চ্যাট" subtitle="Support · medi AI · ফার্মেসি" />

      {/* MediDoor contacts — the AI assistant and human admin support both
          live here (parity with the website messenger dock). */}
      <div className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        MediDoor
      </div>
      <div className="mt-2 flex flex-col gap-2 px-4">
        {/* medi AI */}
        <Link
          href="/medi-ai"
          className="tap flex items-center gap-3 rounded-2xl border border-brand-200 bg-gradient-to-r from-brand-50 to-emerald-50 p-3 dark:border-brand-500/30 dark:from-brand-500/10 dark:to-emerald-500/5"
        >
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-500 text-white">
            <Image src="/brand/logo-inside.png" alt="medi AI" width={28} height={28} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">medi AI</p>
            <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
              বাংলায় কথা বলুন — symptom, dosage, advice
            </p>
          </div>
          <MessageCircle size={18} className="shrink-0 text-brand-500" />
        </Link>

        {/* Admin support */}
        <Link
          href="/support"
          className="tap flex items-center gap-3 rounded-2xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-white/10 dark:bg-white/[0.04]"
        >
          <div className="relative shrink-0">
            <InitialAvatar name={adminName} src={adminAvatar} size={44} />
            <span className="absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full bg-brand-500 text-white ring-2 ring-white dark:ring-[#070b12]">
              <ShieldCheck size={10} />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{adminName}</p>
            <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">{adminTagline}</p>
          </div>
          {adminUnread > 0 ? (
            <span className="grid h-5 min-w-[20px] shrink-0 place-items-center rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">
              {adminUnread > 99 ? "99+" : adminUnread}
            </span>
          ) : (
            <ChevronRight size={18} className="shrink-0 text-slate-400" />
          )}
        </Link>
      </div>

      {/* Search bar — client-side filter over pharmacy names. Hidden
          when the user has zero conversations to keep the empty-state
          centred. */}
      {items && items.length > 0 && (
        <div className="px-4 pt-3">
          <label className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-white/[0.04]">
            <Search size={14} className="text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Pharmacy search…"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-slate-400"
            />
          </label>
        </div>
      )}

      <div className="px-4 pt-3 text-[11px] uppercase tracking-wider text-slate-400">
        Pharmacies
      </div>

      <div className="px-2">
        {!items && !error && (
          <div className="flex items-center justify-center gap-2 p-8 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading chats…
          </div>
        )}
        {error && <p className="px-4 py-6 text-sm text-rose-500">{error}</p>}
        {items && items.length === 0 && (
          <div className="m-4 flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-8 text-center text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.02]">
            <MessageCircle size={22} className="opacity-50" />
            <p>এখনও কোনও chat নেই — Home থেকে যেকোনো ওষুধে &quot;Buy&quot; বা &quot;Message&quot; চাপুন।</p>
          </div>
        )}
        {filtered?.map((c) => {
          const blocked = !!c.blocked_at;
          const unreadCount = c.unread_count ?? 0;
          const unread = unreadCount > 0;
          const mineLast = c.last_sender_role === "customer";
          const previewText =
            c.last_message_preview ||
            (c.rider_id ? `🛵 Rider ${c.rider_name ?? "on the way"}` : "Tap to open chat");
          return (
            <Link
              key={c.id}
              href={`/chats/${c.id}`}
              className="tap flex items-center gap-3 rounded-2xl px-3 py-2.5 active:bg-slate-100 dark:active:bg-white/5"
            >
              {/* Avatar with a Messenger-style online presence dot. */}
              <span className="relative shrink-0">
                <InitialAvatar
                  name={c.pharmacy_name}
                  src={resolveMediaUrl(c.pharmacy_avatar) || null}
                  size={54}
                />
                <span className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-[#070b12]" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <p
                    className={`truncate text-[15px] ${
                      unread ? "font-extrabold text-slate-900 dark:text-white" : "font-semibold"
                    }`}
                  >
                    {c.pharmacy_name}
                  </p>
                  <span
                    className={`ml-auto shrink-0 text-[11px] ${
                      unread ? "font-bold text-brand-600 dark:text-brand-400" : "text-slate-400"
                    }`}
                  >
                    {fmtRelTime(c.last_message_at)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <p
                    className={`min-w-0 flex-1 truncate text-[12.5px] ${
                      blocked
                        ? "text-rose-500"
                        : unread
                        ? "font-semibold text-slate-800 dark:text-slate-100"
                        : "text-slate-500 dark:text-slate-400"
                    }`}
                  >
                    {blocked ? (
                      <span className="inline-flex items-center gap-1">
                        <ShieldAlert size={11} /> Blocked: {c.block_reason || "moderation"}
                      </span>
                    ) : (
                      <>
                        {mineLast && <span className="text-slate-400">আপনি: </span>}
                        {previewText}
                      </>
                    )}
                  </p>
                  {unread ? (
                    <span className="grid h-5 min-w-[20px] shrink-0 place-items-center rounded-full bg-brand-500 px-1.5 text-[10px] font-bold text-white shadow-sm shadow-brand-500/30">
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                  ) : (
                    <ChevronRight size={16} className="shrink-0 text-slate-300 dark:text-slate-600" />
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
