"use client";

/**
 * Conversation thread — the heart of the chat-first ordering flow.
 *
 * Polls /messages every 5s, marks-seen on every poll, supports plain
 * messages + image attachments + the customer-side preset_keys
 * (`order_request`, `order_status_*`, etc). Renders preset messages as
 * tone-coded "event cards" similar to the website's MessengerDock so
 * customers can recognise "Order confirmed", "Rider on the way" without
 * reading paragraphs.
 */
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import {
  ImagePlus,
  Loader2,
  Send,
  ShoppingBag,
  ChevronLeft,
  ShieldAlert,
  Store,
  XCircle,
  Map as MapIcon,
  MapPin,
  Star,
} from "lucide-react";
import { InitialAvatar } from "@/components/initial-avatar";
import { RichText } from "@/components/rich-text";
import { MobileOrderComposer } from "@/components/mobile-order-composer";
import { HandshakeCard } from "@/components/handshake-card";
import { resolveMediaUrl, session, uploadImage } from "@/lib/api";
import { locationErrorMessage } from "@/lib/geo";
import {
  conversationsApi,
  formatBDT,
  ORDER_PRESETS,
  type ConversationMessage,
  type ConversationSummary,
  type ConversationTrack,
  type MessageVisibility,
  type OrderPayload,
} from "@/lib/conversations";

type Suspense = "idle" | "uploading" | "sending";

/**
 * Normalise a backend timestamp to a Date.
 *
 * The API emits BOTH shapes depending on the DB: Postgres (prod) returns a
 * tz-aware `2026-06-30T13:10:15.335509+00:00`, SQLite (dev) a naive
 * `2026-06-30T13:10:15.335509`. Blindly appending "Z" produced
 * `...+00:00Z` → **Invalid Date** on production only. Only stamp the UTC
 * marker when the string actually carries no offset.
 */
function toDate(iso: string | null): Date | null {
  if (!iso) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const d = new Date(hasZone ? iso : `${iso}Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** True when `curr` falls on a different calendar day than `prev`. */
function dayChanged(prev: string | null, curr: string | null): boolean {
  const c = toDate(curr);
  if (!c) return false;
  const p = toDate(prev);
  if (!p) return true; // first message always opens a day
  return c.toDateString() !== p.toDateString();
}

/** Friendly Bangla day label for the centered divider. */
function dayLabel(iso: string | null): string {
  const d = toDate(iso);
  if (!d) return "";
  const today = new Date();
  const yst = new Date();
  yst.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "আজ";
  if (d.toDateString() === yst.toDateString()) return "গতকাল";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

type ReasonPromptState = {
  title: string;
  description: string;
  placeholder: string;
  confirmLabel: string;
  onSubmit: (reason: string) => void | Promise<void>;
};

export default function ConversationPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;

  const [conv, setConv] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Suspense>("idle");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The composer is `fixed` at the bottom, so the thread must reserve exactly
  // its height or the last messages/action buttons sit UNDER it and can never
  // be tapped. Its height is not a constant — the textarea grows (min 40px →
  // max-h-32) and the quick-action row appears/wraps — so measure it live
  // instead of hard-coding a guess.
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [composerH, setComposerH] = useState(96);
  // When true, the bottom-sheet order composer is open. Tapping the
  // brand pill above the composer toggles it.
  const [composerOpen, setComposerOpen] = useState(false);
  // Live tracking panel — fetched on demand when the customer toggles it.
  const [mapOpen, setMapOpen] = useState(false);
  const [track, setTrack] = useState<ConversationTrack | null>(null);
  const [reasonPrompt, setReasonPrompt] = useState<ReasonPromptState | null>(null);

  // Pull a prefill stashed by the storefront before navigating here.
  useEffect(() => {
    if (!conv) return;
    try {
      const key = `medidoor_chat_prefill_${conv.pharmacy_id}`;
      const draft = window.sessionStorage.getItem(key);
      if (draft && !text) {
        setText(draft);
        window.sessionStorage.removeItem(key);
      }
    } catch {
      /* ignore */
    }
  }, [conv]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Auth guard
  useEffect(() => {
    if (!session.access()) {
      router.replace("/login?next=/chats");
    }
  }, [router]);

  // Resolve conversation summary from the list (cheap + already cached)
  useEffect(() => {
    if (!id) return;
    conversationsApi.list().then((all) => {
      const found = all.find((c) => c.id === id);
      if (found) setConv(found);
    }).catch(() => { /* leave conv null */ });
  }, [id]);

  // Poll messages
  useEffect(() => {
    if (!id) return;
    let stop = false;
    const tick = async () => {
      try {
        const ms = await conversationsApi.messages(id);
        if (!stop) setMessages(ms);
        try { await conversationsApi.markSeen(id); } catch {}
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : "Failed to load");
      }
    };
    tick();
    const t = setInterval(tick, 5_000);
    return () => { stop = true; clearInterval(t); };
  }, [id]);

  // Keep the reserved bottom space in sync with the real composer height.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const measure = () => setComposerH(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-scroll to bottom on new messages. `scrollRef` must point at the
  // element that actually scrolls (see the thread container below) — it used
  // to sit on a non-scrolling div, which made this a silent no-op and left
  // every new message parked below the fold.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, composerH]);

  // Live track polling — only while map panel is open.
  useEffect(() => {
    if (!id || !mapOpen) return;
    let stop = false;
    const tick = async () => {
      try {
        const t = await conversationsApi.track(id);
        if (!stop) setTrack(t);
      } catch { /* keep last */ }
    };
    tick();
    const t = setInterval(tick, 7_000);
    return () => { stop = true; clearInterval(t); };
  }, [id, mapOpen]);

  if (!id) return null;

  const sendText = async () => {
    const body = text.trim();
    if (!body || busy !== "idle") return;
    setBusy("sending");
    try {
      const m = await conversationsApi.send(id, { body });
      setMessages((prev) => [...prev, m]);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy("idle");
    }
  };

  const sendOrderRequest = async (
    payload: OrderPayload,
    body: string,
    attachmentUrl: string | null,
  ) => {
    if (busy !== "idle") return;
    setBusy("sending");
    try {
      const m = await conversationsApi.send(id, {
        preset_key: ORDER_PRESETS.request,
        body,
        payload,
        attachment_url: attachmentUrl,
      });
      setMessages((prev) => [...prev, m]);
      setComposerOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy("idle");
    }
  };

  const sendImage = async (file: File) => {
    setBusy("uploading");
    try {
      const url = await uploadImage(file);
      const m = await conversationsApi.send(id, { attachment_url: url });
      setMessages((prev) => [...prev, m]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy("idle");
    }
  };

  // Generic send used by Accept/Reject/Cancel/Rating inline buttons.
  const sendPreset = async (input: {
    body?: string;
    preset_key?: string | null;
    payload?: OrderPayload | null;
    visibility?: MessageVisibility;
  }) => {
    if (busy !== "idle") return;
    setBusy("sending");
    try {
      const m = await conversationsApi.send(id, input);
      setMessages((prev) => [...prev, m]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy("idle");
    }
  };

  const activeAiQuestion = (() => {
    let contextStart = -1;
    let contextOpen = true;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (
        messages[index].preset_key === "ai_handshake" ||
        messages[index].preset_key === ORDER_PRESETS.request
      ) {
        contextStart = index;
        const payload = (messages[index].payload as unknown as Record<string, unknown> | null) || {};
        if (messages[index].preset_key === "ai_handshake") {
          const status = String(payload.status || "awaiting_pharmacy");
          const handshakeId = String(payload.handshake_id || "");
          contextOpen = ["awaiting_pharmacy", "pharmacy_ok", "awaiting_customer"].includes(status);
          if (contextOpen && handshakeId) {
            contextOpen = !messages.slice(index + 1).some((message) => {
              if (!["ai_handshake_completed", "ai_handshake_rejected", "ai_handshake_cancelled"].includes(message.preset_key || "")) return false;
              const terminalPayload = (message.payload as unknown as Record<string, unknown> | null) || {};
              if (terminalPayload.handshake_id === handshakeId) return true;
              const ids = Array.isArray(terminalPayload.handshake_ids) ? terminalPayload.handshake_ids : [];
              return ids.includes(handshakeId);
            });
          }
        } else {
          const source = String(payload.source || "");
          contextOpen = source === "ai_prescription";
          if (contextOpen) {
            contextOpen = !messages.slice(index + 1).some((message) => [
              ORDER_PRESETS.reject,
              ORDER_PRESETS.delivery_complete,
              ORDER_PRESETS.status_delivered,
            ].includes(message.preset_key as never));
          }
        }
        break;
      }
    }
    if (!contextOpen) return null;
    for (let index = messages.length - 1; index > contextStart; index--) {
      const message = messages[index];
      if (message.preset_key !== "ai_question_for_customer") continue;
      const payload = (message.payload as unknown as Record<string, unknown> | null) || {};
      if (String(payload.status || "open") !== "answered") return message;
    }
    return null;
  })();
  const visibleMessages = messages.filter(
    (message) => message.preset_key !== "ai_question_for_customer",
  );

  // ---------- Workflow derivations (mirrors website OrderQuickActions) ----------
  // Scope to the latest order_request — earlier orders' state is closed.
  const scopeStart = (() => {
    let last = -1;
    for (let i = 0; i < visibleMessages.length; i++) {
      if (visibleMessages[i].preset_key === ORDER_PRESETS.request) last = i;
    }
    return last;
  })();
  const scoped = scopeStart >= 0 ? visibleMessages.slice(scopeStart) : visibleMessages;
  const lastQuoteIdx = (() => {
    for (let i = scoped.length - 1; i >= 0; i--) {
      if (scoped[i].preset_key === ORDER_PRESETS.quote) return i;
    }
    return -1;
  })();
  const hasConfirmAfterQuote = lastQuoteIdx >= 0 && scoped
    .slice(lastQuoteIdx + 1)
    .some((m) => m.preset_key === ORDER_PRESETS.confirm || m.preset_key === ORDER_PRESETS.reject);
  const lastStatus = (() => {
    for (let i = scoped.length - 1; i >= 0; i--) {
      const k = scoped[i].preset_key;
      if (!k) continue;
      if ([
        ORDER_PRESETS.request, ORDER_PRESETS.quote, ORDER_PRESETS.confirm, ORDER_PRESETS.reject,
        ORDER_PRESETS.status_preparing, ORDER_PRESETS.status_on_the_way, ORDER_PRESETS.status_delivered,
        ORDER_PRESETS.handed_over, ORDER_PRESETS.delivery_complete,
      ].includes(k as never)) return k;
    }
    return null;
  })();
  const handedOver =
    lastStatus === ORDER_PRESETS.handed_over ||
    lastStatus === ORDER_PRESETS.status_on_the_way ||
    lastStatus === ORDER_PRESETS.status_delivered ||
    lastStatus === ORDER_PRESETS.delivery_complete;
  const riderJoinedInScope = scoped.some((m) => m.preset_key === ORDER_PRESETS.rider_joined);
  const riderActive = !!conv?.rider_id && riderJoinedInScope && !handedOver;
  const canCancel =
    !handedOver &&
    !riderActive &&
    scopeStart >= 0 &&
    (lastStatus === ORDER_PRESETS.request ||
      lastStatus === ORDER_PRESETS.quote ||
      lastStatus === ORDER_PRESETS.confirm ||
      lastStatus === ORDER_PRESETS.status_preparing);

  const cancelOrder = async () => {
    setReasonPrompt({
      title: "Order cancel করবেন?",
      description: "Pharmacy এই কারণটি দেখতে পাবে। চাইলে খালি রাখতেও পারেন।",
      placeholder: "যেমন: আর দরকার নেই / ঠিকানা ভুল",
      confirmLabel: "অর্ডার বাতিল",
      onSubmit: async (reason) => {
        await sendPreset({
          body: `🚫 *Customer order cancel করেছেন।*${reason ? `\n_কারণ:_ ${reason}` : ""}`,
          preset_key: ORDER_PRESETS.reject,
        });
      },
    });
  };

  const otherSide = conv?.pharmacy_last_read_at;
  const myLastSent = [...visibleMessages].reverse().find((m) => m.sender_role === "customer");

  return (
    <>
      {/* Custom WhatsApp-style header — avatar + name links to the
          storefront so customers can browse the same pharmacy without
          backing out of the chat.
          NOTE: positioned `fixed` (not sticky) because `.app-scroll`
          already reserves `padding-top: var(--header-h) + var(--safe-top)`
          globally; using sticky here would float the header inside the
          scroll content and cover messages on scroll. */}
      <header
        className="fixed inset-x-0 top-0 z-40 mx-auto flex max-w-[480px] items-center gap-2.5 border-b border-slate-200/60 bg-white/85 backdrop-blur-xl dark:border-white/10 dark:bg-[#0b1018]/85"
        style={{
          height: "calc(var(--header-h) + var(--safe-top))",
          paddingTop: "var(--safe-top)",
          paddingLeft: "calc(var(--safe-left) + 6px)",
          paddingRight: "calc(var(--safe-right) + 10px)",
        }}
      >
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="Back"
          className="tap grid h-9 w-9 shrink-0 place-items-center rounded-full text-brand-600 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-white/5"
        >
          <ChevronLeft size={22} />
        </button>
        {conv ? (
          <Link
            href={`/store/${conv.pharmacy_id}`}
            className="tap flex min-w-0 flex-1 items-center gap-2.5"
          >
            <span className="relative shrink-0">
              <InitialAvatar
                name={conv.pharmacy_name}
                src={resolveMediaUrl(conv.pharmacy_avatar) || null}
                size={40}
              />
              {/* Online presence dot — Messenger signature. */}
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-[#0b1018]" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-bold leading-tight text-slate-900 dark:text-white">
                {conv.pharmacy_name}
              </p>
              <p className="truncate text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                {conv.rider_id
                  ? `🛵 Rider ${conv.rider_name ?? "পথে আছে"}`
                  : "সক্রিয় এখন"}
              </p>
            </div>
          </Link>
        ) : (
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-bold">Chat</p>
          </div>
        )}
        <Link
          href={conv ? `/store/${conv.pharmacy_id}` : "#"}
          aria-label="View storefront"
          className="tap grid h-9 w-9 shrink-0 place-items-center rounded-full text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5"
        >
          <Store size={18} />
        </Link>
        <button
          type="button"
          onClick={() => setMapOpen((v) => !v)}
          aria-label="Toggle map"
          className={`tap grid h-9 w-9 shrink-0 place-items-center rounded-full ${mapOpen ? "bg-brand-500 text-white shadow-sm shadow-brand-500/30" : "text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5"}`}
        >
          <MapIcon size={18} />
        </button>
      </header>

      {/* The thread is its OWN scroller (like the pharmacy/rider chats), not a
          tall block inside `.app-scroll`. Two reasons:
            1. `scrollRef` must be on a real scrolling element or the
               auto-scroll-to-newest above silently does nothing.
            2. `.app-scroll` only reserves the bottom-nav height (64px), but
               this screen hides the nav and shows a ~95px+ composer instead,
               so the last messages were unreachable under it.
          `absolute inset-0` fills `.app-scroll`'s padding box, so this element
          owns its own header/composer clearance. */}
      <div
        ref={scrollRef}
        className="chat-surface absolute inset-0 flex flex-col gap-0.5 overflow-y-auto px-3"
        style={{
          paddingTop: "calc(var(--header-h) + var(--safe-top) + 12px)",
          paddingBottom: composerH + 12,
        }}
      >
        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-2 text-[11px] text-rose-600 dark:border-rose-500/40 dark:bg-rose-500/10">
            {error}
          </div>
        )}
        {conv?.blocked_at && (
          <div className="flex items-center gap-2 rounded-xl border border-rose-300 bg-rose-50 p-2 text-[11px] text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300">
            <ShieldAlert size={13} />
            <span>এই chat টি moderation কর্তৃক block — {conv.block_reason || "নিষিদ্ধ activity"}.</span>
          </div>
        )}

        {activeAiQuestion && (
          <AiQuestionForCustomerCard
            key={activeAiQuestion.id}
            m={activeAiQuestion}
            conversationId={id}
            onAnswered={() => {
              setMessages((prev) => prev.map((message) => (
                message.id === activeAiQuestion.id
                  ? {
                      ...message,
                      payload: {
                        ...((message.payload as unknown as Record<string, unknown> | null) || {}),
                        status: "answered",
                      } as unknown as OrderPayload,
                    }
                  : message
              )));
            }}
          />
        )}

        {mapOpen && <MapPanel track={track} />}

        {visibleMessages.map((m, idx) => {
          const prev = visibleMessages[idx - 1];
          const nextMsg = visibleMessages[idx + 1];
          const isPlain = !m.preset_key && m.sender_role !== "system";
          // Group consecutive plain messages from the same sender (Messenger
          // clusters a run of bubbles and shows the avatar only on the last
          // one, with tight spacing inside a run and a gap between runs).
          const sameSender =
            prev && prev.sender_role === m.sender_role && !prev.preset_key && !m.preset_key;
          const nextSame =
            nextMsg && nextMsg.sender_role === m.sender_role && !nextMsg.preset_key && isPlain;
          const firstOfGroup = isPlain && !sameSender;
          const lastOfGroup = isPlain && !nextSame;
          // Day divider when the calendar day changes between messages.
          const showDayDivider = dayChanged(prev?.created_at ?? null, m.created_at);
          // Decide whether the inline Accept/Reject buttons should appear
          // on the latest unanswered pharmacy quote.
          const showAcceptReject =
            m.preset_key === ORDER_PRESETS.quote &&
            scopeStart >= 0 &&
            idx >= scopeStart &&
            idx === scopeStart + lastQuoteIdx &&
            !hasConfirmAfterQuote &&
            !conv?.blocked_at;
          // Decide whether to show the rating prompt under a delivery message.
          const isDeliveryMsg =
            m.preset_key === ORDER_PRESETS.status_delivered ||
            m.preset_key === ORDER_PRESETS.delivery_complete;
          const ratedAfter = isDeliveryMsg && messages
            .slice(idx + 1)
            .some((mm) => mm.preset_key === ORDER_PRESETS.rating_submitted);
          const showRating = isDeliveryMsg && !ratedAfter && !!conv?.pharmacy_id;
          return (
            <div key={m.id} className={firstOfGroup ? "mt-2" : ""}>
            {showDayDivider && (
              <div className="chat-divider">{dayLabel(m.created_at)}</div>
            )}
            <Bubble
              m={m}
              mine={m.sender_role === "customer"}
              showAvatar={lastOfGroup}
              firstOfGroup={firstOfGroup}
              lastOfGroup={lastOfGroup}
              pharmacyName={conv?.pharmacy_name || "P"}
              pharmacyAvatar={resolveMediaUrl(conv?.pharmacy_avatar || null) || null}
              allMessages={messages}
              onAction={(p) => void sendPreset(p)}
              busy={busy !== "idle"}
              showAcceptReject={showAcceptReject}
              showRating={showRating}
              onAcceptQuote={async () => {
                const total = formatBDT(m.payload?.total ?? 0);
                await sendPreset({
                  body: `✅ *Quote accept করেছি* — মোট ${total}`,
                  preset_key: ORDER_PRESETS.confirm,
                  payload: m.payload || null,
                });
              }}
              onRejectQuote={async () => {
                setReasonPrompt({
                  title: "Quote reject করবেন?",
                  description: "Reject করলে pharmacy নতুন request বা quote পাঠানোর অপেক্ষায় থাকবে।",
                  placeholder: "যেমন: দাম বেশি / item দরকার নেই",
                  confirmLabel: "Reject quote",
                  onSubmit: async (why) => {
                    await sendPreset({
                      body: `❌ *Quote reject করেছি।*${why ? `\n_কারণ:_ ${why}` : ""}`,
                      preset_key: ORDER_PRESETS.reject,
                    });
                  },
                });
              }}
              onSubmitRating={async (stars) => {
                if (!conv?.pharmacy_id) return;
                try {
                  await conversationsApi.ratePharmacy(conv.pharmacy_id, stars);
                  await sendPreset({
                    body: `⭐ *${stars}/5 rating দিয়েছি* — ধন্যবাদ!`,
                    preset_key: ORDER_PRESETS.rating_submitted,
                  });
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Rating failed");
                }
              }}
            />
            </div>
          );
        })}

        {/* Seen indicator — a tiny reader avatar hugs the last message the
            pharmacy has read (Messenger's "seen by" affordance). */}
        {myLastSent && otherSide && new Date(otherSide) >= new Date(myLastSent.created_at || 0) && (
          <div className="-mt-0.5 flex items-center gap-1 self-end pr-0.5">
            <span className="overflow-hidden rounded-full ring-1 ring-white dark:ring-[#070b12]">
              <InitialAvatar
                name={conv?.pharmacy_name || "P"}
                src={resolveMediaUrl(conv?.pharmacy_avatar || null) || null}
                size={14}
              />
            </span>
          </div>
        )}
      </div>

      {/* Sticky composer — sits above the iOS home indicator. Measured by the
          ResizeObserver above so the thread always reserves exactly its
          height (it grows with the textarea + quick-action row). */}
      <div
        ref={composerRef}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200/60 bg-white/95 backdrop-blur-md dark:border-white/10 dark:bg-[#070b12]/95"
        style={{
          paddingBottom: "calc(var(--safe-bottom) + 8px)",
          paddingTop: 8,
          paddingLeft: "calc(var(--safe-left) + 8px)",
          paddingRight: "calc(var(--safe-right) + 8px)",
        }}
      >
        <div className="mx-auto max-w-[480px]">
          {/* Quick action: order request + cancel */}
          <div className="mb-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setComposerOpen(true)}
              disabled={busy !== "idle" || !!conv?.blocked_at}
              className="tap flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1.5 text-[11px] font-bold text-brand-700 ring-1 ring-brand-500/15 disabled:opacity-50 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20"
            >
              <ShoppingBag size={12} /> অর্ডার request
            </button>
            {canCancel && (
              <button
                type="button"
                onClick={cancelOrder}
                disabled={busy !== "idle" || !!conv?.blocked_at}
                className="tap flex items-center gap-1.5 rounded-full bg-rose-50 px-3 py-1.5 text-[11px] font-bold text-rose-700 ring-1 ring-rose-500/15 disabled:opacity-50 dark:bg-rose-500/10 dark:text-rose-300"
              >
                <XCircle size={12} /> অর্ডার বাতিল
              </button>
            )}
          </div>

          <div className="flex items-end gap-1.5">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) sendImage(f);
                e.currentTarget.value = "";
              }}
            />
            {/* Attach — circular brand button (Messenger's left action). */}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy !== "idle" || !!conv?.blocked_at}
              aria-label="Attach image"
              className="tap grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600 hover:bg-brand-100 disabled:opacity-50 dark:bg-white/[0.06] dark:text-brand-300 dark:hover:bg-white/10"
            >
              {busy === "uploading" ? <Loader2 size={17} className="animate-spin" /> : <ImagePlus size={18} />}
            </button>
            {/* Rounded pill input. */}
            <div className="flex min-w-0 flex-1 items-end rounded-[22px] bg-slate-100 px-3.5 transition focus-within:bg-slate-100 focus-within:ring-2 focus-within:ring-brand-400/40 dark:bg-white/[0.06]">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendText();
                  }
                }}
                placeholder={conv?.blocked_at ? "এই chat টি বন্ধ" : "Aa"}
                rows={1}
                disabled={!!conv?.blocked_at}
                className="max-h-32 min-h-[40px] min-w-0 flex-1 resize-none bg-transparent py-2.5 text-[14px] outline-none placeholder:text-slate-400"
              />
            </div>
            {/* Send — circular gradient; springs in when there's text. */}
            <button
              type="button"
              onClick={sendText}
              disabled={!text.trim() || busy !== "idle" || !!conv?.blocked_at}
              aria-label="Send"
              className={`tap grid h-10 w-10 shrink-0 place-items-center rounded-full text-white transition-all duration-150 ${
                text.trim() && busy === "idle" && !conv?.blocked_at
                  ? "bubble-out scale-100 opacity-100"
                  : "scale-90 bg-slate-300 opacity-70 dark:bg-white/10"
              }`}
            >
              {busy === "sending" ? <Loader2 size={17} className="animate-spin" /> : <Send size={16} className="-ml-0.5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Bottom-sheet order builder — mounted only while open so the
          catalog + body-scroll lock are torn down on close. */}
      {composerOpen && conv && (
        <MobileOrderComposer
          pharmacyId={conv.pharmacy_id}
          onClose={() => setComposerOpen(false)}
          onSubmit={sendOrderRequest}
        />
      )}

      {reasonPrompt && (
        <ReasonPromptModal
          prompt={reasonPrompt}
          onClose={() => setReasonPrompt(null)}
        />
      )}
    </>
  );
}

function ReasonPromptModal({
  prompt,
  onClose,
}: {
  prompt: ReasonPromptState;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await prompt.onSubmit(reason.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/35 px-3 pb-[calc(var(--safe-bottom)+12px)] backdrop-blur-sm">
      <div className="w-full max-w-[448px] rounded-3xl border border-white/70 bg-white p-4 shadow-2xl dark:border-white/10 dark:bg-[#101722]">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200 dark:bg-white/20" />
        <h2 className="text-base font-extrabold text-slate-950 dark:text-white">{prompt.title}</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">
          {prompt.description}
        </p>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value.slice(0, 220))}
          placeholder={prompt.placeholder}
          rows={3}
          autoFocus
          className="mt-3 w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:bg-white dark:border-white/10 dark:bg-white/5 dark:focus:bg-white/10"
        />
        {error && (
          <p className="mt-2 rounded-xl bg-rose-500/10 px-3 py-2 text-[11px] text-rose-700 dark:text-rose-200">
            {error}
          </p>
        )}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="tap rounded-2xl border border-slate-200 bg-white px-3 py-2 text-[12px] font-bold text-slate-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="tap inline-flex items-center justify-center gap-1.5 rounded-2xl bg-rose-600 px-3 py-2 text-[12px] font-bold text-white disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <XCircle size={13} />}
            {prompt.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  m,
  mine,
  showAvatar,
  firstOfGroup = true,
  lastOfGroup = true,
  pharmacyName,
  pharmacyAvatar,
  allMessages,
  onAction,
  busy,
  showAcceptReject,
  showRating,
  onAcceptQuote,
  onRejectQuote,
  onSubmitRating,
}: {
  m: ConversationMessage;
  mine: boolean;
  showAvatar: boolean;
  firstOfGroup?: boolean;
  lastOfGroup?: boolean;
  pharmacyName: string;
  pharmacyAvatar: string | null;
  allMessages: ConversationMessage[];
  onAction: (p: { body?: string; preset_key?: string | null; payload?: import("@/lib/conversations").OrderPayload | null; visibility?: MessageVisibility }) => void;
  busy: boolean;
  showAcceptReject: boolean;
  showRating: boolean;
  onAcceptQuote: () => void | Promise<void>;
  onRejectQuote: () => void | Promise<void>;
  onSubmitRating: (stars: number) => void | Promise<void>;
}) {
  // Smart-Rx handshake family → interactive card (Final-Confirm / Cancel).
  if (
    m.preset_key === "ai_handshake" ||
    m.preset_key === "ai_customer_confirm_prompt" ||
    m.preset_key === "ai_handshake_completed" ||
    m.preset_key === "ai_handshake_rejected" ||
    m.preset_key === "ai_handshake_cancelled"
  ) {
    return <HandshakeCard msg={m} allMessages={allMessages} onAction={onAction} />;
  }
  // Handshake action triggers (RPC-style) are conveyed by the system pills
  // above; suppress the redundant bubble to keep the thread clean.
  if (
    m.preset_key === "pharmacy_handshake_ok" ||
    m.preset_key === "pharmacy_handshake_reject" ||
    m.preset_key === "customer_handshake_cancel"
  ) {
    return null;
  }
  if (m.preset_key === "ai_rider_expiry_check") {
    return <RiderExpiryCheckCard m={m} />;
  }
  if (m.preset_key === "ai_customer_location_prompt") {
    return <CustomerLocationPromptCard m={m} allMessages={allMessages} onAction={onAction} busy={busy} />;
  }
  if (m.preset_key === "ai_customer_location_shared") {
    return <CustomerLocationSharedCard m={m} />;
  }
  // System / preset events render as full-width tone cards with markdown.
  if (m.sender_role === "system" || m.preset_key) {
    return (
      <EventCard
        m={m}
        busy={busy}
        showAcceptReject={showAcceptReject}
        showRating={showRating}
        onAcceptQuote={onAcceptQuote}
        onRejectQuote={onRejectQuote}
        onSubmitRating={onSubmitRating}
      />
    );
  }
  // Messenger-style grouped bubble: brand-gradient for mine, soft grey for
  // theirs, with the stacked-edge corners flattened so a run of messages
  // reads as one connected cluster. The pharmacy avatar shows only on the
  // last bubble of a run; the timestamp only under the last of a run.
  const corner = mine
    ? `${firstOfGroup ? "" : "rounded-tr-[7px]"} ${lastOfGroup ? "" : "rounded-br-[7px]"}`
    : `${firstOfGroup ? "" : "rounded-tl-[7px]"} ${lastOfGroup ? "" : "rounded-bl-[7px]"}`;
  const bubble = mine
    ? "bubble-out"
    : "bg-slate-100 text-slate-900 dark:bg-white/[0.07] dark:text-slate-100";
  return (
    <div className={`flex items-end gap-2 ${mine ? "flex-row-reverse" : "flex-row"}`}>
      {/* Pharmacy avatar gutter — shown on the LAST message of a run
          (Messenger style, avatar hugs the bottom bubble). Mine has none. */}
      <div className="w-7 shrink-0 self-end">
        {!mine && showAvatar && (
          <InitialAvatar name={pharmacyName} src={pharmacyAvatar} size={28} />
        )}
      </div>
      <div className={`flex max-w-[80%] flex-col ${mine ? "items-end" : "items-start"}`}>
        <div className={`animate-msgIn rounded-[20px] px-3.5 py-2 text-[13.5px] leading-relaxed ${corner} ${bubble}`}>
          {m.attachment_url && (
            <div className="relative mb-1.5 h-44 w-56 overflow-hidden rounded-2xl bg-black/5">
              <Image
                src={resolveMediaUrl(m.attachment_url)}
                alt="attachment"
                fill
                sizes="320px"
                className="object-cover"
              />
            </div>
          )}
          {m.body && <RichText text={m.body} />}
        </div>
        {lastOfGroup && (
          <p className={`mt-1 text-[9.5px] font-medium text-slate-400 ${mine ? "pr-1.5" : "pl-1.5"}`}>
            {toDate(m.created_at ?? null)?.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }) ?? ""}
          </p>
        )}
      </div>
    </div>
  );
}

function EventCard({
  m, busy, showAcceptReject, showRating, onAcceptQuote, onRejectQuote, onSubmitRating,
}: {
  m: ConversationMessage;
  busy: boolean;
  showAcceptReject: boolean;
  showRating: boolean;
  onAcceptQuote: () => void | Promise<void>;
  onRejectQuote: () => void | Promise<void>;
  onSubmitRating: (stars: number) => void | Promise<void>;
}) {
  const tone = pickTone(m.preset_key);
  const items = m.payload?.items;
  const title = eventTitle(m);
  const body = normalizeEventBody(m.body);
  const showBody = Boolean(body && shouldShowEventBody(m));
  return (
    <div className="animate-msgIn my-1.5 self-center w-full max-w-[92%]">
      <div className={`rounded-[20px] border px-3.5 py-2.5 text-[12px] font-medium shadow-sm ${tone}`}>
        {title && <p className="font-extrabold leading-snug">{title}</p>}
        {showBody && (
          <div className={title ? "mt-1 leading-snug opacity-90" : "leading-snug"}>
            <RichText text={body} />
          </div>
        )}
        {items && items.length > 0 && (
          <ItemTable payload={m.payload!} />
        )}
        {m.attachment_url && (
          <div className="relative mt-2 h-40 w-full overflow-hidden rounded-xl bg-black/10">
            <Image
              src={resolveMediaUrl(m.attachment_url)}
              alt="prescription"
              fill
              sizes="360px"
              className="object-cover"
            />
          </div>
        )}
        {showAcceptReject && (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void onAcceptQuote()}
              className="tap flex-1 rounded-full bg-emerald-600 px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
            >
              ✅ Quote accept করুন
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void onRejectQuote()}
              className="tap flex-1 rounded-full bg-rose-600 px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
            >
              ❌ Reject করুন
            </button>
          </div>
        )}
        {showRating && (
          <RatingPrompt busy={busy} onSubmit={onSubmitRating} />
        )}
      </div>
    </div>
  );
}

function eventTitle(m: ConversationMessage): string | null {
  const total = m.payload?.total != null ? ` — মোট ${formatBDT(m.payload.total)}` : "";
  switch (m.preset_key) {
    case ORDER_PRESETS.request:
      return `📦 অর্ডার request${total}`;
    case ORDER_PRESETS.quote:
      return `🧾 Pharmacy quote${total}`;
    case ORDER_PRESETS.confirm:
      return `✅ অর্ডার confirm হয়েছে${total}`;
    case ORDER_PRESETS.reject:
      return "❌ অর্ডার বাতিল হয়েছে";
    case ORDER_PRESETS.delay:
      return "⏱️ ফার্মেসি delay জানিয়েছে";
    case ORDER_PRESETS.status_preparing:
      return "🟢 অর্ডার প্যাকিং চলছে";
    case ORDER_PRESETS.call_rider:
      return "📞 Rider খোঁজা হচ্ছে";
    case ORDER_PRESETS.rider_joined:
      return "🛵 Rider chat-এ যুক্ত হয়েছে";
    case "rider_left":
      return "🛵 Rider chat থেকে বের হয়েছে";
    case ORDER_PRESETS.handed_over:
      return "🤝 ফার্মেসি rider-কে medicine দিয়েছে";
    case ORDER_PRESETS.status_on_the_way:
      return "🛵 Rider পথে আছে";
    case ORDER_PRESETS.delivery_complete:
    case ORDER_PRESETS.status_delivered:
      return "✅ Delivery সম্পন্ন";
    case ORDER_PRESETS.rating_submitted:
      return "⭐ Rating পাঠানো হয়েছে";
    default:
      return null;
  }
}

function shouldShowEventBody(m: ConversationMessage): boolean {
  if (m.preset_key === ORDER_PRESETS.request || m.preset_key === ORDER_PRESETS.quote) {
    return !m.payload?.items?.length;
  }
  return [ORDER_PRESETS.reject, ORDER_PRESETS.delay].includes(m.preset_key as never);
}

function normalizeEventBody(body: string): string {
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

function RatingPrompt({
  busy, onSubmit,
}: { busy: boolean; onSubmit: (n: number) => void | Promise<void> }) {
  const [hover, setHover] = useState(0);
  return (
    <div className="mt-2 rounded-xl bg-white/70 p-2 ring-1 ring-black/5 dark:bg-black/30 dark:ring-white/10">
      <p className="mb-1 text-[11px] font-semibold opacity-80">ফার্মেসিকে rate করুন</p>
      <div className="flex items-center justify-between">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            disabled={busy}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            onClick={() => void onSubmit(n)}
            aria-label={`${n} star`}
            className="tap grid h-9 w-9 place-items-center rounded-full hover:bg-amber-100 disabled:opacity-50 dark:hover:bg-amber-500/10"
          >
            <Star
              size={20}
              className={n <= hover ? "fill-amber-400 text-amber-500" : "text-amber-400"}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

function RiderExpiryCheckCard({ m }: { m: ConversationMessage }) {
  const payload = (m.payload as unknown as { items?: string[] } | null) || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  return (
    <div className="self-center w-full max-w-[92%] rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide">
        <ShieldAlert size={13} /> medi AI · rider নির্দেশনা
      </div>
      <p className="whitespace-pre-line leading-relaxed">{m.body}</p>
      {items.length > 0 && (
        <div className="mt-2 grid gap-1 rounded-xl bg-white/70 p-2 dark:bg-white/10">
          {items.map((name, index) => (
            <div key={`${name}-${index}`} className="flex items-center gap-2 text-[11px]">
              <span className="grid h-5 w-5 place-items-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-200">✓</span>
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="text-[10px] opacity-70">expiry check</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomerLocationPromptCard({
  m,
  allMessages,
  onAction,
  busy,
}: {
  m: ConversationMessage;
  allMessages: ConversationMessage[];
  onAction: (p: { body?: string; preset_key?: string | null; payload?: OrderPayload | null; visibility?: MessageVisibility }) => void;
  busy: boolean;
}) {
  const payload = (m.payload as unknown as Record<string, unknown> | null) || {};
  const [error, setError] = useState<string | null>(null);
  const promptOrderId = typeof payload.order_id === "string" ? payload.order_id : null;
  const shared = allMessages.some((message) => {
    if (message.preset_key !== "ai_customer_location_shared") return false;
    const sharedPayload = (message.payload as unknown as Record<string, unknown> | null) || {};
    if (promptOrderId) return sharedPayload.order_id === promptOrderId;
    return new Date(message.created_at ?? 0).getTime() > new Date(m.created_at ?? 0).getTime();
  });
  const share = () => {
    if (busy || shared) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError(locationErrorMessage());
      return;
    }
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const accuracy = Math.round(position.coords.accuracy || 0);
        onAction({
          body: `📍 Live location share করা হলো (±${accuracy}m)`,
          preset_key: "ai_customer_location_shared",
          payload: ({
            order_id: payload.order_id,
            rider_id: payload.rider_id,
            lat,
            lng,
            accuracy_m: accuracy,
          } as unknown) as OrderPayload,
          visibility: "customer_rider",
        });
      },
      (err) => setError(locationErrorMessage(err)),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  };
  return (
    <div className="self-center w-full max-w-[92%] rounded-2xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide">
        <MapPin size={13} /> medi AI · লোকেশন
      </div>
      <p className="whitespace-pre-line leading-relaxed">{m.body}</p>
      {typeof payload.current_address === "string" && payload.current_address && (
        <p className="mt-2 rounded-xl bg-white/70 px-2 py-1 text-[11px] dark:bg-white/10">
          সেভ করা address: {payload.current_address}
        </p>
      )}
      {error && <p className="mt-2 rounded-lg bg-rose-500/10 px-2 py-1 text-[11px] text-rose-600 dark:text-rose-300">{error}</p>}
      {shared ? (
        <p className="mt-2 text-center text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">✓ Rider-কে location পাঠানো হয়েছে</p>
      ) : (
        <button
          type="button"
          onClick={share}
          disabled={busy}
          className="tap mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
        >
          <MapPin size={13} /> Live location share করুন
        </button>
      )}
    </div>
  );
}

function CustomerLocationSharedCard({ m }: { m: ConversationMessage }) {
  const payload = (m.payload as unknown as { lat?: number; lng?: number; accuracy_m?: number } | null) || {};
  const hasCoords = typeof payload.lat === "number" && typeof payload.lng === "number";
  const href = hasCoords ? `https://www.google.com/maps?q=${payload.lat},${payload.lng}` : null;
  return (
    <div className="self-center inline-flex max-w-[92%] items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
      <MapPin size={12} />
      <span>{m.body || "Live location share করা হয়েছে"}</span>
      {href && (
        <a href={href} target="_blank" rel="noreferrer" className="underline decoration-dotted">
          Map
        </a>
      )}
    </div>
  );
}

function MapPanel({ track }: { track: ConversationTrack | null }) {
  if (!track) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center text-[11px] text-slate-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-400">
        Loading map…
      </div>
    );
  }
  const points = [
    track.pharmacy.lat && track.pharmacy.lng ? { lat: track.pharmacy.lat, lng: track.pharmacy.lng, label: "P" } : null,
    track.customer.lat && track.customer.lng ? { lat: track.customer.lat, lng: track.customer.lng, label: "C" } : null,
    track.rider?.lat && track.rider?.lng ? { lat: track.rider.lat, lng: track.rider.lng, label: "R" } : null,
  ].filter(Boolean) as { lat: number; lng: number; label: string }[];
  if (points.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center text-[11px] text-slate-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-400">
        Location এখনো share করা হয়নি।
      </div>
    );
  }
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const pad = 0.005;
  const minLat = Math.min(...lats) - pad, maxLat = Math.max(...lats) + pad;
  const minLng = Math.min(...lngs) - pad, maxLng = Math.max(...lngs) + pad;
  const bbox = `${minLng}%2C${minLat}%2C${maxLng}%2C${maxLat}`;
  const marker = `${points[0].lat}%2C${points[0].lng}`;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${marker}`;
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-white/[0.04]">
      <iframe
        title="Live order map"
        src={src}
        className="h-56 w-full"
        loading="lazy"
      />
      <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1.5 text-[10px] text-slate-500 dark:text-slate-400">
        <span>
          {track.rider ? `🛵 ${track.rider.name || "Rider"}` : "📦 Pharmacy → Customer"}
        </span>
        <a
          className="font-semibold text-brand-600 dark:text-brand-300"
          href={`https://www.openstreetmap.org/?mlat=${points[0].lat}&mlon=${points[0].lng}#map=15/${points[0].lat}/${points[0].lng}`}
          target="_blank"
          rel="noreferrer"
        >
          Open full map ↗
        </a>
      </div>
    </div>
  );
}

function ItemTable({ payload }: { payload: OrderPayload }) {
  const subtotal =
    Number(payload.subtotal) ||
    payload.items.reduce((s, it) => s + Number(it.unit_price || 0) * Number(it.qty || 0), 0);
  const delivery = Number(payload.delivery_fee) || 0;
  const total = Number(payload.total) || subtotal + delivery;
  return (
    <div className="mt-2 rounded-xl bg-white/70 p-2 ring-1 ring-black/5 dark:bg-black/30 dark:ring-white/10">
      <ul className="divide-y divide-black/5 dark:divide-white/10">
        {payload.items.map((it, i) => {
          const unit = Number(it.unit_price) || 0;
          const qty = Number(it.qty) || 0;
          return (
            <li key={i} className="flex items-center gap-2 py-1.5">
              <div className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-black/5 dark:bg-white/10">
                {it.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={resolveMediaUrl(it.image_url) || ""}
                    alt={it.name}
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      const el = e.currentTarget;
                      el.style.display = "none";
                      const parent = el.parentElement;
                      if (parent && !parent.querySelector(".img-fallback")) {
                        const span = document.createElement("span");
                        span.className = "img-fallback text-[14px] opacity-50";
                        span.textContent = "💊";
                        parent.appendChild(span);
                      }
                    }}
                  />
                ) : (
                  <span className="text-[14px] opacity-50">💊</span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-semibold leading-tight">
                  {it.name}
                </p>
                <p className="text-[10px] opacity-70">
                  {formatBDT(unit)} × {qty}
                </p>
              </div>
              <p className="shrink-0 text-[11px] font-bold tabular-nums">
                {formatBDT(unit * qty)}
              </p>
            </li>
          );
        })}
      </ul>
      <div className="mt-1.5 space-y-0.5 border-t border-black/10 pt-1.5 text-[11px] dark:border-white/10">
        <div className="flex items-center justify-between opacity-80">
          <span>ঔষধ</span>
          <span className="tabular-nums font-semibold">{formatBDT(subtotal)}</span>
        </div>
        {delivery > 0 && (
          <div className="flex items-center justify-between opacity-80">
            <span>ডেলিভারি</span>
            <span className="tabular-nums font-semibold">{formatBDT(delivery)}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-[13px] font-extrabold">
          <span>মোট</span>
          <span className="tabular-nums">{formatBDT(total)}</span>
        </div>
      </div>
      {payload.note && (
        <p className="mt-1.5 text-[10px] italic opacity-80">নোট: {payload.note}</p>
      )}
    </div>
  );
}

function pickTone(preset: string | null): string {
  switch (preset) {
    case ORDER_PRESETS.request:
      return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200";
    case ORDER_PRESETS.quote:
      return "border-brand-300 bg-brand-50 text-brand-800 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-200";
    case ORDER_PRESETS.confirm:
      return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200";
    case ORDER_PRESETS.reject:
      return "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300";
    case ORDER_PRESETS.delay:
      return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200";
    case ORDER_PRESETS.status_preparing:
    case ORDER_PRESETS.status_on_the_way:
      return "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-200";
    case ORDER_PRESETS.call_rider:
      return "border-indigo-300 bg-indigo-50 text-indigo-800 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-200";
    case ORDER_PRESETS.rider_joined:
      return "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200";
    case ORDER_PRESETS.handed_over:
      return "border-purple-300 bg-purple-50 text-purple-800 dark:border-purple-500/40 dark:bg-purple-500/10 dark:text-purple-200";
    case ORDER_PRESETS.delivery_complete:
    case ORDER_PRESETS.status_delivered:
      return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200";
    case ORDER_PRESETS.rating_submitted:
      return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200";
    default:
      return "border-slate-200 bg-slate-50 text-slate-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300";
  }
}

function AiQuestionForCustomerCard({
  m,
  conversationId,
  onAnswered,
}: {
  m: ConversationMessage;
  conversationId: string;
  onAnswered?: () => void;
}) {
  const payload = (m.payload as unknown as Record<string, unknown>) || {};
  const askerRole = String(payload["asker_role"] || "pharmacy");
  const questionHint = String(payload["ai_summary"] || "");
  const category = String(payload["question_category"] || "general");
  const explainer = String(payload["customer_explainer"] || "");
  const sourceQuestion = String(
    payload[askerRole === "rider" ? "rider_question" : "pharmacy_question"] || "",
  );
  const placeholder = String(payload["reply_placeholder"] || "");
  const status = String(payload["status"] || "open");
  const askerLabel = askerRole === "rider" ? "রাইডার" : "ফার্মেসি";
  const askerPossessive = askerRole === "rider" ? "রাইডারের" : "ফার্মেসির";
  const quickReplies = aiQuestionQuickReplies(category);
  const [text, setText] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answered = status === "answered";

  useEffect(() => {
    setText("");
    setErr(null);
  }, [m.id]);

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await conversationsApi.aiProxyAnswer(conversationId, m.id, t);
      onAnswered?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "পাঠাতে পারিনি — আবার চেষ্টা করুন।");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="self-center w-full max-w-[92%] flex flex-col gap-2 rounded-2xl border border-emerald-300/70 bg-gradient-to-br from-emerald-50 to-amber-50 px-3 py-2 text-[12px] text-slate-800 shadow-sm shadow-emerald-500/10 dark:border-emerald-500/40 dark:from-emerald-500/10 dark:to-amber-500/10 dark:text-slate-100">
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
              {m.body}
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
                  className="tap rounded-full border border-emerald-300/70 bg-white/80 px-2.5 py-1 text-[10.5px] font-semibold text-emerald-800 shadow-sm disabled:opacity-50 dark:border-emerald-500/30 dark:bg-white/10 dark:text-emerald-100"
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
