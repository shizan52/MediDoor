"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronRight,
  Home as HomeIcon,
  Loader2,
  MessageCircle,
  Receipt,
  ScanLine,
  Search,
  ShieldCheck,
  User as UserIcon,
} from "lucide-react";
import { api, session } from "@/lib/api";
import { conversationsApi, type ConversationSummary } from "@/lib/conversations";
import { fetchSiteContent, type SiteContent } from "@/lib/site";
import { ThemeToggle } from "@/components/theme-toggle";
import { MobileTabBar } from "@/components/mobile-nav";
import { MessengerDock } from "@/components/messenger-dock";

function fmtRelTime(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

/** Open the messenger dock (mounted on THIS page) in place — no navigation, so
 *  the chat opens right here instead of flashing the home page first. No detail
 *  opens the contact picker; `open: "ai" | "admin"` opens that contact directly;
 *  a pharmacy detail opens that thread. */
function openDock(detail?: { pharmacy_id?: string; conversation_id?: string; open?: "ai" | "admin" }) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("medidoor-open-chat", detail ? { detail } : undefined));
}

/** App-style chat list for the web-mobile experience (parity with the
 *  customer app's /chats). The actual conversation opens in the dock. */
export function CustomerChatsPage() {
  const router = useRouter();
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [site, setSite] = useState<SiteContent | null>(null);
  const [adminUnread, setAdminUnread] = useState(0);

  useEffect(() => {
    if (!session.access()) { router.replace("/login?role=customer&next=/customer/chats"); return; }
    // Only customers use the customer chat list; a logged-in pharmacy/rider
    // gets a clean customer-login notice instead of a wrong-role view.
    if (session.role() !== "customer") { router.replace("/login?role=customer&msg=customer-only"); return; }
    fetchSiteContent().then(setSite).catch(() => setSite(null));
    let cancelled = false;
    const load = () => {
      conversationsApi.list()
        .then((d) => { if (!cancelled) setItems(d); })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Load failed"); });
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

  const filtered = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    return q ? items.filter((c) => c.pharmacy_name.toLowerCase().includes(q)) : items;
  }, [items, query]);

  const isUnread = (c: ConversationSummary) =>
    !!(c.last_message_at && (!c.customer_last_read_at || new Date(c.last_message_at).getTime() > new Date(c.customer_last_read_at).getTime()));
  const chatUnread = (items ?? []).filter(isUnread).length + adminUnread;

  return (
    <main className="relative min-h-screen bg-gradient-to-br from-brand-50 via-white to-brand-100 dark:from-[#070b12] dark:via-[#0b1018] dark:to-[#091622]">
      <header className="sticky top-0 z-30 border-b border-black/5 bg-white/80 backdrop-blur dark:border-white/10 dark:bg-[#0b1018]/80">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-3">
          <button onClick={() => router.push("/")} aria-label="Back" className="grid h-9 w-9 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10">
            <ArrowLeft size={18} />
          </button>
          <h1 className="flex-1 text-base font-bold">Chats</h1>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 pb-28 pt-4 sm:pb-8">
        {/* MediDoor contacts */}
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">MediDoor</p>
        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => openDock({ open: "ai" })} className="flex items-center gap-3 rounded-2xl border border-brand-200 bg-gradient-to-r from-brand-50 to-emerald-50 p-3 text-left dark:border-brand-500/30 dark:from-brand-500/10 dark:to-emerald-500/5">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-500 text-white">
              <Image src="/brand/logo-inside.png" alt="medi AI" width={28} height={28} className="h-6 w-auto object-contain" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">medi AI</span>
              <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">বাংলায় কথা বলুন — symptom, dosage, advice</span>
            </span>
            <MessageCircle size={18} className="shrink-0 text-brand-500" />
          </button>

          <button type="button" onClick={() => openDock({ open: "admin" })} className="flex items-center gap-3 rounded-2xl border border-black/5 bg-white/85 p-3 text-left shadow-sm dark:border-white/10 dark:bg-white/5">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
              <ShieldCheck size={20} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{adminName}</span>
              <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">{adminTagline}</span>
            </span>
            {adminUnread > 0 ? (
              <span className="grid h-5 min-w-[20px] shrink-0 place-items-center rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">{adminUnread > 99 ? "99+" : adminUnread}</span>
            ) : (
              <ChevronRight size={18} className="shrink-0 text-slate-400" />
            )}
          </button>
        </div>

        {/* Pharmacy conversations */}
        {items && items.length > 0 && (
          <label className="mt-4 flex items-center gap-2 rounded-full border border-black/10 bg-white/85 px-3 py-2 dark:border-white/10 dark:bg-white/5">
            <Search size={14} className="text-slate-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Pharmacy search…" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-slate-400" />
          </label>
        )}

        <p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Pharmacies</p>
        {!items && !error && (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        )}
        {error && <p className="text-sm text-rose-500">{error}</p>}
        {items && items.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-black/10 bg-white/60 p-8 text-center text-xs text-slate-500 dark:border-white/10 dark:bg-white/5">
            <MessageCircle size={22} className="opacity-50" />
            <p>এখনও কোনও chat নেই — Home থেকে যেকোনো ওষুধে &quot;Message&quot; চাপুন।</p>
          </div>
        )}
        <div className="flex flex-col">
          {filtered?.map((c) => {
            const unread = isUnread(c);
            return (
              <button key={c.id} type="button" onClick={() => openDock({ pharmacy_id: c.pharmacy_id, conversation_id: c.id })} className="flex items-center gap-3 rounded-2xl px-2 py-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5">
                <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full bg-brand-100 text-sm font-bold text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
                  {c.pharmacy_avatar ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={c.pharmacy_avatar} alt={c.pharmacy_name} className="h-full w-full object-cover" />
                  ) : (
                    c.pharmacy_name?.[0]?.toUpperCase() ?? "P"
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={`truncate text-sm ${unread ? "font-bold" : "font-semibold"}`}>{c.pharmacy_name}</span>
                    <span className={`ml-auto shrink-0 text-[10px] ${unread ? "font-semibold text-brand-500" : "text-slate-400"}`}>{fmtRelTime(c.last_message_at)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <span className={`min-w-0 flex-1 truncate text-[11px] ${unread ? "text-slate-700 dark:text-slate-200" : "text-slate-500 dark:text-slate-400"}`}>{c.blocked_at ? "Blocked" : "Tap to open chat"}</span>
                    {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-brand-500" />}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <MobileTabBar
        tabs={[
          { key: "home", label: "হোম", icon: <HomeIcon size={20} />, onClick: () => router.push("/") },
          { key: "chats", label: "চ্যাট", icon: <MessageCircle size={20} />, badge: chatUnread, active: true, onClick: () => {} },
          { key: "rx", label: "Rx স্ক্যান", icon: <ScanLine size={20} />, onClick: () => { try { window.sessionStorage.setItem("medidoor_home_intent", "rx"); } catch { /* ignore */ } router.push("/"); } },
          { key: "orders", label: "অর্ডার", icon: <Receipt size={20} />, onClick: () => router.push("/customer/orders") },
          { key: "profile", label: "প্রোফাইল", icon: <UserIcon size={20} />, onClick: () => router.push("/customer/profile") },
        ]}
      />

      {/* Mounted here so tapping a contact opens the conversation IN PLACE
          (no navigation to the home page). navInset keeps the bottom tab bar
          visible with the composer above it. */}
      <MessengerDock navInset />
    </main>
  );
}
