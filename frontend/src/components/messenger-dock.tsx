"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import {
  MessageCircle,
  X,
  Send,
  Bot,
  Minus,
  Paperclip,
  Store,
  User as UserIcon,
  Star,
  Check,
  XCircle,
  Package,
  Bike,
  CheckCircle2,
  CheckCheck,
  MapPin,
  Edit3,
  Lock,
  Plus,
  ShieldAlert,
  Loader2,
} from "lucide-react";
import { api, API_URL, session, uploadImage, resolveMediaUrl } from "@/lib/api";
import { geoApi, locationErrorMessage } from "@/lib/geo";
import { userLocation } from "@/lib/storefront";
import { fetchSiteContent, type SiteContent } from "@/lib/site";
import {
  conversationsApi,
  ORDER_PRESETS,
  formatBDT,
  type AiProxyQuestion,
  type ConversationMessage,
  type ConversationSummary,
  type ConversationTrack,
  type MessageVisibility,
  type OrderPayload,
} from "@/lib/conversations";
import { OrderComposer } from "@/components/order-composer";
import { Receipt } from "lucide-react";

const MediMap = dynamic(() => import("@/components/medi-map").then((m) => m.MediMap), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-xs opacity-60">Loading map…</div>,
});

/**
 * Facebook-style messenger dock.
 *
 * Contacts:
 *   - medi AI (always available)
 *   - For logged-in users: their Conversation list (customers see pharmacies,
 *     pharmacies see customers).
 *
 * Open a chat programmatically from anywhere with:
 *   window.dispatchEvent(new CustomEvent("medidoor-open-chat",
 *     { detail: { pharmacy_id: "..." } }))   // customer-side: start-or-resume
 *   { detail: { conversation_id: "..." } }    // any role: open existing
 */

type AiMsg = { role: "user" | "assistant"; content: string };
type MediAiProxyTarget = "pharmacy" | "rider" | "all";

type RiderAdminMsg = {
  id: string;
  direction:
    | "admin_to_rider" | "rider_to_admin"
    | "admin_to_customer" | "customer_to_admin"
    | "admin_to_pharmacy" | "pharmacy_to_admin";
  body: string;
  attachment_url?: string | null;
  attachment_mime?: string | null;
  is_read: boolean;
  created_at: string | null;
};

type Contact =
  | {
      id: string;
      kind: "bot";
      name: string;
      tagline?: string;
      avatar_url?: string;
    }
  | {
      id: string;
      kind: "conversation";
      role: "customer" | "pharmacy" | "rider";
      conversation: ConversationSummary;
      name: string;
      tagline?: string;
      avatar_url?: string;
      initialDraft?: string;
    }
  | {
      id: string;
      kind: "rider-admin";
      role: "customer" | "pharmacy" | "rider";
      name: string;
      tagline?: string;
      avatar_url?: string;
      unread: number;
    };

const STORE_KEY = "medidoor_medi_ai_chat";
const SEEN_PREFIX = "medidoor_conv_seen_";

function adminThreadPath(role: "customer" | "pharmacy" | "rider", suffix = "") {
  const base = role === "customer"
    ? "/api/customer/me/admin-thread"
    : role === "pharmacy"
      ? "/api/pharmacy/me/admin-thread"
      : "/api/rider/me/admin-thread";
  return `${base}${suffix}`;
}

function loadStored(): AiMsg[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as AiMsg[]).slice(-12) : [];
  } catch {
    return [];
  }
}

function getSeenAt(conversationId: string): number {
  if (typeof window === "undefined") return 0;
  const v = localStorage.getItem(SEEN_PREFIX + conversationId);
  return v ? Number(v) : 0;
}

function setSeenAt(conversationId: string, ts: number) {
  if (typeof window === "undefined") return;
  localStorage.setItem(SEEN_PREFIX + conversationId, String(ts));
}

function isConversationAccessError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("api 403") &&
    (
      text.includes("not a participant") ||
      text.includes("not an active rider") ||
      text.includes("rider chat archive expired") ||
      text.includes("rider_archive_read_only")
    )
  );
}

// Tiny WebAudio "blip" so we don't need to ship an mp3 asset.
function playNotifyBlip() {
  if (typeof window === "undefined") return;
  try {
    const W = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctx = W.AudioContext || W.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.34);
    o.onended = () => ctx.close().catch(() => {});
  } catch {
    /* sound is best-effort */
  }
}

export function MessengerDock({ navInset = false }: { navInset?: boolean } = {}) {
  const [site, setSite] = useState<SiteContent | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [openChats, setOpenChats] = useState<Contact[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [accountRole, setAccountRole] = useState<"customer" | "pharmacy" | "rider" | null>(null);
  const [riderAdminUnread, setRiderAdminUnread] = useState(0);
  const [aiQuestionCount, setAiQuestionCount] = useState(0);
  // Bumped whenever a conversation is opened/marked seen so the unread
  // badge re-renders immediately (without waiting for the 15s poll).
  const [seenTick, setSeenTick] = useState(0);
  const bumpSeen = useCallback(() => setSeenTick((t) => t + 1), []);
  // Floating toast popups for incoming messages while the chat is closed.
  type Toast = { id: string; convId: string; name: string; body: string; avatar?: string };
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  // Track previous last_message_at per conversation to detect new messages
  // arriving via the poll → play a notification blip when a new message
  // lands AND the user hasn't opened that chat yet.
  const lastSeenByPollRef = useRef<Record<string, number>>({});
  const firstPollRef = useRef(true);
  const openChatIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    openChatIdsRef.current = new Set(
      openChats
        .filter((c): c is Extract<Contact, { kind: "conversation" }> => c.kind === "conversation")
        .map((c) => c.conversation.id),
    );
  }, [openChats]);

  useEffect(() => {
    fetchSiteContent().then(setSite).catch(() => setSite(null));
  }, []);

  useEffect(() => {
    setAccountRole(session.role());
  }, []);

  // Position the full-screen mobile chat panel's bottom edge via two CSS vars:
  //  - `--medi-kb`  : on-screen keyboard height (the keyboard shrinks the visual
  //    viewport but not the layout viewport, so we track it and lift the
  //    composer above it instead of hiding behind it).
  //  - `--medi-nav` : height of the mobile bottom tab bar, reserved ONLY on
  //    pages that render it (navInset) AND only while the keyboard is closed —
  //    when the keyboard is open it covers the nav, so the composer should hug
  //    the keyboard directly. Hosts without a tab bar keep it at 0.
  useEffect(() => {
    const root = document.documentElement;
    const navH = navInset ? "calc(3.5rem + env(safe-area-inset-bottom))" : "0px";
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const update = () => {
      const inset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
      root.style.setProperty("--medi-kb", `${inset}px`);
      root.style.setProperty("--medi-nav", inset > 0 ? "0px" : navH);
    };
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      root.style.removeProperty("--medi-kb");
      root.style.removeProperty("--medi-nav");
    };
  }, [navInset]);

  const refreshConversations = useCallback(async () => {
    if (!session.access()) {
      setConversations([]);
      return;
    }
    try {
      const list = await conversationsApi.list();
      // Detect newly arrived messages → play blip + show toast popup if
      // the chat isn't open (or the tab is hidden). Skip the very first
      // poll so we don't blip for everything that already existed before
      // page load.
      if (!firstPollRef.current) {
        const role = session.role();
        let blipped = false;
        for (const c of list) {
          const ts = c.last_message_at ? new Date(c.last_message_at).getTime() : 0;
          const prev = lastSeenByPollRef.current[c.id] ?? 0;
          if (ts > prev) {
            const isOpen = openChatIdsRef.current.has(c.id);
            // Never notify for a chat that's already open in the dock — the
            // new message shows up inside that panel via its own poll, and a
            // toast here would just pile on top of the panel's action buttons
            // (Confirm / Packing …) and block clicks (Problem 9).
            if (!isOpen) {
              if (!blipped) {
                playNotifyBlip();
                blipped = true;
              }
              // Build a toast — show counterpart name + last_message_preview
              const name =
                role === "customer"
                  ? c.pharmacy_name
                  : role === "rider"
                    ? `${c.customer_name} · ${c.pharmacy_name}`
                    : c.customer_name;
              const avatar =
                role === "customer" ? c.pharmacy_avatar : c.customer_avatar;
              const body = "নতুন message এসেছে — পড়তে ক্লিক করুন।";
              const toastId = `${c.id}-${ts}`;
              setToasts((prev) => {
                // Replace any existing toast for this conversation
                const filtered = prev.filter((t) => t.convId !== c.id);
                return [...filtered, { id: toastId, convId: c.id, name, body, avatar: avatar || undefined }];
              });
              // Auto-dismiss after 5s
              setTimeout(() => {
                setToasts((prev) => prev.filter((t) => t.id !== toastId));
              }, 5000);
            }
          }
        }
      }
      lastSeenByPollRef.current = Object.fromEntries(
        list.map((c) => [c.id, c.last_message_at ? new Date(c.last_message_at).getTime() : 0]),
      );
      firstPollRef.current = false;
      setConversations(list);
    } catch {
      setConversations([]);
    }
  }, []);

  useEffect(() => {
    void refreshConversations();
    const id = setInterval(() => void refreshConversations(), 15000);
    return () => clearInterval(id);
  }, [refreshConversations]);

  const refreshRiderAdminUnread = useCallback(async () => {
    const role = session.role();
    if (!session.access() || (role !== "rider" && role !== "customer" && role !== "pharmacy")) {
      setRiderAdminUnread(0);
      return;
    }
    try {
      const path = adminThreadPath(role, "/unread");
      const res = await api<{ unread: number }>(path);
      setRiderAdminUnread(Number(res.unread || 0));
    } catch {
      setRiderAdminUnread(0);
    }
  }, []);

  useEffect(() => {
    void refreshRiderAdminUnread();
    const id = setInterval(() => void refreshRiderAdminUnread(), 8000);
    return () => clearInterval(id);
  }, [refreshRiderAdminUnread]);

  const refreshAiQuestionCount = useCallback(async () => {
    if (!session.access() || session.role() !== "customer") {
      setAiQuestionCount(0);
      return;
    }
    try {
      const rows = await conversationsApi.aiProxyQuestions();
      setAiQuestionCount(rows.length);
    } catch {
      setAiQuestionCount(0);
    }
  }, []);

  useEffect(() => {
    void refreshAiQuestionCount();
    const id = setInterval(() => void refreshAiQuestionCount(), 10000);
    return () => clearInterval(id);
  }, [refreshAiQuestionCount]);

  const bot: Contact = {
    id: "medi-ai",
    kind: "bot",
    name: site?.bot?.name || "medi AI",
    tagline: aiQuestionCount > 0
      ? `${aiQuestionCount} pharmacy question${aiQuestionCount > 1 ? "s" : ""} waiting`
      : site?.bot?.tagline || "MediDoor assistant · short answers",
    avatar_url: site?.bot?.avatar_url,
  };

  const convoContacts: Contact[] = useMemo(() => {
    if (!accountRole) return [];
    return conversations.map((c) => {
      let name: string;
      let tagline: string;
      let avatar: string | undefined;
      if (accountRole === "customer") {
        name = c.pharmacy_name;
        tagline = c.rider_id ? `Pharmacy · 🛵 ${c.rider_name || "Rider joined"}` : "Pharmacy";
        avatar = c.pharmacy_avatar || undefined;
      } else if (accountRole === "pharmacy") {
        name = c.customer_name;
        tagline = c.rider_id ? `Customer · 🛵 ${c.rider_name || "Rider joined"}` : "Customer";
        avatar = c.customer_avatar || undefined;
      } else {
        // rider
        name = c.customer_name;
        tagline = `🛵 Delivery for ${c.pharmacy_name}`;
        avatar = c.customer_avatar || c.pharmacy_avatar || undefined;
      }
      return {
        id: `conv-${c.id}`,
        kind: "conversation" as const,
        role: accountRole,
        conversation: c,
        name,
        tagline,
        avatar_url: avatar,
      };
    });
  }, [conversations, accountRole]);

  const riderAdminContact: Contact | null = accountRole === "rider" || accountRole === "customer" || accountRole === "pharmacy"
    ? {
        id: `${accountRole}-admin`,
        kind: "rider-admin",
        role: accountRole,
        name: site?.admin_support?.name || "MediDoor Admin",
        tagline: riderAdminUnread > 0
          ? `${riderAdminUnread} unread message${riderAdminUnread > 1 ? "s" : ""}`
          : site?.admin_support?.tagline || (accountRole === "rider" ? "Verification & support" : accountRole === "pharmacy" ? "Pharmacy support" : "Customer support"),
        avatar_url: site?.admin_support?.avatar_url || undefined,
        unread: riderAdminUnread,
      }
    : null;

  const contacts: Contact[] = [bot, ...(riderAdminContact ? [riderAdminContact] : []), ...convoContacts];

  // Live refs so the (stable) open-chat listener can open the medi AI / Admin
  // contacts directly without re-subscribing every render.
  const botRef = useRef(bot);
  botRef.current = bot;
  const riderAdminRef = useRef(riderAdminContact);
  riderAdminRef.current = riderAdminContact;

  const openChat = useCallback((c: Contact) => {
    setOpenChats((prev) => (prev.find((p) => p.id === c.id) ? prev : [...prev, c]));
    setListOpen(false);
    if (c.kind === "conversation") {
      // Optimistically clear the unread badge for this conversation right
      // away (the actual /seen POST happens inside ChatPanel.refresh()).
      setSeenAt(c.conversation.id, Date.now());
      bumpSeen();
    } else if (c.kind === "rider-admin") {
      setRiderAdminUnread(0);
    }
  }, [bumpSeen]);

  function closeChat(id: string) {
    setOpenChats((prev) => prev.filter((p) => p.id !== id));
  }

  // Global open-chat event handler
  useEffect(() => {
    function handler(ev: Event) {
      const detail = (ev as CustomEvent<{
        pharmacy_id?: string;
        conversation_id?: string;
        prefill?: string;
        open?: "ai" | "admin";
      }>).detail;
      // No detail = caller (e.g. header avatar) just wants to open the
      // messenger list so the user can pick a contact.
      if (!detail) {
        setListOpen(true);
        return;
      }
      // medi AI / Admin are special contacts — open them directly so a tap from
      // the mobile chat list opens the thread in one step (no picker in between).
      if (detail.open === "ai") {
        openChat(botRef.current);
        return;
      }
      if (detail.open === "admin") {
        if (riderAdminRef.current) openChat(riderAdminRef.current);
        return;
      }

      (async () => {
        try {
          if (detail.conversation_id) {
            const conv = conversations.find((c) => c.id === detail.conversation_id);
            if (conv && accountRole) {
              const isCustomer = accountRole === "customer";
              const isRider = accountRole === "rider";
              const name = isCustomer
                ? conv.pharmacy_name
                : isRider
                  ? conv.customer_name
                  : conv.customer_name;
              const tagline = isCustomer
                ? "Pharmacy"
                : isRider
                  ? `🛵 Delivery for ${conv.pharmacy_name}`
                  : "Customer";
              openChat({
                id: `conv-${conv.id}`,
                kind: "conversation",
                role: accountRole,
                conversation: conv,
                name,
                tagline,
                avatar_url: isCustomer
                  ? conv.pharmacy_avatar || undefined
                  : conv.customer_avatar || conv.pharmacy_avatar || undefined,
                initialDraft: detail.prefill,
              });
              return;
            }
            // The conversation isn't in the freshly-loaded list yet (e.g. this
            // came from a cross-page handoff before the dock polled). If we also
            // got a pharmacy_id, fall through and open by pharmacy — otherwise
            // the tap would silently do nothing. Only bail when we have nothing
            // else to go on.
            if (!detail.pharmacy_id) return;
          }
          if (detail.pharmacy_id && session.access()) {
            // Send the customer's live location — the backend enforces the
            // 5 km connect radius on NEW conversations.
            const conv = await conversationsApi.start(
              detail.pharmacy_id, userLocation.load(),
            );
            setConversations((prev) => {
              const exists = prev.find((p) => p.id === conv.id);
              return exists ? prev : [conv, ...prev];
            });
            openChat({
              id: `conv-${conv.id}`,
              kind: "conversation",
              role: "customer",
              conversation: conv,
              name: conv.pharmacy_name,
              tagline: "Pharmacy",
              avatar_url: conv.pharmacy_avatar || undefined,
              initialDraft: detail.prefill,
            });
          }
        } catch (e) {
          // Surface the 5 km / location errors instead of failing silently.
          const msg = e instanceof Error ? e.message : "";
          if (msg) window.alert(msg);
        }
      })();
    }
    window.addEventListener("medidoor-open-chat", handler as EventListener);
    return () => window.removeEventListener("medidoor-open-chat", handler as EventListener);
  }, [conversations, accountRole, openChat]);

  const unreadCount = useMemo(
    () =>
      riderAdminUnread + aiQuestionCount + conversations.reduce((acc, c) => {
        if (!c.last_message_at) return acc;
        const last = new Date(c.last_message_at).getTime();
        return acc + (last > getSeenAt(c.id) ? 1 : 0);
      }, 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [aiQuestionCount, conversations, riderAdminUnread, seenTick],
  );

  return (
    <>
      <motion.button
        onClick={() => {
          // Guest → prompt login instead of opening an empty conversation list.
          if (!session.access()) {
            window.dispatchEvent(
              new CustomEvent("medidoor-require-login", {
                detail: {
                  feature: "Messages",
                  message:
                    "Pharmacy-র সাথে chat করতে শুধু একবার login করতে হবে। তারপর আপনার সব conversation এখানেই থাকবে।",
                  role: "customer",
                },
              }),
            );
            return;
          }
          setListOpen((v) => !v);
        }}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.94 }}
        className="fixed bottom-5 right-5 z-50 grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-2xl shadow-brand-500/40 ring-2 ring-white/40 dark:ring-white/10 max-sm:hidden"
        aria-label="Open messages"
      >
        {listOpen ? <X size={22} /> : <MessageCircle size={24} />}
        {unreadCount > 0 && !listOpen && (
          <span className="absolute -top-1 -right-1 grid h-5 min-w-[20px] place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white shadow ring-2 ring-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </motion.button>

      {/* Floating toast popups for incoming messages while the chat is closed.
          Anchored bottom-LEFT so they never overlap the bottom-right chat
          panels + their action buttons or the messenger launcher (Problem 9). */}
      <div className="pointer-events-none fixed bottom-24 left-5 z-[60] flex w-[min(320px,calc(100vw-2.5rem))] flex-col items-start gap-2">
        <AnimatePresence>
          {toasts.map((t) => {
            const conv = conversations.find((c) => c.id === t.convId);
            return (
              <motion.button
                key={t.id}
                type="button"
                initial={{ opacity: 0, x: -32, scale: 0.9 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: -32, scale: 0.9 }}
                transition={{ duration: 0.22 }}
                onClick={(e) => {
                  e.stopPropagation();
                  dismissToast(t.id);
                  if (!conv || !accountRole) return;
                  const isCustomer = accountRole === "customer";
                  const isRider = accountRole === "rider";
                  const name = isCustomer ? conv.pharmacy_name : isRider ? conv.customer_name : conv.customer_name;
                  const tagline = isCustomer ? "Pharmacy" : isRider ? `🛵 Delivery for ${conv.pharmacy_name}` : "Customer";
                  const avatar = isCustomer ? conv.pharmacy_avatar : isRider ? conv.customer_avatar : conv.customer_avatar;
                  openChat({
                    id: `conv-${conv.id}`,
                    kind: "conversation",
                    name,
                    tagline,
                    avatar_url: avatar || undefined,
                    role: accountRole,
                    conversation: conv,
                  });
                }}
                className="pointer-events-auto group flex w-full items-start gap-3 rounded-2xl border border-brand-400/40 bg-white/95 dark:bg-[#0b1018]/95 px-3 py-2.5 text-left shadow-2xl shadow-brand-500/20 backdrop-blur-xl ring-1 ring-brand-500/10 hover:border-brand-500"
              >
                <div className="grid h-9 w-9 flex-shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white">
                  {t.avatar ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={t.avatar} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <MessageCircle size={16} />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[12px] font-bold text-slate-900 dark:text-slate-100">{t.name}</p>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); dismissToast(t.id); }}
                      className="rounded-full p-0.5 text-slate-400 hover:bg-black/5 hover:text-slate-700 dark:hover:bg-white/10"
                      aria-label="Dismiss notification"
                    >
                      <X size={12} />
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-slate-600 dark:text-slate-300">{t.body}</p>
                </div>
              </motion.button>
            );
          })}
        </AnimatePresence>
      </div>

      <div className="pointer-events-none fixed bottom-0 right-24 z-40 flex items-end gap-3 pr-2 pb-2 max-sm:inset-0 max-sm:right-0 max-sm:z-50 max-sm:flex-col max-sm:p-0">
        <AnimatePresence>
          {openChats.map((c) => (
            <motion.div
              key={c.id}
              initial={{ opacity: 0, y: 24, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.95 }}
              transition={{ duration: 0.18 }}
              className="pointer-events-auto"
            >
              <ChatPanel
                contact={c}
                liveConv={
                  c.kind === "conversation"
                    ? conversations.find((x) => x.id === c.conversation.id) ?? c.conversation
                    : null
                }
                onClose={() => closeChat(c.id)}
                onConversationActivity={refreshConversations}
                onSeen={bumpSeen}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {listOpen && (
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: 0.2 }}
            className="fixed bottom-24 right-5 z-50 flex w-[min(360px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 bg-white/95 dark:bg-[#0b1018]/95 text-slate-900 dark:text-slate-100 backdrop-blur-xl shadow-2xl max-sm:inset-0 max-sm:bottom-0 max-sm:right-0 max-sm:w-full max-sm:rounded-none max-sm:border-0 max-sm:z-[60]"
          >
            <div
              className="flex items-center justify-between border-b border-black/5 dark:border-white/5 bg-gradient-to-r from-brand-500/15 to-emerald-500/10 px-4 py-3 max-sm:pt-[calc(env(safe-area-inset-top)+12px)]"
            >
              <div>
                <p className="text-sm font-bold">চ্যাট</p>
                <p className="text-[11px] text-slate-600 dark:text-slate-300">Support · medi AI · ফার্মেসি</p>
              </div>
              <button
                onClick={() => setListOpen(false)}
                className="rounded-full glass p-1.5 hover:scale-105"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
            <ul className="max-h-[60vh] overflow-y-auto py-1 max-sm:max-h-none max-sm:flex-1">
              {contacts.map((c) => {
                const unread = c.kind === "rider-admin"
                  ? c.unread > 0
                  : c.kind === "conversation" &&
                    c.conversation.last_message_at &&
                    new Date(c.conversation.last_message_at).getTime() > getSeenAt(c.conversation.id);
                return (
                  <li key={c.id}>
                    <button
                      onClick={() => openChat(c)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-brand-500/5"
                    >
                      <Avatar contact={c} size={42} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                          {c.name}
                          {unread && (
                            <span className="ml-2 inline-block h-2 w-2 rounded-full bg-red-500 align-middle" />
                          )}
                        </p>
                        <p className="truncate text-[11px] text-slate-600 dark:text-slate-300">{c.tagline}</p>
                      </div>
                      {c.kind === "bot" && (
                        <span className="rounded-full bg-brand-500/15 px-2 py-0.5 text-[10px] font-medium text-brand-700 dark:text-brand-300">
                          AI
                        </span>
                      )}
                      {c.kind === "rider-admin" && c.unread > 0 && (
                        <span className="grid h-5 min-w-[20px] place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                          {c.unread > 9 ? "9+" : c.unread}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
              {contacts.length === 1 && (
                <li className="px-4 py-3 text-[11px] text-slate-500 dark:text-slate-400">
                  {accountRole
                    ? "এখনও কোনও conversation নেই — pharmacy storefront থেকে chat শুরু করুন।"
                    : "Login করলে pharmacy-র সাথে direct chat করতে পারবেন।"}
                </li>
              )}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/* ===================================================================== */

function Avatar({ contact, size = 36 }: { contact: Contact; size?: number }) {
  const url = contact.avatar_url;
  if (url) {
    return (
      <div
        className="relative shrink-0 overflow-hidden rounded-full ring-2 ring-white/60 dark:ring-white/10"
        style={{ width: size, height: size }}
      >
        <Image src={url} alt={contact.name} fill sizes={`${size}px`} className="object-cover" unoptimized />
      </div>
    );
  }
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white"
      style={{ width: size, height: size }}
    >
      {contact.kind === "bot" ? (
        <Bot size={size * 0.55} />
      ) : contact.kind === "rider-admin" ? (
        <ShieldAlert size={size * 0.55} />
      ) : contact.role === "customer" ? (
        <Store size={size * 0.55} />
      ) : (
        <UserIcon size={size * 0.55} />
      )}
    </div>
  );
}

function ChatPanel({
  contact,
  liveConv,
  onClose,
  onConversationActivity,
  onSeen,
}: {
  contact: Contact;
  liveConv: ConversationSummary | null;
  onClose: () => void;
  onConversationActivity: () => void;
  onSeen: () => void;
}) {
  if (contact.kind === "bot") {
    return <BotChatPanel contact={contact} onClose={onClose} />;
  }
  if (contact.kind === "rider-admin") {
    return <RiderAdminChatPanel contact={contact} onClose={onClose} onSeen={onSeen} />;
  }
  return (
    <ConversationChatPanel
      contact={contact}
      liveConv={liveConv ?? contact.conversation}
      onClose={onClose}
      onActivity={onConversationActivity}
      onSeen={onSeen}
    />
  );
}

/* ---------------- Bot chat ---------------- */

function BotChatPanel({
  contact,
  onClose,
}: {
  contact: Extract<Contact, { kind: "bot" }>;
  onClose: () => void;
}) {
  const [minimized, setMinimized] = useState(false);
  const [messages, setMessages] = useState<AiMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiQuestions, setAiQuestions] = useState<AiProxyQuestion[]>([]);
  const [customerConversations, setCustomerConversations] = useState<ConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [proxyTarget, setProxyTarget] = useState<MediAiProxyTarget>("pharmacy");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages(loadStored());
  }, []);

  const refreshAiQuestions = useCallback(async () => {
    if (!session.access() || session.role() !== "customer") {
      setAiQuestions([]);
      setCustomerConversations([]);
      return;
    }
    try {
      const [questions, convs] = await Promise.all([
        conversationsApi.aiProxyQuestions(),
        conversationsApi.list(),
      ]);
      setAiQuestions(questions);
      setCustomerConversations(convs);
      setSelectedConversationId((current) => {
        if (current && convs.some((conv) => conv.id === current)) return current;
        return questions[0]?.conversation_id || convs[0]?.id || "";
      });
    } catch {
      setAiQuestions([]);
      setCustomerConversations([]);
    }
  }, []);

  const orderedAiQuestions = useMemo(
    () => [...aiQuestions].sort((a, b) => {
      const at = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
      return at - bt;
    }),
    [aiQuestions],
  );
  const activeQuestion = orderedAiQuestions[0] || null;
  const selectedConversation = customerConversations.find((conv) => conv.id === selectedConversationId) || null;
  const canTargetRider = Boolean(selectedConversation?.rider_id);

  useEffect(() => {
    if (proxyTarget === "rider" && !canTargetRider) setProxyTarget("pharmacy");
  }, [canTargetRider, proxyTarget]);

  useEffect(() => {
    void refreshAiQuestions();
    const id = setInterval(() => void refreshAiQuestions(), 8000);
    return () => clearInterval(id);
  }, [refreshAiQuestions]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-12)));
    }
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    const next: AiMsg[] = [...messages, { role: "user", content: text }];
    setMessages(next);

    setBusy(true);
    try {
      if (session.role() === "customer" && activeQuestion) {
        const payload = (activeQuestion.payload || {}) as Record<string, unknown>;
        const askerRole = String(payload.asker_role || "pharmacy");
        const askerLabel = askerRole === "rider" ? "Rider" : "Pharmacy";
        await conversationsApi.aiProxyAnswer(activeQuestion.conversation_id, activeQuestion.id, text);
        setAiQuestions((prev) => prev.filter((item) => item.id !== activeQuestion.id));
        setMessages([...next, { role: "assistant", content: `${askerLabel}-কে পাঠিয়ে দিলাম।` }]);
        void refreshAiQuestions();
        return;
      }

      if (session.role() === "customer" && selectedConversation) {
        const target: MediAiProxyTarget = proxyTarget === "rider" && !selectedConversation.rider_id ? "pharmacy" : proxyTarget;
        await conversationsApi.aiProxyMessage(selectedConversation.id, target, text);
        const targetLabel = target === "rider"
          ? selectedConversation.rider_name || "Rider"
          : target === "all"
            ? "Pharmacy ও Rider"
            : selectedConversation.pharmacy_name || "Pharmacy";
        setMessages([...next, { role: "assistant", content: `${targetLabel}-কে পাঠানো হয়েছে।` }]);
        void refreshAiQuestions();
        return;
      }

      const res = await fetch(`${API_URL}/api/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session.access() ? { Authorization: `Bearer ${session.access()}` } : {}),
        },
        body: JSON.stringify({ messages: next.slice(-10) }),
      });
      if (!res.ok) throw new Error(`AI ${res.status}`);
      const data = (await res.json()) as { reply: string };
      setMessages([...next, { role: "assistant", content: data.reply }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI request failed");
    } finally {
      setBusy(false);
    }
  }

  const targetLabel = proxyTarget === "rider"
    ? selectedConversation?.rider_name || "Rider"
    : proxyTarget === "all"
      ? "Pharmacy ও Rider"
      : selectedConversation?.pharmacy_name || "Pharmacy";
  const composerPlaceholder = activeQuestion
    ? `${activeQuestion.pharmacy_name || "Pharmacy"}-এর প্রশ্নের উত্তর লিখুন…`
    : selectedConversation
      ? `${targetLabel}-কে medi AI দিয়ে বার্তা পাঠান…`
      : "বার্তা লিখুন…";

  return (
    <div className={`flex w-[min(360px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-t-2xl border border-black/10 dark:border-white/10 bg-white/95 dark:bg-[#0b1018]/95 text-slate-900 dark:text-slate-100 shadow-2xl backdrop-blur-xl ${minimized ? "" : "max-sm:fixed max-sm:inset-x-0 max-sm:top-0 max-sm:bottom-[calc(var(--medi-kb,0px)_+_var(--medi-nav,0px))] max-sm:z-50 max-sm:w-full max-sm:rounded-none"}`}>
      <Header contact={contact} minimized={minimized} setMinimized={setMinimized} onClose={onClose} />
      {!minimized && (
        <>
          <div ref={scrollRef} className="h-[380px] space-y-2 overflow-y-auto px-3 py-3 text-sm max-sm:h-auto max-sm:flex-1 max-sm:min-h-0">
            {messages.length === 0 && orderedAiQuestions.length === 0 && customerConversations.length === 0 && (
              <div className="rounded-xl bg-brand-500/10 p-3 text-[12px] text-slate-700 dark:text-slate-200">
                হাই! আমি <b>{contact.name}</b> — কিছু জিজ্ঞাসা করুন।
              </div>
            )}
            {orderedAiQuestions.length > 0 && (
              <div className="space-y-2 rounded-2xl border border-amber-300/60 bg-amber-50/70 p-2 dark:border-amber-500/40 dark:bg-amber-500/10">
                <div className="flex items-center justify-between gap-2 px-1 text-[11px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                  <span className="inline-flex items-center gap-2"><Bot size={13} /> medi AI ইনবক্স</span>
                  <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[10px] text-white">{orderedAiQuestions.length}</span>
                </div>
                {activeQuestion && (
                  <div className="rounded-xl bg-white/80 px-2.5 py-2 text-[11px] text-amber-900 shadow-sm dark:bg-white/10 dark:text-amber-100">
                    নিচের উত্তর বক্সে লিখলে এখন {activeQuestion.pharmacy_name || "Pharmacy"}-এর প্রশ্নের উত্তর যাবে।
                  </div>
                )}
                {orderedAiQuestions.map((question) => (
                  <AiQuestionForCustomerCard
                    key={question.id}
                    msg={question}
                    myRole="customer"
                    conversationId={question.conversation_id}
                    onAnswered={() => {
                      setAiQuestions((prev) => prev.filter((item) => item.id !== question.id));
                      void refreshAiQuestions();
                    }}
                  />
                ))}
              </div>
            )}
            {!activeQuestion && customerConversations.length > 0 && (
              <div className="space-y-2 rounded-2xl border border-brand-500/20 bg-brand-500/5 p-2 dark:bg-brand-500/10">
                <div className="flex items-center gap-2 px-1 text-[11px] font-bold uppercase tracking-wide text-brand-700 dark:text-brand-300">
                  <Bot size={13} /> medi AI দিয়ে পাঠান
                </div>
                <select
                  value={selectedConversationId}
                  onChange={(event) => setSelectedConversationId(event.target.value)}
                  className="w-full rounded-xl border border-black/10 bg-white/90 px-2 py-1.5 text-[12px] text-slate-900 outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-white/10 dark:bg-slate-950 dark:text-slate-100"
                >
                  {customerConversations.map((conv) => (
                    <option key={conv.id} value={conv.id}>
                      {conv.pharmacy_name}{conv.rider_id ? ` · ${conv.rider_name || "Rider"}` : ""}
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setProxyTarget("pharmacy")}
                    className={`inline-flex items-center justify-center gap-1 rounded-xl px-2 py-1.5 text-[11px] font-bold ${proxyTarget === "pharmacy" ? "bg-brand-500 text-white" : "bg-white/80 text-slate-700 hover:bg-white dark:bg-white/10 dark:text-slate-200"}`}
                  >
                    <Store size={12} /> Pharmacy
                  </button>
                  <button
                    type="button"
                    onClick={() => canTargetRider && setProxyTarget("rider")}
                    disabled={!canTargetRider}
                    className={`inline-flex items-center justify-center gap-1 rounded-xl px-2 py-1.5 text-[11px] font-bold ${proxyTarget === "rider" ? "bg-amber-500 text-white" : "bg-white/80 text-slate-700 hover:bg-white dark:bg-white/10 dark:text-slate-200"} disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    <Bike size={12} /> Rider
                  </button>
                  <button
                    type="button"
                    onClick={() => setProxyTarget("all")}
                    className={`inline-flex items-center justify-center gap-1 rounded-xl px-2 py-1.5 text-[11px] font-bold ${proxyTarget === "all" ? "bg-slate-900 text-white dark:bg-white dark:text-slate-950" : "bg-white/80 text-slate-700 hover:bg-white dark:bg-white/10 dark:text-slate-200"}`}
                  >
                    <MessageCircle size={12} /> All
                  </button>
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={
                  m.role === "user"
                    ? "ml-auto max-w-[85%] rounded-2xl rounded-br-sm bubble-out px-3 py-2 text-white"
                    : "max-w-[88%] rounded-2xl rounded-bl-sm bg-slate-100 dark:bg-white/10 px-3 py-2 text-slate-900 dark:text-slate-100"
                }
              >
                {m.content}
              </div>
            ))}
            {busy && <TypingDots />}
            {error && (
              <div className="rounded-xl border border-red-300/50 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-[11px] text-red-700 dark:text-red-300">
                {error}
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="flex items-center gap-2 border-t border-black/5 dark:border-white/5 bg-white/60 dark:bg-white/5 px-2 py-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={composerPlaceholder}
              className="flex-1 rounded-full bg-black/5 dark:bg-white/10 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500/40"
              disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="grid h-9 w-9 place-items-center rounded-full bg-brand-500 text-white disabled:opacity-50"
            >
              <Send size={14} />
            </button>
          </form>
        </>
      )}
    </div>
  );
}

/* ---------------- Rider admin support chat ---------------- */

function fmtAdminThreadTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("bn-BD", {
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
  });
}

function RiderAdminChatPanel({
  contact,
  onClose,
  onSeen,
}: {
  contact: Extract<Contact, { kind: "rider-admin" }>;
  onClose: () => void;
  onSeen: () => void;
}) {
  const [minimized, setMinimized] = useState(false);
  const [messages, setMessages] = useState<RiderAdminMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (scroll = false) => {
    try {
      const path = adminThreadPath(contact.role);
      const res = await api<{ items: RiderAdminMsg[] }>(path);
      setMessages(res.items || []);
      setError(null);
      setLoading(false);
      onSeen();
      if (scroll) {
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load admin messages");
      setLoading(false);
    }
  }, [onSeen]);

  useEffect(() => { void load(true); }, [load]);

  useEffect(() => {
    if (minimized) return;
    const id = setInterval(() => void load(false), 8000);
    return () => clearInterval(id);
  }, [load, minimized]);

  useEffect(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    });
  }, [messages.length]);

  async function send(attachment?: { url: string; mime?: string | null }) {
    const body = input.trim();
    if ((!body && !attachment?.url) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const path = adminThreadPath(contact.role);
      await api<{ id: string }>(path, {
        method: "POST",
        body: JSON.stringify({
          body,
          attachment_url: attachment?.url || null,
          attachment_mime: attachment?.mime || null,
        }),
      });
      setInput("");
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setBusy(false);
    }
  }

  async function uploadAndSend(file: File) {
    if (busy || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API_URL}/api/upload`, {
        method: "POST",
        headers: session.access() ? { Authorization: `Bearer ${session.access()}` } : undefined,
        body: fd,
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { url: string; mime?: string };
      await send({ url: data.url, mime: data.mime || file.type || null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Attachment upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className={`flex w-[320px] flex-col overflow-hidden rounded-t-2xl border border-black/10 bg-white/95 text-slate-900 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#0b1018]/95 dark:text-slate-100 ${minimized ? "" : "max-sm:fixed max-sm:inset-x-0 max-sm:top-0 max-sm:bottom-[calc(var(--medi-kb,0px)_+_var(--medi-nav,0px))] max-sm:z-50 max-sm:w-full max-sm:rounded-none"}`}>
      <Header contact={contact} minimized={minimized} setMinimized={setMinimized} onClose={onClose} />
      {!minimized && (
        <>
          <div ref={scrollRef} className="h-[340px] space-y-2 overflow-y-auto px-3 py-3 text-sm max-sm:h-auto max-sm:flex-1 max-sm:min-h-0">
            {loading ? (
              <div className="grid h-full place-items-center text-xs text-slate-500">Loading…</div>
            ) : messages.length === 0 ? (
              <div className="rounded-xl bg-brand-500/10 p-3 text-[12px] text-slate-700 dark:text-slate-200">
                MediDoor Admin থেকে support message এলে এখানে আসবে।
              </div>
            ) : (
              messages.map((m) => {
                const mine = m.direction === "rider_to_admin" || m.direction === "customer_to_admin" || m.direction === "pharmacy_to_admin";
                return (
                  <div key={m.id} className={mine ? "flex justify-end" : "flex justify-start"}>
                    <div
                      className={
                        mine
                          ? "max-w-[85%] rounded-2xl rounded-br-sm bubble-out px-3 py-2 text-white"
                          : "max-w-[88%] rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-2 text-slate-900 dark:bg-white/10 dark:text-slate-100"
                      }
                    >
                      {!mine && (
                        <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-700 dark:text-brand-300">
                          MediDoor Admin
                        </div>
                      )}
                      <div className="whitespace-pre-line text-[13px] leading-snug">{m.body}</div>
                      {m.attachment_url && (
                        <SupportAttachment url={m.attachment_url} mime={m.attachment_mime} mine={mine} />
                      )}
                      <div className={`mt-1 text-right text-[10px] ${mine ? "text-brand-50" : "text-slate-400"}`}>
                        {fmtAdminThreadTime(m.created_at)}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            {error && (
              <div className="rounded-xl border border-red-300/50 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:bg-red-950/40 dark:text-red-300">
                {error}
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="flex items-end gap-2 border-t border-black/5 bg-white/60 px-2 py-2 dark:border-white/5 dark:bg-white/5"
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadAndSend(file);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy || uploading}
              className="grid h-9 w-9 place-items-center rounded-full bg-black/5 text-slate-600 hover:bg-black/10 disabled:opacity-50 dark:bg-white/10 dark:text-slate-200 dark:hover:bg-white/15"
              aria-label="Attach image or PDF"
              title="Attach image or PDF"
            >
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Admin কে reply লিখুন…"
              rows={1}
              className="max-h-24 flex-1 resize-none rounded-2xl bg-black/5 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500/40 dark:bg-white/10"
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="grid h-9 w-9 place-items-center rounded-full bg-brand-500 text-white disabled:opacity-50"
              aria-label="Send admin reply"
            >
              <Send size={14} />
            </button>
          </form>
        </>
      )}
    </div>
  );
}

function SupportAttachment({ url, mime, mine }: { url: string; mime?: string | null; mine: boolean }) {
  const lower = url.toLowerCase();
  const isPdf = (mime || "").includes("pdf") || lower.endsWith(".pdf");
  const isImage = (mime || "").startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(lower);
  const label = decodeURIComponent((url.split("/").pop() || "attachment").slice(0, 48));

  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="mt-2 block overflow-hidden rounded-xl border border-white/30 bg-black/5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="attachment" className="max-h-40 w-full object-cover" />
      </a>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={`mt-2 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ${
        mine ? "border-white/40 bg-white/15 text-white" : "border-slate-200 bg-white text-slate-700 dark:border-white/10 dark:bg-white/10 dark:text-slate-100"
      }`}
    >
      <Paperclip size={14} />
      <span className="min-w-0 flex-1 truncate">{isPdf ? "PDF" : "Attachment"}: {label}</span>
    </a>
  );
}

/* ---------------- Real conversation chat ---------------- */

function ConversationChatPanel({
  contact,
  liveConv,
  onClose,
  onActivity,
  onSeen,
}: {
  contact: Extract<Contact, { kind: "conversation" }>;
  liveConv: ConversationSummary;
  onClose: () => void;
  onActivity: () => void;
  onSeen: () => void;
}) {
  const [minimized, setMinimized] = useState(false);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [input, setInput] = useState(contact.initialDraft ?? "");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);
  const [customerComposerOpen, setCustomerComposerOpen] = useState(false);
  // @rider private channel — only customer or rider can use it; only enabled
  // once the conversation has a rider attached.
  const [riderOnly, setRiderOnly] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const myRole = contact.role;

  // Other-side last-read timestamp (for "Seen" indicator under my last bubble).
  const otherSideReadAt = useMemo(() => {
    // Pick the most recent of the OTHER two parties' read timestamps.
    const ts: number[] = [];
    if (myRole !== "customer" && liveConv.customer_last_read_at)
      ts.push(new Date(liveConv.customer_last_read_at).getTime());
    if (myRole !== "pharmacy" && liveConv.pharmacy_last_read_at)
      ts.push(new Date(liveConv.pharmacy_last_read_at).getTime());
    if (myRole !== "rider" && liveConv.rider_last_read_at)
      ts.push(new Date(liveConv.rider_last_read_at).getTime());
    return ts.length ? Math.max(...ts) : 0;
  }, [
    liveConv.customer_last_read_at,
    liveConv.pharmacy_last_read_at,
    liveConv.rider_last_read_at,
    myRole,
  ]);

  const riderArchiveCutoffMs = useMemo(() => {
    if (myRole !== "rider" || !liveConv.rider_message_cutoff) return null;
    const cutoff = new Date(liveConv.rider_message_cutoff).getTime();
    return Number.isFinite(cutoff) ? cutoff : null;
  }, [liveConv.rider_message_cutoff, myRole]);

  const riderDeliveryCutoffIndex = useMemo(() => {
    if (myRole !== "rider") return -1;
    let scopeStart = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].preset_key === ORDER_PRESETS.request) {
        scopeStart = index;
        break;
      }
    }
    let cutoffIndex = -1;
    for (let index = scopeStart; index < messages.length; index++) {
      const key = messages[index].preset_key;
      if (key === ORDER_PRESETS.delivery_complete || key === "rider_left") {
        cutoffIndex = index;
      }
    }
    return cutoffIndex;
  }, [messages, myRole]);

  const riderReadOnly =
    myRole === "rider" &&
    (Boolean(liveConv.rider_read_only) || riderDeliveryCutoffIndex >= 0 || Boolean(riderArchiveCutoffMs));

  useEffect(() => {
    if (!riderReadOnly) return;
    setError((prev) => (prev && isConversationAccessError(prev) ? null : prev));
  }, [riderReadOnly]);

  const displayMessages = useMemo(() => {
    if (myRole !== "rider") return messages;
    if (riderArchiveCutoffMs !== null) {
      return messages.filter((message) => {
        if (!message.created_at) return true;
        const created = new Date(message.created_at).getTime();
        return !Number.isFinite(created) || created <= riderArchiveCutoffMs;
      });
    }
    if (riderDeliveryCutoffIndex >= 0) {
      return messages.slice(0, riderDeliveryCutoffIndex + 1);
    }
    return messages;
  }, [messages, myRole, riderArchiveCutoffMs, riderDeliveryCutoffIndex]);

  const visibleMessages = useMemo(
    () => displayMessages.filter((message) => message.preset_key !== "ai_question_for_customer"),
    [displayMessages],
  );

  // Index of the latest message I sent — Seen indicator goes under it.
  const lastMineIndex = useMemo(() => {
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (visibleMessages[i].sender_role === myRole) return i;
    }
    return -1;
  }, [visibleMessages, myRole]);

  const customerCanRequestOrder = useMemo(() => {
    if (myRole !== "customer") return false;
    let scopeStart = 0;
    for (let index = visibleMessages.length - 1; index >= 0; index--) {
      if (visibleMessages[index].preset_key === ORDER_PRESETS.request) {
        scopeStart = index;
        break;
      }
    }
    const state = lastOrderState(visibleMessages.slice(scopeStart));
    const inProgress =
      state.hasOpenRequest ||
      (state.lastStatus && ["confirmed", "preparing", "on_the_way"].includes(state.lastStatus));
    return !inProgress;
  }, [visibleMessages, myRole]);

  const refresh = useCallback(async () => {
    try {
      const rows = await conversationsApi.messages(contact.conversation.id);
      setMessages(rows);
      setError((prev) => (prev && isConversationAccessError(prev) ? null : prev));
      // Mark this conversation as seen using the wall-clock NOW so we always
      // beat any server-side last_message_at jitter (microseconds, tz-naive
      // datetimes, etc.). The exact server timestamp doesn't matter — what
      // matters is "user has the chat panel open right now".
      setSeenAt(contact.conversation.id, Date.now());
      // Mark conversation as seen on the server (silent — best effort).
      conversationsApi.markSeen(contact.conversation.id).catch(() => {});
      onSeen();
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Failed to load messages";
      if (myRole === "rider" && isConversationAccessError(raw)) {
        setError(null);
        onActivity();
        return;
      }
      setError(raw);
    }
  }, [contact.conversation.id, myRole, onActivity, onSeen]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  // Robust auto-scroll. The chat dock is short (360px) and often opens on a
  // tall order card whose prescription / item images load asynchronously —
  // so a one-shot scroll fires BEFORE the images grow the content and the
  // view gets stuck near the top, hiding newer messages / quotes below the
  // fold (Problems 3 & 4). We keep "stick to bottom" while the user hasn't
  // scrolled up, and re-scroll on every message change AND whenever any
  // descendant image finishes loading.
  const stickToBottomRef = useRef(true);
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Double rAF so layout (including freshly-loaded images) is settled.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight });
      });
    });
  }, []);

  useEffect(() => {
    if (stickToBottomRef.current) scrollToBottom();
  }, [messages, minimized, scrollToBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || minimized) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = dist < 120;
    };
    // Image load events don't bubble, but they DO fire during the capture
    // phase on ancestors — so one listener on the scroll container catches
    // every late-loading image (prescription, item thumbnails, attachments).
    const onImgLoad = () => {
      if (stickToBottomRef.current) scrollToBottom();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("load", onImgLoad, true);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("load", onImgLoad, true);
    };
  }, [minimized, scrollToBottom]);

  async function sendMessage(payload: { body?: string; attachment_url?: string | null; preset_key?: string | null; payload?: OrderPayload | null; visibility?: MessageVisibility }) {
    if (busy) return;
    if (riderReadOnly) {
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const m = await conversationsApi.send(contact.conversation.id, payload);
      stickToBottomRef.current = true; // sending → always snap to newest
      setMessages((prev) => [...prev, m]);
      setSeenAt(contact.conversation.id, Date.now());
      onActivity();
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Send failed";
      // 423 Locked = conversation auto-blocked by AI moderation
      if (raw.includes("API 423")) {
        setError("⛔ Conversation locked by medi AI. Admin review না হওয়া পর্যন্ত আর message পাঠানো যাবে না।");
        // Force a refresh so we pick up the new lock state + system msg.
        void refresh();
      } else if (myRole === "rider" && isConversationAccessError(raw)) {
        setError(null);
        void refresh();
      } else {
        setError(raw);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    const visibility = riderOnly && liveConv.rider_id ? "customer_rider" : "all";
    await sendMessage({ body: text, visibility });
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setUploading(true);
    setError(null);
    try {
      const url = await uploadImage(f);
      await sendMessage({ body: input.trim() || "📎 attachment", attachment_url: url });
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className={`flex w-[340px] flex-col items-stretch gap-2 ${minimized ? "" : "max-sm:fixed max-sm:inset-x-0 max-sm:top-0 max-sm:bottom-[calc(var(--medi-kb,0px)_+_var(--medi-nav,0px))] max-sm:z-50 max-sm:w-full max-sm:gap-0"}`}>
      <div className={`flex flex-col overflow-hidden rounded-t-2xl border border-black/10 dark:border-white/10 bg-white/95 dark:bg-[#0b1018]/95 text-slate-900 dark:text-slate-100 shadow-2xl backdrop-blur-xl ${minimized ? "" : "max-sm:h-full max-sm:rounded-none"}`}>
      <Header contact={contact} minimized={minimized} setMinimized={setMinimized} onClose={onClose} />
      {!minimized && (
        <>
          <div className="flex items-center justify-between border-b border-black/5 px-3 py-1.5 text-[11px] dark:border-white/10">
            <span className="opacity-60">Order location</span>
            <button
              type="button"
              onClick={() => setShowMap((v) => !v)}
              className="inline-flex items-center gap-1 rounded-full bg-brand-500 px-2.5 py-1 font-semibold text-white hover:bg-brand-600"
            >
              <MapPin size={11} /> Map
            </button>
          </div>
          {showMap && <ConversationMapPanel conversationId={contact.conversation.id} />}
          <div ref={scrollRef} className="h-[360px] space-y-2 overflow-y-auto px-3 py-3 text-sm max-sm:h-auto max-sm:flex-1 max-sm:min-h-0">
            {visibleMessages.length === 0 && (
              <div className="rounded-xl bg-brand-500/5 p-3 text-[12px] opacity-80">
                {myRole === "customer"
                  ? "Pharmacy-কে যা জিজ্ঞাসা করতে চান, লিখুন বা নিচের preset ব্যবহার করুন।"
                  : "Customer-এর সাথে সরাসরি কথা বলুন। নিচের preset দিয়ে দ্রুত reply দিতে পারবেন।"}
              </div>
            )}
            {visibleMessages.map((m, idx) => {
              const mine = m.sender_role === myRole;
              const system = m.sender_role === "system";

              // ── medi AI moderation / mention bubbles (special styling) ──
              if (system && m.preset_key === "ai_block") {
                return (
                  <div
                    key={m.id}
                    className="mx-auto max-w-[95%] rounded-2xl border border-rose-400/60 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-[12px] text-rose-700 dark:text-rose-200 shadow-sm"
                  >
                    <div className="mb-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-rose-600 dark:text-rose-300">
                      <span>🛡️</span> medi AI · conversation locked
                    </div>
                    <div className="whitespace-pre-line">{m.body}</div>
                  </div>
                );
              }
              if (system && m.preset_key === "ai_warn_medium") {
                return (
                  <div
                    key={m.id}
                    className="mx-auto max-w-[92%] rounded-2xl border border-orange-400/60 bg-orange-50 dark:bg-orange-950/40 px-3 py-2 text-[12px] text-orange-800 dark:text-orange-200"
                  >
                    <div className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-orange-600 dark:text-orange-300">
                      <span>🛡️</span> medi AI · medium-risk warning
                    </div>
                    <div className="whitespace-pre-line">{m.body}</div>
                  </div>
                );
              }
              if (system && m.preset_key === "ai_warn_low") {
                return (
                  <div
                    key={m.id}
                    className="mx-auto max-w-[90%] rounded-xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-1.5 text-[11px] text-amber-800 dark:text-amber-200"
                  >
                    {m.body}
                  </div>
                );
              }
              if (system && m.preset_key === "ai_unblock") {
                return (
                  <div
                    key={m.id}
                    className="mx-auto max-w-[92%] rounded-2xl border border-emerald-400/60 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-[12px] text-emerald-800 dark:text-emerald-200"
                  >
                    <div className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide">
                      <span>✅</span> admin · unlocked
                    </div>
                    <div className="whitespace-pre-line">{m.body}</div>
                  </div>
                );
              }
              if (system && m.preset_key === "ai_reply") {
                return (
                  <div
                    key={m.id}
                    className="mx-auto flex max-w-[92%] gap-2 rounded-2xl border border-brand-300/40 bg-brand-50 dark:bg-brand-950/40 px-3 py-2 text-[12px] text-slate-800 dark:text-slate-100"
                  >
                    <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-500 text-white text-[11px]">🤖</div>
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wide text-brand-600 dark:text-brand-300">medi AI</div>
                      <div className="whitespace-pre-line">{m.body}</div>
                    </div>
                  </div>
                );
              }

              // Handshake / dual-confirm cards (AI-brokered flow)
              if (
                m.preset_key === "ai_handshake" ||
                m.preset_key === "ai_customer_confirm_prompt" ||
                m.preset_key === "ai_handshake_completed" ||
                m.preset_key === "ai_handshake_rejected" ||
                m.preset_key === "ai_handshake_cancelled"
              ) {
                return (
                  <HandshakeCard
                    key={m.id}
                    msg={m}
                    myRole={myRole}
                    allMessages={visibleMessages}
                    onAction={(payload) => void sendMessage(payload)}
                  />
                );
              }

              // Handshake action triggers (RPC-style) — the system status pills
              // above already convey the outcome, so suppress the duplicate bubble.
              if (
                m.preset_key === "pharmacy_handshake_ok" ||
                m.preset_key === "pharmacy_handshake_reject" ||
                m.preset_key === "customer_handshake_cancel"
              ) {
                return null;
              }

              // Phase 3: Proactive add-on listener cards
              if (
                m.preset_key === "ai_addon_prompt" ||
                m.preset_key === "ai_addon_suggestion" ||
                m.preset_key === "ai_addon_dismissed"
              ) {
                return (
                  <AddonCard
                    key={m.id}
                    msg={m}
                    myRole={myRole}
                    allMessages={visibleMessages}
                    onAction={(payload) => void sendMessage(payload)}
                  />
                );
              }

              // Phase 4: Pre-packaging order modify window cards
              if (
                m.preset_key === "ai_modify_window_open" ||
                m.preset_key === "ai_modify_window_closed" ||
                m.preset_key === "ai_order_modified"
              ) {
                return (
                  <ModifyWindowCard
                    key={m.id}
                    msg={m}
                    myRole={myRole}
                    allMessages={visibleMessages}
                  />
                );
              }

              // Phase 5: AI auto @rider expiry-date check card
              if (m.preset_key === "ai_rider_expiry_check") {
                return (
                  <RiderExpiryCheckCard
                    key={m.id}
                    msg={m}
                    myRole={myRole}
                  />
                );
              }

              // Phase 6: AI auto location prompt card (customer-side share button)
              if (m.preset_key === "ai_customer_location_prompt") {
                return (
                  <CustomerLocationPromptCard
                    key={m.id}
                    msg={m}
                    myRole={myRole}
                    allMessages={visibleMessages}
                    onShare={(payload) => void sendMessage(payload)}
                  />
                );
              }

              // Phase 6 result card — confirmation that customer shared location
              if (m.preset_key === "ai_customer_location_shared") {
                return (
                  <CustomerLocationSharedCard
                    key={m.id}
                    msg={m}
                  />
                );
              }

              // System messages render as a centered amber pill EXCEPT
              // rider_joined / rider_left, which deserve prominent rider-themed cards.
              if (system && m.preset_key !== "rider_left" && m.preset_key !== "rider_joined") {
                return (
                  <div
                    key={m.id}
                    className="mx-auto max-w-[88%] rounded-full bg-amber-500/10 px-3 py-1 text-center text-[11px] text-amber-700 dark:text-amber-300"
                  >
                    {m.body}
                  </div>
                );
              }

              // Order-workflow cards (rendered specially based on preset_key)
              if (
                m.preset_key &&
                (m.preset_key.startsWith("order_") ||
                  m.preset_key === ORDER_PRESETS.call_rider ||
                  m.preset_key === ORDER_PRESETS.rider_joined ||
                  m.preset_key === "rider_left" ||
                  m.preset_key === ORDER_PRESETS.handed_over ||
                  m.preset_key === ORDER_PRESETS.delivery_complete ||
                  m.preset_key === ORDER_PRESETS.quote)
              ) {
                return (
                  <OrderEventCard
                    key={m.id}
                    msg={m}
                    mine={mine}
                    myRole={myRole}
                    pharmacyId={contact.conversation.pharmacy_id}
                    allMessages={visibleMessages}
                    onAction={(payload) => void sendMessage(payload)}
                  />
                );
              }

              const showSeen =
                mine &&
                idx === lastMineIndex &&
                m.created_at &&
                otherSideReadAt >= new Date(m.created_at).getTime();

              return (
                <div key={m.id} className="space-y-1">
                  <div
                    className={
                      mine
                        ? `ml-auto max-w-[85%] rounded-2xl rounded-br-sm px-3 py-2 text-white ${
                            m.visibility === "customer_rider" || m.visibility === "customer_pharmacy" || m.visibility === "pharmacy_rider"
                              ? "bg-amber-500 ring-2 ring-amber-300/60"
                              : "bubble-out"
                          }`
                        : `max-w-[88%] rounded-2xl rounded-bl-sm px-3 py-2 text-slate-900 dark:text-slate-100 ${
                            m.visibility === "customer_rider" || m.visibility === "customer_pharmacy" || m.visibility === "pharmacy_rider"
                              ? "bg-amber-100 dark:bg-amber-900/40 ring-1 ring-amber-300/60"
                              : "bg-slate-100 dark:bg-white/10"
                          }`
                    }
                  >
                    {(m.visibility === "customer_rider" || m.visibility === "customer_pharmacy" || m.visibility === "pharmacy_rider") && (
                      <div className={`mb-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                        mine ? "bg-white/25" : "bg-amber-500 text-white"
                      }`}>
                        {m.visibility === "customer_pharmacy" ? <Store size={9} /> : <Bike size={9} />}
                        {m.visibility === "customer_pharmacy"
                          ? "Pharmacy · private"
                          : m.visibility === "customer_rider"
                            ? "@rider · private"
                            : "@rider · internal"}
                      </div>
                    )}
                    {m.attachment_url && (
                      <a href={m.attachment_url} target="_blank" rel="noreferrer" className="mb-1 block">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={m.attachment_url}
                          alt="attachment"
                          className="max-h-40 w-full rounded-xl object-cover"
                        />
                      </a>
                    )}
                    {m.body && <div className="whitespace-pre-line">{m.body}</div>}
                  </div>
                  {showSeen && (
                    <div className="ml-auto flex items-center gap-1 pr-1 text-[10px] text-brand-600 dark:text-brand-300">
                      <CheckCheck size={12} /> দেখেছেন
                    </div>
                  )}
                </div>
              );
            })}
            {(busy || uploading) && <TypingDots />}
            {error && (
              <div className="rounded-xl border border-red-300/50 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-[11px] text-red-700 dark:text-red-300">
                {error}
              </div>
            )}
          </div>

          {/* AI lock banner (replaces composer when conversation is blocked) */}
          {liveConv.blocked_at ? (
            <div className="border-t border-rose-300/40 bg-rose-50 dark:bg-rose-950/40 px-3 py-2.5 text-[12px] text-rose-700 dark:text-rose-200">
              <div className="mb-1 flex items-center gap-1.5 font-bold">
                <span>🛡️</span>
                Conversation locked by medi AI
              </div>
              <div className="opacity-90">
                {liveConv.block_reason || "নিরাপত্তা নীতি ভঙ্গের জন্য এই chat বন্ধ রাখা হয়েছে।"}
              </div>
              <div className="mt-1 text-[10px] opacity-70">
                Admin review না হওয়া পর্যন্ত আর message পাঠানো যাবে না।
              </div>
            </div>
          ) : riderReadOnly ? (
            <div className="border-t border-emerald-300/40 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2.5 text-[12px] text-emerald-800 dark:text-emerald-200">
              <div className="mb-1 font-bold">✅ Delivery complete — rider archive</div>
              <div className="opacity-90">
                Rider এই delivery শেষ করেছে। এখন customer↔pharmacy follow-up দেখা বা message করা যাবে না।
              </div>
              {liveConv.rider_archive_until && (
                <div className="mt-1 text-[10px] opacity-70">
                  Archive visible until {new Date(liveConv.rider_archive_until).toLocaleString("en-BD")}
                </div>
              )}
            </div>
          ) : (
          <>
          {/* Order workflow quick actions — role-aware */}
          <OrderQuickActions
            myRole={myRole}
            pharmacyId={contact.conversation.pharmacy_id}
            hasRider={!!liveConv.rider_id}
            messages={visibleMessages}
            onSend={(payload) => void sendMessage(payload)}
          />

          <form
            onSubmit={onSubmit}
            className="flex flex-col gap-1.5 border-t border-black/5 dark:border-white/5 bg-white/60 dark:bg-white/5 px-2 py-2"
          >
            {/* Quick chips: @rider private toggle + @mediai mention helper */}
            <div className="flex flex-wrap items-center gap-1.5">
              {myRole === "customer" && customerCanRequestOrder && (
                <button
                  type="button"
                  onClick={() => setCustomerComposerOpen(true)}
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-500 px-2.5 py-1 text-[10px] font-bold text-white shadow-sm hover:bg-emerald-600"
                  title="নতুন অর্ডার request তৈরি করুন"
                >
                  <Package size={11} /> অর্ডার request
                </button>
              )}
              {myRole === "customer" && liveConv.rider_id && (
                <button
                  type="button"
                  onClick={() => setRiderOnly((v) => !v)}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold transition ${
                    riderOnly
                      ? "bg-amber-500 text-white shadow"
                      : "bg-black/5 dark:bg-white/10 text-slate-700 dark:text-slate-200 hover:bg-black/10"
                  }`}
                  title={riderOnly ? "Next message: rider only (pharmacy will not see)" : "Tap to message rider only"}
                >
                  <Bike size={11} /> @rider {riderOnly ? "— private (rider only)" : ""}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setInput((v) => {
                    const trimmed = (v || "").trim();
                    if (trimmed.toLowerCase().includes("@mediai")) return v;
                    return trimmed ? `@mediai ${trimmed}` : "@mediai ";
                  });
                  // refocus the input
                  requestAnimationFrame(() => {
                    const el = scrollRef.current?.parentElement?.querySelector<HTMLInputElement>("input[type='text'], input:not([type])");
                    el?.focus();
                  });
                }}
                className="inline-flex items-center gap-1 rounded-full bg-brand-500/10 dark:bg-brand-500/20 px-2.5 py-1 text-[10px] font-bold text-brand-700 dark:text-brand-300 hover:bg-brand-500/20"
                title="Ask medi AI in this chat"
              >
                🤖 @mediai
              </button>
            </div>
            <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="grid h-9 w-9 place-items-center rounded-full bg-black/5 hover:bg-black/10 dark:bg-white/10"
              title="Attach image"
              disabled={uploading}
            >
              <Paperclip size={14} />
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickFile} />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={riderOnly ? "@rider — private message…" : "বার্তা লিখুন… ('@mediai' দিলে medi AI সাহায্য করবে)"}
              className={`flex-1 rounded-full px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500/40 ${
                riderOnly ? "bg-amber-100 dark:bg-amber-900/40" : "bg-black/5 dark:bg-white/10"
              }`}
              disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="grid h-9 w-9 place-items-center rounded-full bg-brand-500 text-white disabled:opacity-50"
            >
              <Send size={14} />
            </button>
            </div>
          </form>
          {myRole === "customer" && customerComposerOpen && (
            <OrderComposer
              pharmacyId={contact.conversation.pharmacy_id}
              mode="request"
              onClose={() => setCustomerComposerOpen(false)}
              onSubmit={(payload, body, attachmentUrl) => {
                setCustomerComposerOpen(false);
                void sendMessage({
                  body,
                  preset_key: ORDER_PRESETS.request,
                  payload,
                  attachment_url: attachmentUrl ?? null,
                });
              }}
            />
          )}
          </>
          )}
        </>
      )}
      </div>
    </div>
  );
}

function Header({
  contact,
  minimized,
  setMinimized,
  onClose,
}: {
  contact: Contact;
  minimized: boolean;
  setMinimized: (fn: (m: boolean) => boolean) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-black/5 dark:border-white/5 bg-brand-500/10 px-3 py-2 text-slate-900 dark:text-white">
      <Avatar contact={contact} size={32} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold leading-tight text-slate-900 dark:text-white">{contact.name}</p>
        <p className="truncate text-[10px] text-slate-600 dark:text-slate-300">{contact.tagline}</p>
      </div>
      <button
        onClick={() => setMinimized((m) => !m)}
        className="rounded-full p-1 hover:bg-black/10 dark:hover:bg-white/10"
      >
        <Minus size={14} />
      </button>
      <button onClick={onClose} className="rounded-full p-1 hover:bg-black/10 dark:hover:bg-white/10">
        <X size={14} />
      </button>
    </div>
  );
}

function TypingDots() {
  return (
    <div className="max-w-[60%] rounded-2xl rounded-bl-sm bg-slate-100 dark:bg-white/10 px-3 py-2 text-slate-700 dark:text-slate-200">
      <span className="inline-flex gap-1">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-200ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-100ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
      </span>
    </div>
  );
}

function ConversationMapPanel({ conversationId }: { conversationId: string }) {
  const [track, setTrack] = useState<ConversationTrack | null>(null);
  const [route, setRoute] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await conversationsApi.track(conversationId);
        if (!cancelled) { setTrack(data); setErr(null); }
      } catch (e) {
        if (!cancelled) {
          const raw = e instanceof Error ? e.message : "Map unavailable";
          setErr(isConversationAccessError(raw) ? null : raw);
        }
      }
    };
    void load();
    const id = setInterval(load, 7000);
    return () => { cancelled = true; clearInterval(id); };
  }, [conversationId]);

  const pharmacyPoint = track?.pharmacy.lat != null && track.pharmacy.lng != null
    ? { lat: track.pharmacy.lat, lng: track.pharmacy.lng }
    : null;
  const customerPoint = track?.customer.lat != null && track.customer.lng != null
    ? { lat: track.customer.lat, lng: track.customer.lng }
    : null;
  const riderPoint = track?.rider?.lat != null && track.rider.lng != null
    ? { lat: track.rider.lat, lng: track.rider.lng }
    : null;
  useEffect(() => {
    if (!pharmacyPoint || !customerPoint) { setRoute(null); return; }
    let cancelled = false;
    geoApi.route(pharmacyPoint, customerPoint)
      .then((r) => { if (!cancelled) setRoute(r.geometry); })
      .catch(() => { if (!cancelled) setRoute(null); });
    return () => { cancelled = true; };
  }, [pharmacyPoint?.lat, pharmacyPoint?.lng, customerPoint?.lat, customerPoint?.lng]);

  const markers = [
    pharmacyPoint && track && {
      id: track.pharmacy.id ?? "pharmacy",
      name: track.pharmacy.name ? `Pharmacy: ${track.pharmacy.name}` : "Pharmacy",
      business_name: "Pickup",
      address: track.pharmacy.address,
      phone: track.pharmacy.phone,
      lat: pharmacyPoint.lat,
      lng: pharmacyPoint.lng,
      rating: 0,
      rating_count: 0,
      is_verified: true,
      is_open: true,
      banner_photo_url: track.pharmacy.banner_photo_url ?? null,
    },
  ].filter(Boolean) as import("@/lib/geo").PharmacyMarker[];

  return (
    <div className="border-b border-black/5 bg-slate-50 p-2 dark:border-white/10 dark:bg-white/5">
      {err && <p className="px-2 py-1 text-[11px] text-rose-600">{err}</p>}
      <div className="h-52 overflow-hidden rounded-xl">
        <MediMap
          height="100%"
          center={riderPoint ?? pharmacyPoint ?? customerPoint}
          zoom={14}
          customerLocation={customerPoint}
          customerLabel={track?.customer.name ? `Customer: ${track.customer.name}` : "Customer"}
          customerAvatarUrl={track?.customer.profile_photo_url ?? null}
          customerFallbackImageUrl="/brand/logo-outside-bg.png"
          riderLocation={riderPoint}
          riderLabel={track?.rider?.name ?? "Rider"}
          pharmacies={markers}
          routePolyline={route}
          pickEnabled={false}
          showSearch={false}
          showLocateButton={false}
        />
      </div>
    </div>
  );
}


/* =============================================================== */
/* Order workflow: quick actions bar + event cards (Confirm/Reject  */
/* + status updates + rating prompt) inside the conversation panel. */
/* =============================================================== */

type SendFn = (p: { body?: string; attachment_url?: string | null; preset_key?: string | null; payload?: OrderPayload | null }) => void;

function lastOrderState(messages: ConversationMessage[]): {
  hasOpenRequest: boolean;
  lastStatus: string | null;
  alreadyRated: boolean;
  deliveredAt: string | null;
} {
  let hasOpenRequest = false;
  let lastStatus: string | null = null;
  let alreadyRated = false;
  let deliveredAt: string | null = null;
  for (const m of messages) {
    if (m.preset_key === ORDER_PRESETS.request) {
      // AI prescription orders reach the chat only AFTER the full dual
      // handshake (pharmacy accepted stock + customer Final Confirm), so they
      // are already a confirmed order — not a fresh request awaiting pharmacy
      // approval. Treat them as confirmed so the pharmacy jumps straight to
      // "Packing শুরু" instead of looping on "Confirm request". (Backend also
      // posts an order_confirm; this keeps pre-fix / in-flight orders correct.)
      const src = (m.payload as unknown as { source?: string } | null)?.source;
      if (src === "ai_prescription") {
        hasOpenRequest = false;
        lastStatus = "confirmed";
      } else {
        hasOpenRequest = true;
      }
    }
    // pharmacy_quote does NOT close the request — customer can confirm/reject the quote.
    if (m.preset_key === ORDER_PRESETS.confirm || m.preset_key === ORDER_PRESETS.reject) {
      hasOpenRequest = false;
      lastStatus = m.preset_key === ORDER_PRESETS.confirm ? "confirmed" : "rejected";
    }
    if (m.preset_key === ORDER_PRESETS.status_preparing) lastStatus = "preparing";
    if (m.preset_key === ORDER_PRESETS.status_on_the_way) lastStatus = "on_the_way";
    if (m.preset_key === ORDER_PRESETS.status_delivered) {
      lastStatus = "delivered";
      deliveredAt = m.created_at;
    }
    // Rider's "delivery_complete" also counts as delivered (unlocks rating).
    if (m.preset_key === ORDER_PRESETS.delivery_complete) {
      lastStatus = "delivered";
      if (!deliveredAt) deliveredAt = m.created_at;
    }
    if (m.preset_key === ORDER_PRESETS.rating_submitted) alreadyRated = true;
  }
  return { hasOpenRequest, lastStatus, alreadyRated, deliveredAt };
}

/* ---------- Reusable reason prompt modal (replaces window.prompt) ---------- */
// Some embedded browser contexts (Playwright headless, VS Code Simple Browser,
// the integrated MCP browser) throw `prompt() is not supported` when
// `window.prompt` is invoked. This inline modal is the in-app replacement
// for collecting an optional cancel/reject reason from the user.
function ReasonPromptModal({
  open,
  title,
  placeholder,
  submitLabel = "Confirm",
  onCancel,
  onSubmit,
}: {
  open: boolean;
  title: string;
  placeholder?: string;
  submitLabel?: string;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (open) setValue("");
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl ring-1 ring-black/5 dark:bg-slate-900 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {title}
        </h3>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          autoFocus
          rows={3}
          maxLength={300}
          className="mt-3 w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            বাতিল
          </button>
          <button
            type="button"
            onClick={() => onSubmit(value.trim())}
            className="rounded-full bg-rose-500 px-3 py-1 text-xs font-semibold text-white hover:bg-rose-600"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function OrderQuickActions({
  myRole,
  pharmacyId,
  hasRider,
  messages,
  onSend,
}: {
  myRole: "customer" | "pharmacy" | "rider";
  pharmacyId: string;
  hasRider: boolean;
  messages: ConversationMessage[];
  onSend: SendFn;
}) {
  // Reason-prompt state (replaces window.prompt for cancel/reject flows).
  const [reasonModal, setReasonModal] = useState<
    null | { kind: "customer_cancel" | "pharmacy_reject" }
  >(null);
  // Scope workflow state to the LATEST order only. A single conversation
  // may contain multiple sequential orders — old delivery_complete /
  // rating_submitted flags must not leak into a brand-new order_request.
  let scopeStart = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].preset_key === ORDER_PRESETS.request) { scopeStart = i; break; }
  }
  const scopedMessages = messages.slice(scopeStart);
  const state = lastOrderState(scopedMessages);
  const [composer, setComposer] = useState<"request" | "quote" | "modify" | null>(null);

  // Track new rider-flow presets locally (scoped to latest order)
  let calledRider = false;
  let handedOver = false;
  let deliveryDone = false;
  // `riderJoinedThisOrder` is the only correct "is there a rider for THIS
  // order" signal — the conv-level `hasRider` prop can be stale when a
  // previous order finished without properly clearing `Conversation.rider_id`
  // (e.g. legacy data, or a delivery completed via a path that missed the
  // detach). We rely on the in-scope `rider_joined` event instead so the
  // pharmacy still sees Quote/Confirm/Preparing/Call-rider buttons for a
  // fresh order even if the conversation has a stale rider_id.
  let riderJoinedThisOrder = false;
  for (const m of scopedMessages) {
    if (m.preset_key === ORDER_PRESETS.call_rider) calledRider = true;
    if (m.preset_key === ORDER_PRESETS.handed_over) handedOver = true;
    if (m.preset_key === ORDER_PRESETS.delivery_complete) deliveryDone = true;
    if (m.preset_key === ORDER_PRESETS.rider_joined) riderJoinedThisOrder = true;
  }
  // Only treat a rider as "in this order" if BOTH the conv has a rider AND
  // we've seen the rider_joined event since the latest order_request.
  const riderActive = hasRider && riderJoinedThisOrder;

  if (myRole === "rider") {
    if (deliveryDone) return null;
    return (
      <div className="flex flex-wrap gap-1.5 border-t border-black/5 dark:border-white/5 bg-emerald-500/5 px-2 py-2">
        {!handedOver && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-1 text-[10px] text-amber-800 dark:text-amber-200">
            ⏳ Pharmacy hand-over confirm করার অপেক্ষায়…
          </span>
        )}
        {handedOver && (
          <button
            type="button"
            onClick={() =>
              onSend({
                body: "✅ Delivery complete — customer-এর কাছে পৌঁছে দিয়েছি।",
                preset_key: ORDER_PRESETS.delivery_complete,
              })
            }
            className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-600"
          >
            <CheckCircle2 size={12} /> ✅ Delivery complete
          </button>
        )}
      </div>
    );
  }

  if (myRole === "customer") {
    const inProgress =
      state.hasOpenRequest ||
      (state.lastStatus &&
        ["confirmed", "preparing", "on_the_way"].includes(state.lastStatus));
    if (inProgress) {
      // Customer can cancel ONLY before the rider has accepted / received
      // the package. Once handed over, the medicine is in transit — too late
      // to cancel from the chat (would need a refund/return flow).
      const canCancel = !handedOver && !riderActive;
      if (!canCancel) return null;
      return (
        <>
          <div className="flex flex-wrap gap-1.5 border-t border-black/5 dark:border-white/5 bg-emerald-500/5 px-2 py-2">
            <button
              type="button"
              onClick={() => setReasonModal({ kind: "customer_cancel" })}
              className="inline-flex items-center gap-1.5 rounded-full bg-rose-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-rose-600"
              title="Rider hand-over এর আগে order cancel করুন"
            >
              🚫 অর্ডার বাতিল
            </button>
          </div>
          <ReasonPromptModal
            open={reasonModal?.kind === "customer_cancel"}
            title="অর্ডার বাতিল করছেন?"
            placeholder="কারণ লিখুন (optional)"
            submitLabel="অর্ডার বাতিল"
            onCancel={() => setReasonModal(null)}
            onSubmit={(reason) => {
              setReasonModal(null);
              const body = reason
                ? `🚫 Customer অর্ডার বাতিল করেছেন।\nকারণ: ${reason}`
                : "🚫 Customer অর্ডার বাতিল করেছেন।";
              onSend({ body, preset_key: ORDER_PRESETS.reject });
            }}
          />
        </>
      );
    }
    return null;
  }

  // Pharmacy side — strict step-gating: ONE button at a time.
  // Sequence: Quote → (customer Confirm/Reject inline) → Preparing → Call rider
  //           → (waiting for rider accept) → Handed to rider → (delivered)
  const status = state.lastStatus;

  // Pharmacy issue-actions row — Stock-out (cancels order) and Delay (asks
  // for reason + ETA). Shown alongside every active pharmacy step from
  // "confirmed" onward (until handed over). Centralised so we can render
  // it inside multiple branches without duplicating prompts.
  const issueRow = (
    <PharmacyIssueActions
      onCancelStockOut={(itemNote, reason) => {
        const itemPart = itemNote
          ? `❌ দুঃখিত, "${itemNote}" stock-এ নেই — অর্ডার বাতিল করতে হচ্ছে।`
          : "❌ দুঃখিত, কিছু item stock-এ নেই — অর্ডার বাতিল করতে হচ্ছে।";
        const body = reason ? `${itemPart}\nকারণ: ${reason}` : itemPart;
        onSend({ body, preset_key: ORDER_PRESETS.reject });
      }}
      onDelay={(minutes, reason) => {
        const body = `⏱️ একটু দেরি হবে — আনুমানিক ${minutes} মিনিট।${reason ? `\nকারণ: ${reason}` : ""}`;
        onSend({ body, preset_key: ORDER_PRESETS.delay });
      }}
    />
  );

  // If the latest order was rejected/cancelled, show a fresh Quote button so
  // the pharmacy can issue a new quote (or wait for a new request from
  // customer). All previous workflow state for this order is moot.
  if (status === "rejected") {
    return (
      <>
        <div className="flex flex-wrap gap-1.5 border-t border-black/5 dark:border-white/5 bg-emerald-500/5 px-2 py-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 dark:bg-rose-900/40 px-2 py-1 text-[10px] text-rose-800 dark:text-rose-200">
            ❌ অর্ডার বাতিল হয়েছে — customer নতুন request পাঠাতে পারবেন।
          </span>
        </div>
      </>
    );
  }

  // Hide everything once delivery is complete.
  if (status === "delivered" || deliveryDone) {
    return (
      <div className="flex flex-wrap gap-1.5 border-t border-black/5 dark:border-white/5 bg-emerald-500/5 px-2 py-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-2 py-1 text-[10px] text-emerald-800 dark:text-emerald-200">
          <CheckCircle2 size={11} /> Delivery complete
        </span>
      </div>
    );
  }

  // After hand-over → just wait for rider to mark delivery_complete.
  if (handedOver) {
    return (
      <div className="flex flex-wrap gap-1.5 border-t border-black/5 dark:border-white/5 bg-emerald-500/5 px-2 py-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 dark:bg-purple-900/40 px-2 py-1 text-[10px] text-purple-800 dark:text-purple-200">
          <Bike size={11} /> Rider পথে আছে — delivery confirmation-এর অপেক্ষা…
        </span>
      </div>
    );
  }

  // Rider has joined but pharmacy hasn't handed over yet — only "Handed to rider".
  if (riderActive) {
    return (
      <div className="flex flex-wrap gap-1.5 border-t border-black/5 dark:border-white/5 bg-emerald-500/5 px-2 py-2">
        <button
          type="button"
          onClick={() =>
            onSend({
              body: "🤝 Medicine rider-কে hand over করা হয়েছে।",
              preset_key: ORDER_PRESETS.handed_over,
            })
          }
          className="inline-flex items-center gap-1.5 rounded-full bg-purple-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-purple-600"
        >
          <Bike size={12} /> 🤝 Rider-কে দিন
        </button>
        {issueRow}
      </div>
    );
  }

  // Call rider was sent but no rider has accepted yet → just a waiting pill.
  if (calledRider) {
    return (
      <div className="flex flex-wrap gap-1.5 border-t border-black/5 dark:border-white/5 bg-emerald-500/5 px-2 py-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 dark:bg-indigo-900/40 px-2 py-1 text-[10px] text-indigo-800 dark:text-indigo-200">
          <Bike size={11} /> ৫ km-এর মধ্যে rider notified — accept-এর অপেক্ষা…
        </span>
        {issueRow}
      </div>
    );
  }

  // After "Preparing" sent → only "Call rider".
  if (status === "preparing") {
    return (
      <div className="flex flex-wrap gap-1.5 border-t border-black/5 dark:border-white/5 bg-emerald-500/5 px-2 py-2">
        <button
          type="button"
          onClick={() =>
            onSend({
              body: "📞 আশেপাশের সব rider-কে offer পাঠানো হচ্ছে…",
              preset_key: ORDER_PRESETS.call_rider,
            })
          }
          className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-indigo-600"
        >
          <Bike size={12} /> 📞 Rider ডাকুন
        </button>
        {issueRow}
      </div>
    );
  }

  // After order_confirm → only "Preparing".
  if (status === "confirmed") {
    return (
      <div className="flex flex-wrap gap-1.5 border-t border-black/5 dark:border-white/5 bg-emerald-500/5 px-2 py-2">
        <button
          type="button"
          onClick={() =>
            onSend({
              body: "🟢 অর্ডার প্যাকিং চলছে — একটু অপেক্ষা করুন।",
              preset_key: ORDER_PRESETS.status_preparing,
            })
          }
          className="inline-flex items-center gap-1.5 rounded-full bg-amber-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-amber-600"
        >
          <Package size={12} /> 🟢 Packing শুরু
        </button>
        {issueRow}
      </div>
    );
  }

  // Default (no confirm yet) → Quote button. If there's an open customer
  // request, also offer "Modify items" so pharmacy can issue a partial-
  // fulfillment quote (e.g. "we have only 2 of 3 items in stock") instead
  // of being forced to either confirm-as-is or fully reject.
  const openRequest = state.hasOpenRequest
    ? [...scopedMessages].reverse().find(
        (m) => m.preset_key === ORDER_PRESETS.request,
      )
    : null;
  const openRequestItems =
    (openRequest?.payload as OrderPayload | undefined)?.items ?? null;
  const openRequestNote = (openRequest?.payload as OrderPayload | undefined)?.note ?? "";
  return (
    <>
      <div className="flex flex-wrap gap-1.5 border-t border-black/5 dark:border-white/5 bg-emerald-500/5 px-2 py-2">
        {openRequest && (
          <>
            <button
              type="button"
              onClick={() =>
                onSend({
                  body: `✅ অর্ডার confirm করেছি — মোট ${formatBDT(openRequest.payload?.total ?? 0)}, প্যাকিং শুরু করছি।`,
                  preset_key: ORDER_PRESETS.confirm,
                })
              }
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-600"
              title="Latest customer request confirm করুন"
            >
              <Check size={12} /> Confirm request
            </button>
            <button
              type="button"
              onClick={() => setReasonModal({ kind: "pharmacy_reject" })}
              className="inline-flex items-center gap-1.5 rounded-full bg-rose-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-rose-600"
              title="Latest customer request reject করুন"
            >
              <XCircle size={12} /> Reject
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => setComposer("quote")}
          className="inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-brand-600"
        >
          <Receipt size={12} /> 🧾 Quote
        </button>
        {openRequestItems && openRequestItems.length > 0 && (
          <button
            type="button"
            onClick={() => setComposer("modify")}
            className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-indigo-600"
            title="Customer request modify করে partial-fulfillment quote পাঠান"
          >
            ✏️ Items modify
          </button>
        )}
      </div>
      {(composer === "quote" || composer === "modify") && (
        <OrderComposer
          pharmacyId={pharmacyId}
          mode="quote"
          initialItems={composer === "modify" ? openRequestItems ?? undefined : undefined}
          initialNote={composer === "modify" ? openRequestNote : undefined}
          onClose={() => setComposer(null)}
          onSubmit={(payload, body) => {
            setComposer(null);
            onSend({ body, preset_key: ORDER_PRESETS.quote, payload });
          }}
        />
      )}
      <ReasonPromptModal
        open={reasonModal?.kind === "pharmacy_reject"}
        title="Order request reject করছেন?"
        placeholder="কারণ লিখুন (optional)"
        submitLabel="Reject"
        onCancel={() => setReasonModal(null)}
        onSubmit={(reason) => {
          setReasonModal(null);
          onSend({
            body: `❌ অর্ডার reject করা হয়েছে।${reason ? ` কারণ: ${reason}` : ""}`,
            preset_key: ORDER_PRESETS.reject,
          });
        }}
      />
    </>
  );
}

/* ---------- Pharmacy issue actions: Stock-out (cancel) + Delay (reason+ETA) ---------- */
function PharmacyIssueActions({
  onCancelStockOut,
  onDelay,
}: {
  onCancelStockOut: (itemNote: string, reason: string) => void;
  onDelay: (minutes: number, reason: string) => void;
}) {
  const [mode, setMode] = useState<null | "stockout" | "delay">(null);
  const [itemNote, setItemNote] = useState("");
  const [stockReason, setStockReason] = useState("");
  const [delayMinutes, setDelayMinutes] = useState("10");
  const [delayReason, setDelayReason] = useState("");

  if (mode === "stockout") {
    return (
      <div className="ml-auto flex w-full flex-col gap-1.5 rounded-xl border border-rose-300/60 bg-rose-50 px-2 py-2 dark:border-rose-500/30 dark:bg-rose-950/30">
        <p className="text-[10px] font-semibold text-rose-800 dark:text-rose-200">
          ❌ কোন item stock-এ নেই? (order auto-cancel হবে)
        </p>
        <input
          value={itemNote}
          onChange={(e) => setItemNote(e.target.value)}
          placeholder="যেমন: Napa 500mg"
          className="rounded-md border border-rose-300/40 bg-white px-2 py-1 text-[11px] dark:bg-white/5 dark:text-white"
          autoFocus
        />
        <input
          value={stockReason}
          onChange={(e) => setStockReason(e.target.value)}
          placeholder="কেন? (supplier-এ নেই / কাল আসবে / discontinued…)"
          className="rounded-md border border-rose-300/40 bg-white px-2 py-1 text-[11px] dark:bg-white/5 dark:text-white"
        />
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => {
              onCancelStockOut(itemNote.trim(), stockReason.trim());
              setMode(null); setItemNote(""); setStockReason("");
            }}
            className="rounded-full bg-rose-500 px-2.5 py-0.5 text-[10px] font-semibold text-white hover:bg-rose-600"
          >
            Confirm cancel
          </button>
          <button
            type="button"
            onClick={() => { setMode(null); setItemNote(""); setStockReason(""); }}
            className="rounded-full bg-black/10 px-2.5 py-0.5 text-[10px] dark:bg-white/10 dark:text-white"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  if (mode === "delay") {
    return (
      <div className="ml-auto flex w-full flex-col gap-1.5 rounded-xl border border-amber-300/60 bg-amber-50 px-2 py-2 dark:border-amber-500/30 dark:bg-amber-950/30">
        <p className="text-[10px] font-semibold text-amber-800 dark:text-amber-200">
          ⏱️ কত মিনিট delay হবে আর কেন?
        </p>
        <div className="flex gap-1.5">
          <input
            type="number"
            min="1"
            value={delayMinutes}
            onChange={(e) => setDelayMinutes(e.target.value)}
            placeholder="মিনিট"
            className="w-16 rounded-md border border-amber-300/40 bg-white px-2 py-1 text-[11px] dark:bg-white/5"
          />
          <input
            value={delayReason}
            onChange={(e) => setDelayReason(e.target.value)}
            placeholder="কারণ (যেমন: courier delay)"
            className="flex-1 rounded-md border border-amber-300/40 bg-white px-2 py-1 text-[11px] dark:bg-white/5"
            autoFocus
          />
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => {
              const mins = Math.max(1, Math.round(Number(delayMinutes) || 0));
              onDelay(mins, delayReason.trim());
              setMode(null);
              setDelayReason("");
            }}
            className="rounded-full bg-amber-500 px-2.5 py-0.5 text-[10px] font-semibold text-white hover:bg-amber-600"
          >
            Send delay note
          </button>
          <button
            type="button"
            onClick={() => { setMode(null); setDelayReason(""); }}
            className="rounded-full bg-black/10 px-2.5 py-0.5 text-[10px] dark:bg-white/10"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ml-auto flex flex-wrap gap-1.5">
      <button
        type="button"
        onClick={() => setMode("delay")}
        className="inline-flex items-center gap-1 rounded-full border border-amber-400/50 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-200"
        title="Delay notice পাঠান"
      >
        ⏱️ Delay
      </button>
      <button
        type="button"
        onClick={() => setMode("stockout")}
        className="inline-flex items-center gap-1 rounded-full border border-rose-400/50 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-800 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-200"
        title="Stock নেই → order cancel"
      >
        ❌ Stock out
      </button>
    </div>
  );
}

function OrderEventCard({
  msg,
  mine,
  myRole,
  pharmacyId,
  allMessages,
  onAction,
}: {
  msg: ConversationMessage;
  mine: boolean;
  myRole: "customer" | "pharmacy" | "rider";
  pharmacyId: string;
  allMessages: ConversationMessage[];
  onAction: SendFn;
}) {
  // Inline reject prompt (replaces window.prompt for embedded browsers).
  const [rejectOpen, setRejectOpen] = useState(false);
  const align = mine ? "ml-auto" : "";
  const isRiderJoin = msg.preset_key === ORDER_PRESETS.rider_joined;
  const isRiderLeft = msg.preset_key === "rider_left";
  const isDeliveryComplete = msg.preset_key === ORDER_PRESETS.delivery_complete;
  const tone =
    msg.preset_key === ORDER_PRESETS.reject
      ? "border-rose-400/50 bg-rose-50 dark:bg-rose-950/30"
      : msg.preset_key === ORDER_PRESETS.delay
        ? "border-amber-400/60 bg-amber-50 dark:bg-amber-950/30"
        : isRiderJoin
        ? "mx-auto border-2 border-sky-400/70 bg-gradient-to-r from-sky-50 to-cyan-50 dark:from-sky-950/40 dark:to-cyan-950/40 shadow-md shadow-sky-500/20"
        : isRiderLeft
          ? "mx-auto border-2 border-slate-400/60 bg-gradient-to-r from-slate-50 to-zinc-50 dark:from-slate-900/60 dark:to-zinc-900/60"
          : isDeliveryComplete || msg.preset_key === ORDER_PRESETS.status_delivered
            ? "border-emerald-400/50 bg-emerald-50 dark:bg-emerald-950/30"
            : "border-brand-400/50 bg-brand-50 dark:bg-brand-950/30";
  const headerAccent =
    msg.preset_key === ORDER_PRESETS.reject
      ? "text-rose-700 dark:text-rose-200"
      : msg.preset_key === ORDER_PRESETS.delay
        ? "text-amber-700 dark:text-amber-200"
        : isRiderJoin
        ? "text-sky-700 dark:text-sky-200"
        : isRiderLeft
          ? "text-slate-700 dark:text-slate-200"
          : isDeliveryComplete || msg.preset_key === ORDER_PRESETS.status_delivered
            ? "text-emerald-700 dark:text-emerald-200"
            : "text-brand-700 dark:text-brand-200";

  // Order request from customer → pharmacy sees Confirm/Reject buttons
  // Pharmacy quote → customer sees Confirm/Reject buttons (mirror)
  const isRequest = msg.preset_key === ORDER_PRESETS.request;
  const isQuote = msg.preset_key === ORDER_PRESETS.quote;
  if (isRequest || isQuote) {
    // AI prescription requests are already dual-confirmed — never show the
    // redundant "Confirm request / Reject" buttons for them.
    const isAiOrder =
      isRequest &&
      (msg.payload as unknown as { source?: string } | null)?.source === "ai_prescription";
    const responded = isAiOrder || allMessages.some(
      (x) =>
        new Date(x.created_at ?? 0).getTime() > new Date(msg.created_at ?? 0).getTime() &&
        (x.preset_key === ORDER_PRESETS.confirm || x.preset_key === ORDER_PRESETS.reject),
    );
    const decideRole = isRequest ? "pharmacy" : "customer";
    const headerLabel = isRequest
      ? `অর্ডার request${msg.payload?.total != null ? ` — মোট ${formatBDT(msg.payload.total)}` : ""}`
      : `Pharmacy quote${msg.payload?.total != null ? ` — মোট ${formatBDT(msg.payload.total)}` : ""}`;
    const headerIcon = isRequest ? <Package size={13} /> : <Receipt size={13} />;
    return (
      <div className={`${align} w-[min(320px,90%)] rounded-2xl border ${tone} p-3 text-[12px] text-slate-900 dark:text-slate-50`}>
        <div className={`mb-2 flex items-center gap-1.5 text-[13px] font-extrabold ${headerAccent}`}>
          {headerIcon} {headerLabel}
        </div>
        {msg.payload && msg.payload.items?.length ? (
          <ItemizedOrderTable payload={msg.payload} />
        ) : (
          <p className="whitespace-pre-line text-slate-800 dark:text-slate-100">{msg.body}</p>
        )}
        {msg.attachment_url && (
          <a
            href={msg.attachment_url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block rounded-xl ring-1 ring-amber-300/60 overflow-hidden"
            title="প্রেসক্রিপশন খুলুন"
          >
            <div className="flex items-center gap-1.5 bg-amber-100 dark:bg-amber-900/40 px-2 py-1 text-[10px] font-bold text-amber-800 dark:text-amber-200">
              📋 প্রেসক্রিপশন সংযুক্ত
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={msg.attachment_url}
              alt="prescription"
              className="max-h-44 w-full object-cover"
            />
          </a>
        )}
        {msg.payload?.note && (
          <p className="mt-2 rounded-lg bg-amber-50 dark:bg-black ring-1 ring-amber-300/60 dark:ring-yellow-400/40 px-2 py-1.5 text-[11px] italic text-amber-900 dark:text-yellow-300">
            📝 {msg.payload.note}
          </p>
        )}
        {!responded && myRole === decideRole && (
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() =>
                onAction({
                  body: isRequest
                    ? `✅ অর্ডার confirm করেছি — মোট ${formatBDT(msg.payload?.total ?? 0)}, প্যাকিং শুরু করছি।`
                    : `✅ Quote accept করেছি — মোট ${formatBDT(msg.payload?.total ?? 0)}, proceed করুন।`,
                  preset_key: ORDER_PRESETS.confirm,
                })
              }
              className="inline-flex items-center gap-1 rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-600"
            >
              <Check size={11} /> {isRequest ? "Confirm" : "Quote accept"}
            </button>
            <button
              type="button"
              onClick={() => setRejectOpen(true)}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-rose-600"
            >
              <XCircle size={11} /> Reject
            </button>
            <ReasonPromptModal
              open={rejectOpen}
              title={`${isRequest ? "Order request" : "Quote"} reject করছেন?`}
              placeholder="কারণ লিখুন (optional)"
              submitLabel="Reject"
              onCancel={() => setRejectOpen(false)}
              onSubmit={(reason) => {
                setRejectOpen(false);
                onAction({
                  body: `❌ ${isRequest ? "Order" : "Quote"} reject করা হয়েছে।${reason ? ` কারণ: ${reason}` : ""}`,
                  preset_key: ORDER_PRESETS.reject,
                });
              }}
            />
          </div>
        )}
        {responded && (
          <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-black ring-1 ring-transparent dark:ring-yellow-400/40 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:text-yellow-300">
            ✓ এই {isRequest ? "request" : "quote"}-এ reply হয়েছে।
          </p>
        )}
      </div>
    );
  }

  // Confirm / Reject / status / rating-submitted bubbles
  let icon = <Package size={13} />;
  let label = "Order update";
  if (msg.preset_key === ORDER_PRESETS.confirm) { icon = <Check size={13} />; label = "অর্ডার confirm হয়েছে"; }
  if (msg.preset_key === ORDER_PRESETS.reject) { icon = <XCircle size={13} />; label = "অর্ডার বাতিল হয়েছে"; }
  if (msg.preset_key === ORDER_PRESETS.status_preparing) { icon = <Package size={13} />; label = "অর্ডার প্যাকিং চলছে"; }
  if (msg.preset_key === ORDER_PRESETS.delay) { icon = <Package size={13} />; label = "⏱️ Delay notice"; }
  if (msg.preset_key === ORDER_PRESETS.status_on_the_way) { icon = <Bike size={13} />; label = "Rider পথে আছে"; }
  if (msg.preset_key === ORDER_PRESETS.status_delivered) { icon = <CheckCircle2 size={13} />; label = "Delivery সম্পন্ন"; }
  if (msg.preset_key === ORDER_PRESETS.rating_submitted) { icon = <Star size={13} />; label = "Rating পাঠানো হয়েছে"; }
  if (msg.preset_key === ORDER_PRESETS.call_rider) { icon = <Bike size={13} />; label = "Rider খোঁজা হচ্ছে"; }
  if (msg.preset_key === ORDER_PRESETS.rider_joined) { icon = <Bike size={13} />; label = "🛵 Rider chat-এ যুক্ত হয়েছে"; }
  if (msg.preset_key === "rider_left") { icon = <Bike size={13} />; label = "🛵 Rider chat থেকে বের হয়েছে"; }
  if (msg.preset_key === ORDER_PRESETS.handed_over) { icon = <Bike size={13} />; label = "Rider-কে medicine দেওয়া হয়েছে"; }
  if (msg.preset_key === ORDER_PRESETS.delivery_complete) { icon = <CheckCircle2 size={13} />; label = "Delivery complete"; }

  // Delivered → customer rating prompt (only if not yet rated). Both the
  // pharmacy's `status_delivered` AND the rider's `delivery_complete`
  // preset unlock the rating UI on the customer side.
  const isDelivered =
    msg.preset_key === ORDER_PRESETS.status_delivered ||
    msg.preset_key === ORDER_PRESETS.delivery_complete;
  const ratedAfter = allMessages.some(
    (x) =>
      x.preset_key === ORDER_PRESETS.rating_submitted &&
      new Date(x.created_at ?? 0).getTime() >= new Date(msg.created_at ?? 0).getTime(),
  );
  return (
    <div className={`${align} max-w-[88%] rounded-2xl border ${tone} p-3 text-[12px] text-slate-900 dark:text-slate-50`}>
      <div className={`mb-1 flex items-center gap-1.5 text-[13px] font-extrabold ${headerAccent}`}>
        {icon} {label}
      </div>
      {shouldShowOrderEventBody(msg) && (
        <p className="whitespace-pre-line text-slate-800 dark:text-slate-50">{normalizeOrderEventBody(msg.body)}</p>
      )}
      {isDelivered && myRole === "customer" && !ratedAfter && (
        <RatingPrompt pharmacyId={pharmacyId} onAction={onAction} />
      )}
    </div>
  );
}

function shouldShowOrderEventBody(msg: ConversationMessage): boolean {
  return [ORDER_PRESETS.reject, ORDER_PRESETS.delay].includes(msg.preset_key as never);
}

function normalizeOrderEventBody(body: string): string {
  return body
    .replace(/Order packaging cholche — ektu wait korun\./gi, "অর্ডার প্যাকিং চলছে — একটু অপেক্ষা করুন।")
    .replace(/Timeout — pharmacy did not respond within 5 min\.?/gi, "সময় শেষ — ফার্মেসি ৫ মিনিটের মধ্যে উত্তর দেয়নি।")
    .replace(/Test stock-check close/gi, "স্টক যাচাই বন্ধ করা হয়েছে")
    .replace(/Stock check close/gi, "স্টক যাচাই বন্ধ করা হয়েছে")
    .replace(/800m-er moddhe sob rider-ke offer pathano hocche/gi, "আশেপাশের সব rider-কে offer পাঠানো হচ্ছে")
    .replace(/Order confirm/g, "অর্ডার confirm")
    .replace(/Order cancel/g, "অর্ডার বাতিল")
    .replace(/order cancel/g, "অর্ডার বাতিল")
    .replace(/Note:/g, "নোট:")
    .replace(/_Note:_/g, "_নোট:_");
}

function StarRow({
  value,
  onPick,
  disabled,
}: {
  value: number;
  onPick: (n: number) => void;
  disabled: boolean;
}) {
  const [hover, setHover] = useState(0);
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={disabled}
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          onClick={() => onPick(n)}
          className="p-0.5 disabled:opacity-50"
          aria-label={`Rate ${n} star${n > 1 ? "s" : ""}`}
        >
          <Star
            size={18}
            className={
              n <= (hover || value)
                ? "fill-amber-400 text-amber-400"
                : "text-black/20 dark:text-white/30"
            }
          />
        </button>
      ))}
    </div>
  );
}

function RatingPrompt({ pharmacyId, onAction }: { pharmacyId: string; onAction: SendFn }) {
  const [stars, setStars] = useState(0);
  const [riderStars, setRiderStars] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (busy || done || stars < 1) return;
    setBusy(true);
    try {
      // Delivery is rider-only, so a delivered order always has a rider to rate.
      await conversationsApi.ratePharmacy(pharmacyId, stars, riderStars || undefined);
      const riderBit = riderStars ? ` · rider ${riderStars}/5` : "";
      onAction({
        body: `⭐ Pharmacy ${stars}/5${riderBit} rating দিয়েছেন — ধন্যবাদ!`,
        preset_key: ORDER_PRESETS.rating_submitted,
      });
      setDone(true);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Rating failed");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <p className="mt-2 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
        ⭐ Pharmacy {stars}/5{riderStars ? ` · Rider ${riderStars}/5` : ""} — Thanks for rating!
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-2 rounded-xl bg-white p-2 ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10">
      <div>
        <p className="mb-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200">এই pharmacy কে rating দিন:</p>
        <StarRow value={stars} onPick={setStars} disabled={busy} />
      </div>
      <div>
        <p className="mb-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200">Rider কে rating দিন (optional):</p>
        <StarRow value={riderStars} onPick={setRiderStars} disabled={busy} />
      </div>
      <button
        type="button"
        disabled={busy || stars < 1}
        onClick={() => void submit()}
        className="w-full rounded-lg bg-brand-500 px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "পাঠানো হচ্ছে…" : "Rating পাঠান"}
      </button>
    </div>
  );
}

function ItemizedOrderTable({ payload }: { payload: OrderPayload }) {
  // Be defensive: payloads coming from older clients / external scripts
  // may use `price` instead of `unit_price`, and may omit `total`.
  const unitOf = (it: OrderPayload["items"][number]) => {
    const raw = (it as { unit_price?: number; price?: number }).unit_price
      ?? (it as { unit_price?: number; price?: number }).price
      ?? 0;
    return Number(raw) || 0;
  };
  const computedSubtotal = payload.items.reduce(
    (s, it) => s + unitOf(it) * (Number(it.qty) || 0),
    0,
  );
  const subtotal = Number(payload.subtotal) || computedSubtotal;
  const deliveryFee = Number(payload.delivery_fee) || 0;
  const total = Number(payload.total) || subtotal + deliveryFee;
  return (
    <div className="rounded-xl bg-white dark:bg-black/40 p-2 text-slate-900 dark:text-slate-100 ring-1 ring-black/5 dark:ring-white/10">
      <ul className="divide-y divide-black/10 dark:divide-white/10">
        {payload.items.map((it, i) => {
          const unit = unitOf(it);
          return (
            <li key={i} className="flex items-center gap-2 py-1.5">
              <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-black/5 dark:bg-white/10">
                {it.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={resolveMediaUrl(it.image_url)} alt={it.name} className="h-full w-full object-cover" />
                ) : (
                  <Package size={12} className="opacity-60" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold leading-tight text-slate-900 dark:text-white">
                  {it.name}
                </p>
                <p className="text-[10px] text-slate-600 dark:text-slate-300">
                  {formatBDT(unit)} × {it.qty}
                </p>
              </div>
              <p className="shrink-0 text-[12px] font-bold tabular-nums text-slate-900 dark:text-white">
                {formatBDT(unit * (Number(it.qty) || 0))}
              </p>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 space-y-0.5 border-t border-black/10 dark:border-white/15 pt-2 text-[11px]">
        <div className="flex items-center justify-between text-slate-700 dark:text-slate-200">
          <span>ঔষধ</span>
          <span className="tabular-nums font-semibold">{formatBDT(subtotal)}</span>
        </div>
        {deliveryFee > 0 && (
          <div className="flex items-center justify-between text-slate-700 dark:text-slate-200">
            <span>ডেলিভারি</span>
            <span className="tabular-nums font-semibold">{formatBDT(deliveryFee)}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-[14px] font-extrabold text-emerald-700 dark:text-emerald-300">
          <span>মোট</span>
          <span className="tabular-nums">{formatBDT(total)}</span>
        </div>
      </div>
    </div>
  );
}

/* ---------- AI-brokered handshake / dual-confirm card ---------- */

function HandshakeCard({
  msg,
  myRole,
  allMessages,
  onAction,
}: {
  msg: ConversationMessage;
  myRole: "customer" | "pharmacy" | "rider";
  allMessages: ConversationMessage[];
  onAction: SendFn;
}) {
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectText, setRejectText] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const payload = (msg.payload || {}) as unknown as {
    handshake_id?: string;
    items?: Array<{ medicine_id?: string; name: string; qty: number; unit_price: number }>;
    subtotal?: number;
    delivery_fee?: number;
    total?: number;
    prescription_url?: string | null;
    pharmacy_id?: string;
    pharmacy_name?: string;
    note?: string | null;
    delivery_address?: string | null;
    delivery_lat?: number | null;
    delivery_lng?: number | null;
    status?: string;
    split_part?: number;
    split_total?: number;
    pharmacy_reason?: string;
  };
  const handshakeId = payload.handshake_id || "";

  // Has this handshake already been resolved? (look for a later completed/rejected/cancelled event matching this handshake_id)
  const resolved = allMessages.some((x) => {
    if (!x.preset_key) return false;
    if (
      x.preset_key !== "ai_handshake_completed" &&
      x.preset_key !== "ai_handshake_rejected" &&
      x.preset_key !== "ai_handshake_cancelled"
    )
      return false;
    const p = (x.payload || {}) as unknown as { handshake_id?: string };
    return p.handshake_id === handshakeId && new Date(x.created_at ?? 0).getTime() > new Date(msg.created_at ?? 0).getTime();
  });

  // Has pharmacy already responded? (a later ai_customer_confirm_prompt or ai_handshake_rejected for same handshake)
  const pharmacyResponded = allMessages.some((x) => {
    if (!x.preset_key) return false;
    if (x.preset_key !== "ai_customer_confirm_prompt" && x.preset_key !== "ai_handshake_rejected")
      return false;
    const p = (x.payload || {}) as unknown as { handshake_id?: string };
    return p.handshake_id === handshakeId && new Date(x.created_at ?? 0).getTime() > new Date(msg.created_at ?? 0).getTime();
  });

  // ---------- Pill: completed ----------
  if (msg.preset_key === "ai_handshake_completed") {
    return (
      <div className="mx-auto max-w-[88%] rounded-full bg-emerald-500/15 px-3 py-1 text-center text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
        ✅ অর্ডার হয়েছে — ফার্মেসি এখন প্যাকিং করবে।
      </div>
    );
  }

  // ---------- Pill: rejected ----------
  if (msg.preset_key === "ai_handshake_rejected") {
    return (
      <div className="mx-auto max-w-[88%] rounded-2xl border border-rose-300/50 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-center text-[11px] text-rose-700 dark:text-rose-200">
        <p className="font-semibold mb-0.5">❌ ফার্মেসি stock reject করেছে</p>
        {payload.pharmacy_reason && <p className="opacity-80">{normalizeOrderEventBody(payload.pharmacy_reason)}</p>}
        {!payload.pharmacy_reason && <p className="opacity-80">{normalizeOrderEventBody(msg.body)}</p>}
      </div>
    );
  }

  // ---------- Pill: cancelled by customer ----------
  if (msg.preset_key === "ai_handshake_cancelled") {
    const _p = (msg.payload || {}) as { timeout?: boolean };
    const isTimeout = Boolean(_p.timeout);
    const label = normalizeOrderEventBody(msg.body) || "🚫 Customer অর্ডার বাতিল করেছে";
    return (
      <div className={`mx-auto max-w-[88%] rounded-2xl px-3 py-1.5 text-center text-[11px] font-semibold ${
        isTimeout
          ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
          : "bg-slate-500/15 text-slate-600 dark:text-slate-300"
      }`}>
        {label}
      </div>
    );
  }

  // ---------- Card: ai_handshake (initial stock-check request from medi AI) ----------
  if (msg.preset_key === "ai_handshake") {
    const isPharmacy = myRole === "pharmacy";
    const cardStatus = String(payload.status ?? "");
    const cardClosed = ["cancelled", "timeout", "rejected", "confirmed"].includes(cardStatus);
    const acceptHandshake = () => {
      if (busy || pharmacyResponded || cardClosed || !handshakeId) return;
      setBusy(true);
      onAction({
        body: "✅ সব ওষুধ available। অর্ডার confirm করতে পারেন।",
        preset_key: "pharmacy_handshake_ok",
        payload: { handshake_id: handshakeId } as unknown as OrderPayload,
      });
      setTimeout(() => setBusy(false), 600);
    };
    const rejectHandshake = () => {
      if (busy || pharmacyResponded || cardClosed || !handshakeId) return;
      setBusy(true);
      onAction({
        body: rejectText.trim() ? `❌ Stock নেই — ${rejectText.trim()}` : "❌ এই ওষুধগুলোর stock নেই।",
        preset_key: "pharmacy_handshake_reject",
        payload: ({ handshake_id: handshakeId, pharmacy_reason: rejectText.trim() || "Stock নেই" } as unknown) as OrderPayload,
      });
      setRejectOpen(false);
      setTimeout(() => setBusy(false), 600);
    };

    return (
      <div className="mx-auto w-[min(340px,92%)] rounded-2xl border-2 border-violet-400/60 bg-gradient-to-br from-violet-50 to-fuchsia-50 dark:from-violet-950/40 dark:to-fuchsia-950/30 p-3 text-[12px] text-slate-900 dark:text-slate-50 shadow-md shadow-violet-500/15">
        <div className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold text-violet-700 dark:text-violet-200">
          <Bot size={14} /> medi AI — স্টক যাচাই request
        </div>
        {payload.items && payload.items.length > 0 && (
          <ul className="mb-2 space-y-1 rounded-xl bg-white/70 dark:bg-white/5 p-2">
            {payload.items.map((it, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {it.name} <span className="opacity-60">×{it.qty}</span>
                </span>
                <span className="tabular-nums font-semibold">{formatBDT(it.unit_price * it.qty)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mb-2 flex items-center justify-between rounded-lg bg-violet-500/10 px-2 py-1 text-[13px] font-extrabold text-violet-800 dark:text-violet-100">
          <span>মোট</span>
          <span className="tabular-nums">{formatBDT(payload.total ?? 0)}</span>
        </div>
        {payload.prescription_url && (
          <a
            href={payload.prescription_url}
            target="_blank"
            rel="noreferrer"
            className="mb-2 block text-center text-[11px] font-semibold text-violet-700 dark:text-violet-300 underline"
          >
            🖼 প্রেসক্রিপশন দেখুন
          </a>
        )}

        {/* Pharmacy actions */}
        {isPharmacy && !pharmacyResponded && !cardClosed && !rejectOpen && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setRejectOpen(true)}
              disabled={busy}
              className="rounded-full bg-rose-500/10 px-3 py-1.5 text-[12px] font-semibold text-rose-700 dark:text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
            >
              ❌ Reject
            </button>
            <button
              onClick={acceptHandshake}
              disabled={busy}
              className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-600 px-4 py-1.5 text-[12px] font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <Check size={12} /> Accept — স্টক আছে
            </button>
          </div>
        )}
        {isPharmacy && rejectOpen && (
          <div className="space-y-2">
            <textarea
              value={rejectText}
              onChange={(e) => setRejectText(e.target.value)}
              placeholder="কেন reject করছেন? (optional)"
              className="w-full rounded-xl border border-rose-300/50 bg-white dark:bg-white/5 px-2 py-1.5 text-[12px]"
              rows={2}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => setRejectOpen(false)}
                className="rounded-full bg-black/5 dark:bg-white/10 px-3 py-1.5 text-[12px]"
              >
                বাতিল
              </button>
              <button
                onClick={rejectHandshake}
                disabled={busy}
                className="ml-auto rounded-full bg-rose-600 px-4 py-1.5 text-[12px] font-bold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                Reject confirm
              </button>
            </div>
          </div>
        )}
        {isPharmacy && pharmacyResponded && (
          <p className="text-center text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
            ✅ উত্তর পাঠানো হয়েছে
          </p>
        )}
        {!isPharmacy && (
          <p className="text-center text-[11px] text-violet-700 dark:text-violet-300">
            ফার্মেসি স্টক যাচাই করছে — উত্তর আসা পর্যন্ত অপেক্ষা করুন।
          </p>
        )}
      </div>
    );
  }

  // ---------- Card: ai_customer_confirm_prompt (pharmacy OK → customer can confirm) ----------
  if (msg.preset_key === "ai_customer_confirm_prompt") {
    const isCustomer = myRole === "customer";
    const _cpStatus = (payload.status ?? "") as string;
    // "confirmed" is a SUCCESS terminal state — it must never fall into the
    // cancelled bucket or the customer sees "🚫 বাতিল হয়েছে" right after a
    // successful Final Confirm.
    const confirmedNow = _cpStatus === "confirmed";
    const cancelled = _cpStatus === "cancelled" || _cpStatus === "timeout";
    const finalConfirm = async () => {
      if (busy || resolved || !handshakeId) return;
      if (!payload.prescription_url || !payload.pharmacy_id || !payload.items?.length) {
        setConfirmError("অর্ডারের তথ্য অসম্পূর্ণ — Smart Prescription window থেকে confirm করুন।");
        return;
      }
      setBusy(true);
      setConfirmError(null);
      try {
        const { api } = await import("@/lib/api");
        await api<unknown>("/api/ai/prescription-dispatch", {
          method: "POST",
          body: JSON.stringify({
            prescription_url: payload.prescription_url,
            plans: [
              {
                pharmacy_id: payload.pharmacy_id,
                items: payload.items.map((it) => ({
                  medicine_id: it.medicine_id,
                  name: it.name,
                  qty: it.qty,
                  unit_price: it.unit_price,
                })),
                subtotal: payload.subtotal ?? 0,
                delivery_fee: payload.delivery_fee ?? 0,
                total: payload.total ?? 0,
              },
            ],
            handshake_ids: [handshakeId],
            note: payload.note ?? null,
            delivery_address: payload.delivery_address ?? null,
            delivery_lat: payload.delivery_lat ?? null,
            delivery_lng: payload.delivery_lng ?? null,
          }),
        });
        // success — server posts ai_handshake_completed; refresh loop will pick it up
      } catch (e) {
        setConfirmError(e instanceof Error ? e.message : "Confirm করা যায়নি");
      } finally {
        setBusy(false);
      }
    };
    const cancelOrder = () => {
      if (busy || resolved || !handshakeId) return;
      setBusy(true);
      onAction({
        body: "🚫 অর্ডার বাতিল করেছি।",
        preset_key: "customer_handshake_cancel",
        payload: ({ handshake_id: handshakeId } as unknown) as OrderPayload,
      });
      setTimeout(() => setBusy(false), 600);
    };

    return (
      <div className="mx-auto w-[min(340px,92%)] rounded-2xl border-2 border-emerald-400/60 bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/40 dark:to-teal-950/30 p-3 text-[12px] text-slate-900 dark:text-slate-50 shadow-md shadow-emerald-500/15">
        <div className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold text-emerald-700 dark:text-emerald-200">
          <CheckCircle2 size={14} /> medi AI — final order confirm
        </div>
        <p className="mb-2 text-[12px] text-slate-700 dark:text-slate-200">
          ফার্মেসি stock confirm করেছে। Confirm করলে 1 Smart Prescription credit কাটা হবে।
        </p>
        {payload.items && payload.items.length > 0 && (
          <ul className="mb-2 space-y-1 rounded-xl bg-white/70 dark:bg-white/5 p-2">
            {payload.items.map((it, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {it.name} <span className="opacity-60">×{it.qty}</span>
                </span>
                <span className="tabular-nums font-semibold">{formatBDT(it.unit_price * it.qty)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mb-2 flex items-center justify-between rounded-lg bg-emerald-500/10 px-2 py-1 text-[13px] font-extrabold text-emerald-800 dark:text-emerald-100">
          <span>মোট</span>
          <span className="tabular-nums">{formatBDT(payload.total ?? 0)}</span>
        </div>
        {confirmError && (
          <p className="mb-2 rounded-lg bg-rose-500/10 px-2 py-1 text-[11px] text-rose-700 dark:text-rose-200">
            {confirmError}
          </p>
        )}
        {isCustomer && !resolved && !cancelled && !confirmedNow && (
          <div className="flex flex-col gap-2">
            <button
              onClick={finalConfirm}
              disabled={busy}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-full bg-emerald-600 px-4 py-2 text-[13px] font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <CheckCircle2 size={14} /> Final Confirm — অর্ডার পাঠান
            </button>
            <button
              onClick={cancelOrder}
              disabled={busy}
              className="w-full inline-flex items-center justify-center gap-1 rounded-full bg-rose-500/10 px-4 py-1.5 text-[12px] font-semibold text-rose-700 dark:text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
            >
              🚫 অর্ডার বাতিল
            </button>
          </div>
        )}
        {isCustomer && (resolved || cancelled || confirmedNow) && (
          <p className="text-center text-[12px] font-bold text-emerald-700 dark:text-emerald-300">
            {cancelled ? "🚫 বাতিল হয়েছে" : "✅ অর্ডার confirm হয়েছে"}
          </p>
        )}
        {!isCustomer && (
          <p className="text-center text-[11px] text-emerald-700 dark:text-emerald-300">
            Customer-এর Final Confirm-এর অপেক্ষায়…
          </p>
        )}
      </div>
    );
  }

  return null;
}

/* ---------- AI proactive add-on suggestion card ---------- */

function AddonCard({
  msg,
  myRole,
  allMessages,
  onAction,
}: {
  msg: ConversationMessage;
  myRole: "customer" | "pharmacy" | "rider";
  allMessages: ConversationMessage[];
  onAction: SendFn;
}) {
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<
    Array<{
      medicine_id: string;
      name: string;
      image_url?: string | null;
      price: number;
      category?: string | null;
      prescription_required?: boolean;
      stock?: number;
    }>
  >([]);
  const [error, setError] = useState<string | null>(null);

  const payload = (msg.payload || {}) as unknown as {
    pharmacy_question?: string;
    pharmacy_id?: string;
    conversation_id?: string;
    items?: typeof items;
  };

  // ai_addon_suggestion message — already has items in payload, just render
  if (msg.preset_key === "ai_addon_suggestion") {
    const suggested = payload.items || [];
    return (
      <div className="mx-auto w-[min(360px,94%)] rounded-2xl border-2 border-amber-400/60 bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/40 dark:to-orange-950/30 p-3 text-[12px] text-slate-900 dark:text-slate-50 shadow-md shadow-amber-500/15">
        <div className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold text-amber-700 dark:text-amber-200">
          <Bot size={14} /> medi AI suggests
        </div>
        {suggested.length === 0 ? (
          <p className="text-center text-[11px] opacity-70">No items available.</p>
        ) : (
          <ul className="space-y-1.5">
            {suggested.map((it) => (
              <li
                key={it.medicine_id}
                className="flex items-center gap-2 rounded-xl bg-white/70 dark:bg-white/5 p-2"
              >
                {it.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={resolveMediaUrl(it.image_url)}
                    alt={it.name}
                    className="h-10 w-10 rounded-lg object-cover"
                  />
                ) : (
                  <div className="grid h-10 w-10 place-items-center rounded-lg bg-amber-500/20 text-amber-700">
                    <Package size={16} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-semibold">{it.name}</p>
                  {it.category && (
                    <p className="truncate text-[10px] opacity-60">{it.category}</p>
                  )}
                </div>
                <span className="tabular-nums text-[12px] font-bold text-amber-700 dark:text-amber-300">
                  {formatBDT(it.price)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-center text-[10px] opacity-60">
          Add to order করতে pharmacy-কে বলুন বা storefront-এ যান।
        </p>
      </div>
    );
  }

  // ai_addon_dismissed pill
  if (msg.preset_key === "ai_addon_dismissed") {
    return (
      <div className="mx-auto max-w-[88%] rounded-full bg-slate-500/10 px-3 py-1 text-center text-[11px] text-slate-600 dark:text-slate-300">
        {msg.body || "Customer declined add-on suggestion."}
      </div>
    );
  }

  // ai_addon_prompt — main interactive card
  const isCustomer = myRole === "customer";
  // Has this prompt already been resolved?
  const resolved = allMessages.some(
    (x) =>
      (x.preset_key === "ai_addon_suggestion" || x.preset_key === "ai_addon_dismissed") &&
      new Date(x.created_at ?? 0).getTime() > new Date(msg.created_at ?? 0).getTime(),
  );

  const fetchSuggestions = async () => {
    if (busy || resolved) return;
    setBusy(true);
    setError(null);
    try {
      const { api } = await import("@/lib/api");
      const res = await api<{ ok: boolean; items: typeof items }>("/api/ai/addon-suggest", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: payload.conversation_id || msg.conversation_id,
        }),
      });
      setItems(res.items || []);
      // Post the suggestion card as a system message so both sides see it
      onAction({
        body: `🛍 medi AI suggestion: ${(res.items || []).length} items from pharmacy's catalog`,
        preset_key: "ai_addon_suggestion",
        payload: ({ items: res.items, pharmacy_id: payload.pharmacy_id } as unknown) as OrderPayload,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch suggestions");
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    if (busy || resolved) return;
    setBusy(true);
    onAction({
      body: "🙅 Customer ধন্যবাদ জানিয়েছে — আর কিছু লাগবে না।",
      preset_key: "ai_addon_dismissed",
      payload: ({} as unknown) as OrderPayload,
    });
    setTimeout(() => setBusy(false), 500);
  };

  return (
    <div className="mx-auto w-[min(340px,92%)] rounded-2xl border-2 border-amber-400/60 bg-gradient-to-br from-amber-50 to-yellow-50 dark:from-amber-950/40 dark:to-yellow-950/30 p-3 text-[12px] text-slate-900 dark:text-slate-50 shadow-md shadow-amber-500/15">
      <div className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold text-amber-700 dark:text-amber-200">
        <Bot size={14} /> medi AI — Add-on listener
      </div>
      {payload.pharmacy_question && (
        <p className="mb-2 rounded-lg bg-white/70 dark:bg-white/5 px-2 py-1 text-[11px] italic opacity-80">
          Pharmacy বলেছে: &ldquo;{payload.pharmacy_question}&rdquo;
        </p>
      )}
      <p className="mb-2 text-[12px]">{msg.body}</p>
      {error && (
        <p className="mb-2 rounded-lg bg-rose-500/10 px-2 py-1 text-[11px] text-rose-700 dark:text-rose-200">
          {error}
        </p>
      )}
      {items.length > 0 && (
        <ul className="mb-2 space-y-1 rounded-xl bg-white/70 dark:bg-white/5 p-2">
          {items.map((it) => (
            <li key={it.medicine_id} className="flex items-center justify-between gap-2">
              <span className="truncate">{it.name}</span>
              <span className="tabular-nums font-semibold">{formatBDT(it.price)}</span>
            </li>
          ))}
        </ul>
      )}
      {isCustomer && !resolved && (
        <div className="flex items-center gap-2">
          <button
            onClick={dismiss}
            disabled={busy}
            className="rounded-full bg-black/5 dark:bg-white/10 px-3 py-1.5 text-[12px] hover:bg-black/10 disabled:opacity-50"
          >
            না, ধন্যবাদ
          </button>
          <button
            onClick={fetchSuggestions}
            disabled={busy}
            className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-600 px-4 py-1.5 text-[12px] font-bold text-white hover:bg-amber-700 disabled:opacity-50"
          >
            <Package size={12} /> Suggest items
          </button>
        </div>
      )}
      {!isCustomer && (
        <p className="text-center text-[11px] text-amber-700 dark:text-amber-300">
          Customer-এর response-এর অপেক্ষায়…
        </p>
      )}
      {isCustomer && resolved && (
        <p className="text-center text-[11px] text-emerald-700 dark:text-emerald-300">
          ✅ Resolved
        </p>
      )}
    </div>
  );
}


/* ---------- Phase 4: Pre-packaging order modify window card ---------- */

type ModifyItem = {
  medicine_id: string;
  name: string;
  qty: number;
  unit_price: number;
  image_url?: string | null;
};

function ModifyWindowCard({
  msg,
  myRole,
  allMessages,
}: {
  msg: ConversationMessage;
  myRole: "customer" | "pharmacy" | "rider";
  allMessages: ConversationMessage[];
}) {
  const payload = (msg.payload || {}) as unknown as {
    order_id?: string;
    pharmacy_id?: string;
    items?: ModifyItem[];
    subtotal?: number;
    delivery_fee?: number;
    total?: number;
    added?: ModifyItem[];
    removed?: ModifyItem[];
    changed?: Array<{ medicine_id: string; name: string; old_qty: number; new_qty: number }>;
  };

  // Closed pill
  if (msg.preset_key === "ai_modify_window_closed") {
    return (
      <div className="mx-auto flex max-w-[88%] items-center justify-center gap-1.5 rounded-full bg-slate-500/10 px-3 py-1 text-center text-[11px] text-slate-600 dark:text-slate-300">
        <Lock size={11} /> {msg.body || "Modify window closed."}
      </div>
    );
  }

  // Summary of a completed modification
  if (msg.preset_key === "ai_order_modified") {
    const added = payload.added || [];
    const removed = payload.removed || [];
    const changed = payload.changed || [];
    return (
      <div className="mx-auto w-[min(340px,92%)] rounded-2xl border-2 border-sky-400/60 bg-gradient-to-br from-sky-50 to-blue-50 dark:from-sky-950/40 dark:to-blue-950/30 p-3 text-[12px] text-slate-900 dark:text-slate-50 shadow-md shadow-sky-500/15">
        <div className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold text-sky-700 dark:text-sky-200">
          <Edit3 size={14} /> Order modified
        </div>
        {changed.length > 0 && (
          <ul className="mb-1 space-y-0.5">
            {changed.map((c) => (
              <li key={c.medicine_id} className="flex items-center justify-between gap-2">
                <span className="truncate">{c.name}</span>
                <span className="tabular-nums text-[11px] opacity-80">
                  {c.old_qty} → <span className="font-bold">{c.new_qty}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {added.length > 0 && (
          <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
            + {added.map((x) => x.name).join(", ")}
          </p>
        )}
        {removed.length > 0 && (
          <p className="text-[11px] text-rose-700 dark:text-rose-300">
            − {removed.map((x) => x.name).join(", ")}
          </p>
        )}
        {typeof payload.total === "number" && (
          <p className="mt-2 border-t border-sky-500/20 pt-1.5 text-right text-[12px] font-bold">
            নতুন total: <span className="text-sky-700 dark:text-sky-300 tabular-nums">{formatBDT(payload.total)}</span>
          </p>
        )}
      </div>
    );
  }

  // ai_modify_window_open — interactive editor (customer only)
  const isCustomer = myRole === "customer";
  const initial = (payload.items || []).map((x) => ({ ...x, qty: Number(x.qty) || 1 }));
  const [items, setItems] = useState<ModifyItem[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Already resolved? If a later modify_window_closed or ai_order_modified exists, hide editor.
  const resolved = allMessages.some(
    (x) =>
      (x.preset_key === "ai_modify_window_closed" || x.preset_key === "ai_order_modified") &&
      new Date(x.created_at ?? 0).getTime() > new Date(msg.created_at ?? 0).getTime(),
  );

  const subtotal = items.reduce((s, x) => s + (Number(x.unit_price) || 0) * (Number(x.qty) || 0), 0);
  const total = subtotal + Number(payload.delivery_fee || 0);
  const dirty = (() => {
    if (items.length !== initial.length) return true;
    for (let i = 0; i < items.length; i++) {
      if (items[i].medicine_id !== initial[i].medicine_id) return true;
      if (items[i].qty !== initial[i].qty) return true;
    }
    return false;
  })();

  const setQty = (id: string, qty: number) => {
    if (qty < 1) {
      setItems((cur) => cur.filter((x) => x.medicine_id !== id));
    } else {
      setItems((cur) => cur.map((x) => (x.medicine_id === id ? { ...x, qty } : x)));
    }
  };

  const submit = async () => {
    if (!payload.order_id || items.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { api } = await import("@/lib/api");
      await api(`/api/customer/me/orders/${payload.order_id}/modify`, {
        method: "POST",
        body: JSON.stringify({
          items: items.map((x) => ({ medicine_id: x.medicine_id, qty: x.qty })),
        }),
      });
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to modify order");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-[min(360px,94%)] rounded-2xl border-2 border-sky-400/60 bg-gradient-to-br from-sky-50 to-cyan-50 dark:from-sky-950/40 dark:to-cyan-950/30 p-3 text-[12px] text-slate-900 dark:text-slate-50 shadow-md shadow-sky-500/15">
      <div className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold text-sky-700 dark:text-sky-200">
        <Edit3 size={14} /> অর্ডার modify window
      </div>
      <p className="mb-2 text-[11px] opacity-80">{msg.body}</p>

      {!isCustomer && (
        <p className="rounded-lg bg-white/70 dark:bg-white/5 px-2 py-1.5 text-center text-[11px]">
          Customer item/qty change করতে পারবে — packaging শুরু হলে close হবে।
        </p>
      )}

      {isCustomer && !resolved && !done && (
        <>
          <ul className="space-y-1.5 rounded-xl bg-white/70 dark:bg-white/5 p-2">
            {items.map((it) => (
              <li key={it.medicine_id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-semibold">{it.name}</p>
                  <p className="text-[10px] opacity-60 tabular-nums">
                    {formatBDT(it.unit_price)} × {it.qty}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setQty(it.medicine_id, it.qty - 1)}
                    disabled={busy}
                    className="grid h-7 w-7 place-items-center rounded-full bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-50"
                    aria-label="decrease"
                  >
                    <Minus size={12} />
                  </button>
                  <span className="w-6 text-center tabular-nums font-bold">{it.qty}</span>
                  <button
                    onClick={() => setQty(it.medicine_id, it.qty + 1)}
                    disabled={busy}
                    className="grid h-7 w-7 place-items-center rounded-full bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
                    aria-label="increase"
                  >
                    <Plus size={12} />
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-2 flex items-center justify-between text-[11px]">
            <span className="opacity-70">ঔষধ</span>
            <span className="tabular-nums font-semibold">{formatBDT(subtotal)}</span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="opacity-70">ডেলিভারি</span>
            <span className="tabular-nums">{formatBDT(payload.delivery_fee || 0)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between border-t border-sky-500/20 pt-1 text-[12px] font-bold">
            <span>মোট</span>
            <span className="tabular-nums text-sky-700 dark:text-sky-300">{formatBDT(total)}</span>
          </div>

          {error && (
            <p className="mt-2 rounded-lg bg-rose-500/10 px-2 py-1 text-[11px] text-rose-700 dark:text-rose-200">
              {error}
            </p>
          )}

          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={submit}
              disabled={busy || !dirty || items.length === 0}
              className="ml-auto inline-flex items-center gap-1 rounded-full bg-sky-600 px-4 py-1.5 text-[12px] font-bold text-white hover:bg-sky-700 disabled:opacity-50"
            >
              <CheckCircle2 size={12} /> {busy ? "Saving…" : "Change save করুন"}
            </button>
          </div>
        </>
      )}

      {isCustomer && (resolved || done) && (
        <p className="text-center text-[11px] text-emerald-700 dark:text-emerald-300">
          ✅ Update applied
        </p>
      )}
    </div>
  );
}


/* ---------- Phase 5: Rider expiry-date check card ---------- */

function RiderExpiryCheckCard({
  msg,
  myRole,
}: {
  msg: ConversationMessage;
  myRole: "customer" | "pharmacy" | "rider";
}) {
  const payload = (msg.payload || {}) as unknown as {
    order_id?: string;
    rider_id?: string;
    items?: string[];
  };
  const items = Array.isArray(payload.items) ? payload.items : [];
  const isRider = myRole === "rider";

  return (
    <div className="mx-auto w-[min(360px,94%)] rounded-2xl border-2 border-amber-400/60 bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/40 dark:to-orange-950/30 p-3 text-[12px] text-slate-900 dark:text-slate-50 shadow-md shadow-amber-500/15">
      <div className="mb-1 flex items-center gap-1.5 text-[13px] font-extrabold text-amber-700 dark:text-amber-200">
        <Bot size={14} /> medi AI {isRider ? "→ আপনাকে" : "→ @rider"}
      </div>
      <p className="mb-2 text-[11px] opacity-80">{msg.body}</p>
      {items.length > 0 && (
        <ul className="space-y-1 rounded-xl bg-white/70 dark:bg-white/5 p-2">
          {items.map((name, i) => (
            <li key={`${i}-${name}`} className="flex items-center gap-2">
              <Check size={12} className="shrink-0 text-amber-600 dark:text-amber-300" />
              <span className="truncate text-[12px]">{name}</span>
              <span className="ml-auto text-[10px] opacity-60">Expiry check</span>
            </li>
          ))}
        </ul>
      )}
      {isRider && (
        <p className="mt-2 text-[10px] italic opacity-70">
          ⚠ ৬ মাসের কম expiry হলে replacement চান + customer-কে জানান।
        </p>
      )}
    </div>
  );
}


/* ---------- Phase 6: Customer location prompt + share-result cards ---------- */

function CustomerLocationPromptCard({
  msg,
  myRole,
  allMessages,
  onShare,
}: {
  msg: ConversationMessage;
  myRole: "customer" | "pharmacy" | "rider";
  allMessages: ConversationMessage[];
  onShare: (p: { body?: string; preset_key?: string | null; payload?: OrderPayload | null; visibility?: MessageVisibility }) => void;
}) {
  const payload = (msg.payload || {}) as unknown as {
    order_id?: string;
    rider_id?: string;
    current_address?: string | null;
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadyShared = allMessages.some((x) => {
    if (x.preset_key !== "ai_customer_location_shared") return false;
    const sharedPayload = (x.payload || {}) as unknown as { order_id?: string };
    if (payload.order_id) return sharedPayload.order_id === payload.order_id;
    return new Date(x.created_at ?? 0).getTime() > new Date(msg.created_at ?? 0).getTime();
  });
  const isCustomer = myRole === "customer";

  const share = () => {
    if (busy) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError(locationErrorMessage());
      return;
    }
    setBusy(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const accuracy = Math.round(pos.coords.accuracy || 0);
        try {
          onShare({
            body: `📍 Live location share করা হলো (±${accuracy}m)`,
            preset_key: "ai_customer_location_shared",
            payload: {
              order_id: payload.order_id,
              lat,
              lng,
              accuracy_m: accuracy,
            } as unknown as OrderPayload,
            visibility: "customer_rider",
          });
        } finally {
          setBusy(false);
        }
      },
      (err) => {
        setBusy(false);
        setError(locationErrorMessage(err));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  };

  return (
    <div className="mx-auto w-[min(340px,92%)] rounded-2xl border-2 border-emerald-400/60 bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/40 dark:to-teal-950/30 p-3 text-[12px] text-slate-900 dark:text-slate-50 shadow-md shadow-emerald-500/15">
      <div className="mb-1 flex items-center gap-1.5 text-[13px] font-extrabold text-emerald-700 dark:text-emerald-200">
        <MapPin size={14} /> medi AI — Location share
      </div>
      <p className="mb-2 text-[11px] opacity-80">{msg.body}</p>
      {payload.current_address && (
        <p className="mb-2 rounded-lg bg-white/70 dark:bg-white/5 px-2 py-1 text-[11px]">
          <span className="opacity-60">Saved address:</span> {payload.current_address}
        </p>
      )}

      {error && (
        <p className="mb-2 rounded-lg bg-rose-500/10 px-2 py-1 text-[11px] text-rose-700 dark:text-rose-200">
          {error}
        </p>
      )}

      {isCustomer && !alreadyShared && (
        <button
          onClick={share}
          disabled={busy}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1.5 text-[12px] font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          <MapPin size={12} /> {busy ? "Locating…" : "Share live location"}
        </button>
      )}
      {isCustomer && alreadyShared && (
        <p className="text-center text-[11px] text-emerald-700 dark:text-emerald-300">
          ✅ Location shared with rider
        </p>
      )}
      {!isCustomer && (
        <p className="text-center text-[11px] opacity-70">
          {alreadyShared ? "✅ Customer location pinned" : "Waiting for customer to share…"}
        </p>
      )}
    </div>
  );
}

function CustomerLocationSharedCard({ msg }: { msg: ConversationMessage }) {
  const payload = (msg.payload || {}) as unknown as {
    lat?: number;
    lng?: number;
    accuracy_m?: number;
  };
  const lat = typeof payload.lat === "number" ? payload.lat : null;
  const lng = typeof payload.lng === "number" ? payload.lng : null;
  const mapHref = lat !== null && lng !== null
    ? `https://www.google.com/maps?q=${lat},${lng}`
    : null;
  return (
    <div className="mx-auto flex max-w-[88%] items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] text-emerald-700 dark:text-emerald-200">
      <MapPin size={11} />
      <span>{msg.body || "Live location shared"}</span>
      {mapHref && (
        <a
          href={mapHref}
          target="_blank"
          rel="noreferrer"
          className="ml-1 underline decoration-dotted hover:opacity-80"
        >
          Map
        </a>
      )}
    </div>
  );
}

// =====================================================================
// Phase 7: medi AI proxy — private "answer this for me" card.
// Visible to the customer only (server enforces visibility=customer_only).
// Customer types a reply; we POST to /ai-proxy-answer which mirrors it
// back to pharmacy/rider as a regular customer message.
// =====================================================================
function AiQuestionForCustomerCard({
  msg,
  myRole,
  conversationId,
  onAnswered,
}: {
  msg: ConversationMessage;
  myRole: "customer" | "pharmacy" | "rider";
  conversationId: string;
  onAnswered?: () => void;
}) {
  const payload: Record<string, unknown> = (msg.payload as Record<string, unknown>) || {};
  const askerRole = String(payload.asker_role || "pharmacy");
  const questionHint = String(payload.ai_summary || "");
  const category = String(payload.question_category || "general");
  const explainer = String(payload.customer_explainer || "");
  const sourceQuestion = String(
    payload[askerRole === "rider" ? "rider_question" : "pharmacy_question"] || "",
  );
  const placeholder = String(payload.reply_placeholder || "");
  const status = String(payload.status || "open");
  const askerLabel = askerRole === "rider" ? "রাইডার" : "ফার্মেসি";
  const askerPossessive = askerRole === "rider" ? "রাইডারের" : "ফার্মেসির";
  const quickReplies = aiQuestionQuickReplies(category);
  const [text, setText] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answered = status === "answered";

  // Defensive — should never render for non-customers because the server
  // strips this row, but double-check on the client just in case.
  if (myRole !== "customer") return null;

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/conversations/${conversationId}/ai-proxy-answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent_question_id: msg.id, answer: t }),
      });
      onAnswered?.();
      // The new customer message will appear on the next poll tick;
      // optimistic UI not strictly needed here.
    } catch (e) {
      const m = e instanceof Error ? e.message : "পাঠাতে পারিনি — আবার চেষ্টা করুন।";
      setErr(m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mx-auto flex w-full max-w-[92%] flex-col gap-2 rounded-2xl border border-emerald-300/70 bg-gradient-to-br from-emerald-50 to-amber-50 px-3 py-2 text-[12px] text-slate-800 shadow-sm shadow-emerald-500/10 dark:border-emerald-500/40 dark:from-emerald-500/10 dark:to-amber-500/10 dark:text-slate-100"
    >
      <div className="flex items-start gap-2">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-emerald-600 text-white text-[12px] shadow-sm">AI</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="text-[11px] font-extrabold text-emerald-700 dark:text-emerald-300">
              medi AI স্বাস্থ্য সহকারী
            </div>
            <span className="rounded-full bg-white/80 px-2 py-0.5 text-[9.5px] font-bold text-emerald-700 ring-1 ring-emerald-200 dark:bg-white/10 dark:text-emerald-200 dark:ring-emerald-500/30">
              {aiQuestionCategoryLabel(category)}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            {askerLabel} কিছু জানতে চেয়েছে; medi AI আন্দাজ করে উত্তর দেবে না।
          </p>
          {sourceQuestion ? (
            <div className="mt-2 rounded-xl bg-white/80 px-2.5 py-2 text-[12px] leading-relaxed text-slate-800 ring-1 ring-black/5 dark:bg-white/10 dark:text-slate-100 dark:ring-white/10">
              <p className="mb-1 text-[10px] font-bold text-slate-500 dark:text-slate-400">
                {askerPossessive} প্রশ্ন
              </p>
              “{sourceQuestion}”
            </div>
          ) : (
            <div className="mt-2 whitespace-pre-line rounded-xl bg-white/80 px-2.5 py-2 text-[12px] leading-relaxed ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10">
              {msg.body}
            </div>
          )}
          {explainer && (
            <p className="mt-2 rounded-xl bg-emerald-600/10 px-2.5 py-2 text-[11px] leading-relaxed text-emerald-900 dark:text-emerald-100">
              {explainer}
            </p>
          )}
          {questionHint && questionHint !== sourceQuestion && !explainer && (
            <div className="mt-1 rounded-lg bg-white/70 px-2 py-1 text-[11px] text-amber-900 dark:bg-white/10 dark:text-amber-100">
              medi AI জানতে চায়: {questionHint}
            </div>
          )}
        </div>
      </div>
      {answered ? (
        <div className="text-[11px] text-emerald-700 dark:text-emerald-400">
          ✓ আপনার উত্তর {askerLabel}-কে পাঠানো হয়েছে।
        </div>
      ) : (
        <>
          {quickReplies.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {quickReplies.map((reply) => (
                <button
                  key={reply}
                  type="button"
                  onClick={() => setText(reply)}
                  disabled={busy}
                  className="rounded-full border border-emerald-300/70 bg-white/80 px-2.5 py-1 text-[10.5px] font-semibold text-emerald-800 shadow-sm hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-500/30 dark:bg-white/10 dark:text-emerald-100"
                >
                  {reply}
                </button>
              ))}
            </div>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder || `আপনার উত্তর লিখুন — ${askerLabel}-কে আপনার নামেই পাঠানো হবে`}
            className="min-h-[56px] w-full resize-y rounded-xl border border-emerald-300/70 bg-white/90 px-2.5 py-2 text-[12px] text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:bg-slate-900/40 dark:text-slate-100"
            maxLength={1200}
            disabled={busy}
          />
          <div className="flex items-center justify-between gap-2">
            {err ? (
              <div className="text-[11px] text-rose-600 dark:text-rose-400">{err}</div>
            ) : (
              <div className="text-[10px] text-slate-500 dark:text-slate-400">
                আপনার উত্তর {askerPossessive} কাছে আপনার বার্তা হিসেবে যাবে।
              </div>
            )}
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || !text.trim()}
              className="rounded-md bg-amber-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {busy ? "পাঠানো হচ্ছে…" : "উত্তর পাঠান"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function aiQuestionCategoryLabel(category: string): string {
  switch (category) {
    case "health":
      return "স্বাস্থ্য তথ্য";
    case "medicine_change":
      return "ওষুধ সিদ্ধান্ত";
    case "price_decision":
      return "দাম/বাজেট";
    case "quantity":
      return "পরিমাণ";
    default:
      return "আপনার উত্তর দরকার";
  }
}

function aiQuestionQuickReplies(category: string): string[] {
  switch (category) {
    case "health":
      return ["জ্বর আছে, কতদিন লিখছি", "কাশি আছে", "কাশি নেই", "রাতে বেশি হয়"];
    case "medicine_change":
      return ["না, প্রেসক্রিপশনের ওষুধটাই চাই", "ডাক্তারের অনুমতি থাকলে নিতে পারি", "আগে ফার্মেসি কারণটা বলুক"];
    case "price_decision":
      return ["এই দাম ঠিক আছে", "কম দামের বিকল্প দিন", "মোট খরচ আরেকটু কমানো যাবে?"];
    case "quantity":
      return ["প্রেসক্রিপশন অনুযায়ী দিন", "পরিমাণ কমাব না", "আগে পরিমাণ নিশ্চিত করুন"];
    default:
      return [];
  }
}

