"use client";

/**
 * Pharmacy chat thread — 1:1 port of mobile-pharmacy/src/app/chats/[id]/page.tsx.
 * Mirrors the customer thread but the "me" side is pharmacy. Polls every 5s,
 * marks-seen, supports text + image attachments, and exposes the FULL
 * website-parity order workflow via {@link PharmacyOrderQuickActions}:
 *
 *   pending → Confirm | Reject | Quote | Modify items
 *   confirmed → Mark Preparing
 *   preparing → Call rider
 *   rider joined → Handed to rider
 *   handed_over → "On the way…"
 *   delivered → "Delivery complete"
 *
 * Plus persistent Stock-out (cancel) + Delay (reason+ETA) issue actions
 * shown alongside every active step.
 *
 * Preset bubbles (`order_request`, `pharmacy_quote`, `order_confirm`…)
 * render as full-width tone-coded EventCards with the itemised table —
 * same payload shape as the website + customer mobile app.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
  ChevronLeft, CheckCheck, ImagePlus, Loader2, Map as MapIcon, Send, ShieldAlert,
} from "lucide-react";
import { InitialAvatar } from "@/components/pharmacy-app/initial-avatar";
import { resolveMediaUrl, session, uploadImage } from "@/lib/api";
import {
  conversationsApi, formatBDT, ORDER_PRESETS,
  type ConversationMessage, type ConversationSummary, type ConversationTrack, type OrderPayload,
} from "@/lib/conversations";
import { PharmacyOrderQuickActions } from "@/components/pharmacy-app/pharmacy-order-quick-actions";
import { HandshakeCard } from "@/components/pharmacy-app/handshake-card";

type Busy = "idle" | "uploading" | "sending";

export function PharmacyChatThreadScreen({ id }: { id: string }) {
  const router = useRouter();

  const [conv, setConv] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [track, setTrack] = useState<ConversationTrack | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    if (session.role() !== "pharmacy") { router.replace("/"); return; }
  }, [router]);

  useEffect(() => {
    if (!id) return;
    conversationsApi.list().then((all) => {
      const found = all.find((c) => c.id === id);
      if (found) setConv(found);
    }).catch(() => undefined);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let stop = false;
    const tick = async () => {
      try {
        const ms = await conversationsApi.messages(id);
        if (!stop) setMessages(ms);
        try { await conversationsApi.markSeen(id); } catch {}
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : "Load failed");
      }
    };
    tick();
    const t = setInterval(tick, 5_000);
    return () => { stop = true; clearInterval(t); };
  }, [id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

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

  const sendMessage = async (payload: {
    body?: string;
    attachment_url?: string | null;
    preset_key?: string | null;
    payload?: OrderPayload | null;
  }) => {
    if (busy !== "idle") return;
    setBusy("sending");
    try {
      const m = await conversationsApi.send(id, payload);
      setMessages((prev) => [...prev, m]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally { setBusy("idle"); }
  };

  const sendText = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    await sendMessage({ body });
  };

  const sendImage = async (file: File) => {
    setBusy("uploading");
    try {
      const url = await uploadImage(file);
      const m = await conversationsApi.send(id, { attachment_url: url });
      setMessages((prev) => [...prev, m]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally { setBusy("idle"); }
  };

  const customerLastRead = conv?.customer_last_read_at
    ? new Date(conv.customer_last_read_at).getTime()
    : 0;
  const myLastSent = [...messages].reverse().find((m) => m.sender_role === "pharmacy");
  const blocked = !!conv?.blocked_at;

  return (
    <>
      <header
        className="fixed inset-x-0 top-0 z-40 mx-auto flex max-w-[480px] items-center gap-3 border-b border-slate-200/70 bg-white/95 backdrop-blur-md dark:border-white/10 dark:bg-[#070b12]/95"
        style={{
          height: "calc(var(--header-h) + var(--safe-top))",
          paddingTop: "var(--safe-top)",
          paddingLeft: "calc(var(--safe-left) + 8px)",
          paddingRight: "calc(var(--safe-right) + 12px)",
        }}
      >
        <button
          onClick={() => router.back()}
          className="tap grid h-9 w-9 place-items-center rounded-full text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5"
          aria-label="Back"
        >
          <ChevronLeft size={20} />
        </button>
        {conv && (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <InitialAvatar
              name={conv.customer_name}
              src={resolveMediaUrl(conv.customer_avatar) || null}
              size={36}
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{conv.customer_name}</p>
              <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                {conv.rider_name ? `🛵 Rider: ${conv.rider_name}` : "কাস্টমার"}
              </p>
            </div>
            {conv.blocked_at && (
              <ShieldAlert size={14} className="ml-auto shrink-0 text-rose-500" />
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => setMapOpen((v) => !v)}
          aria-label="Toggle map"
          className={`tap grid h-9 w-9 place-items-center rounded-full ${mapOpen ? "bg-brand-500 text-white" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-white/5"}`}
        >
          <MapIcon size={16} />
        </button>
      </header>

      <div
        ref={scrollRef}
        className="absolute inset-0 overflow-y-auto px-3"
        style={{
          paddingTop: "calc(var(--header-h) + var(--safe-top) + 8px)",
          paddingBottom: "calc(140px + var(--safe-bottom))",
        }}
      >
        {error && (
          <p className="m-2 rounded-xl bg-rose-50 p-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </p>
        )}
        {mapOpen && <MapPanel track={track} />}
        {messages.map((m) => (
          <Bubble
            key={m.id}
            m={m}
            mine={m.sender_role === "pharmacy"}
            allMessages={messages}
            onAction={(p) => void sendMessage(p)}
            seen={
              m.sender_role === "pharmacy" &&
              myLastSent?.id === m.id &&
              !!m.created_at &&
              new Date(m.created_at).getTime() <= customerLastRead
            }
          />
        ))}
      </div>

      <div
        className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-[480px] border-t border-slate-200/70 bg-white/95 backdrop-blur-md dark:border-white/10 dark:bg-[#070b12]/95"
        style={{
          paddingBottom: "var(--safe-bottom)",
          paddingLeft: "var(--safe-left)",
          paddingRight: "var(--safe-right)",
        }}
      >
        {blocked ? (
          <div className="border-t border-rose-300/40 bg-rose-50 p-3 text-[12px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">
            <div className="mb-1 flex items-center gap-1.5 font-bold">
              🛡️ medi AI chat lock করেছে
            </div>
            <div className="opacity-90">
              {conv?.block_reason || "নিরাপত্তা নীতি ভঙ্গের জন্য এই chat বন্ধ রাখা হয়েছে।"}
            </div>
          </div>
        ) : (
          conv && (
            <PharmacyOrderQuickActions
              pharmacyId={conv.pharmacy_id}
              hasRider={!!conv.rider_id}
              messages={messages}
              busy={busy === "sending"}
              onSend={(p) => void sendMessage(p)}
            />
          )
        )}
        <div className="flex items-end gap-1.5 px-2 py-2">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={blocked || busy !== "idle"}
            className="tap grid h-10 w-10 shrink-0 place-items-center rounded-full text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-white/5"
            aria-label="Attach image"
          >
            {busy === "uploading" ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} />}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) sendImage(f);
              e.target.value = "";
            }}
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
            }}
            disabled={blocked}
            rows={1}
            placeholder={blocked ? "চ্যাট বন্ধ" : "বার্তা লিখুন…"}
            className="min-h-[40px] max-h-[120px] flex-1 resize-none rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400 disabled:opacity-50 dark:border-white/10 dark:bg-white/5"
          />
          <button
            disabled={!text.trim() || busy !== "idle" || blocked}
            onClick={sendText}
            className="tap grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-500 text-white disabled:opacity-50"
            aria-label="Send"
          >
            {busy === "sending" ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </>
  );
}

function Bubble({
  m, mine, seen, allMessages, onAction,
}: {
  m: ConversationMessage;
  mine: boolean;
  seen: boolean;
  allMessages: ConversationMessage[];
  onAction: (p: { body?: string; preset_key?: string | null; payload?: OrderPayload | null }) => void;
}) {
  // Smart-Rx handshake family → interactive card with Accept/Reject buttons.
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
  if (m.sender_role === "system" || m.preset_key) {
    return <EventCard m={m} />;
  }
  return (
    <div className={`my-1 flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[78%] rounded-2xl px-3 py-2 text-sm",
          mine
            ? "bg-brand-500 text-white"
            : "bg-slate-100 text-slate-900 dark:bg-white/[0.07] dark:text-slate-100",
        ].join(" ")}
      >
        {m.attachment_url && (
          <Image
            src={resolveMediaUrl(m.attachment_url)}
            alt=""
            width={220}
            height={220}
            className="mb-1 rounded-xl object-cover"
            unoptimized
          />
        )}
        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
        {mine && (
          <div className="mt-0.5 flex items-center justify-end gap-0.5 text-[10px] opacity-70">
            <CheckCheck size={11} className={seen ? "text-cyan-200" : ""} />
            {seen && <span>দেখেছেন</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function EventCard({ m }: { m: ConversationMessage }) {
  const tone = pickTone(m.preset_key);
  const items = m.payload?.items;
  const title = eventTitle(m);
  const body = normalizeEventBody(m.body);
  const showBody = Boolean(body && shouldShowEventBody(m));
  return (
    <div className="my-2 flex w-full justify-center">
      <div className={`w-full max-w-[92%] rounded-2xl border px-3 py-2 text-[12px] font-medium ${tone}`}>
        {title && <p className="font-extrabold leading-snug">{title}</p>}
        {showBody && (
          <p className={`${title ? "mt-1 opacity-90" : ""} whitespace-pre-wrap break-words leading-snug`}>{body}</p>
        )}
        {items && items.length > 0 && <ItemTable payload={m.payload!} />}
        {m.attachment_url && (
          <div className="relative mt-2 h-40 w-full overflow-hidden rounded-xl bg-black/10">
            <Image
              src={resolveMediaUrl(m.attachment_url)}
              alt="prescription"
              fill
              sizes="360px"
              className="object-cover"
              unoptimized
            />
          </div>
        )}
      </div>
    </div>
  );
}

function eventTitle(m: ConversationMessage): string | null {
  const total = m.payload?.total != null ? ` — মোট ${formatBDT(m.payload.total)}` : "";
  switch (m.preset_key) {
    case ORDER_PRESETS.request:
      return `📦 Customer-এর অর্ডার request${total}`;
    case ORDER_PRESETS.quote:
      return `🧾 Quote পাঠানো হয়েছে${total}`;
    case ORDER_PRESETS.confirm:
      return `✅ অর্ডার confirm হয়েছে${total}`;
    case ORDER_PRESETS.reject:
      return "❌ অর্ডার বাতিল হয়েছে";
    case ORDER_PRESETS.delay:
      return "⏱️ দেরির notice";
    case ORDER_PRESETS.status_preparing:
      return "🟢 অর্ডার প্যাকিং চলছে";
    case ORDER_PRESETS.call_rider:
      return "📞 Rider খোঁজা হচ্ছে";
    case ORDER_PRESETS.rider_joined:
      return "🛵 Rider chat-এ যুক্ত হয়েছে";
    case "rider_left":
      return "🛵 Rider chat থেকে বের হয়েছে";
    case ORDER_PRESETS.handed_over:
      return "🤝 Rider-কে medicine দেওয়া হয়েছে";
    case ORDER_PRESETS.status_on_the_way:
      return "🛵 Rider পথে আছে";
    case ORDER_PRESETS.delivery_complete:
    case ORDER_PRESETS.status_delivered:
      return "✅ ডেলিভারি সম্পন্ন";
    case ORDER_PRESETS.rating_submitted:
      return "⭐ Customer rating দিয়েছেন";
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
    .replace(/Timeout — pharmacy did not respond within 5 min\.?/gi, "সময় শেষ — ফার্মেসি ৫ মিনিটের মধ্যে উত্তর দেয়নি।")
    .replace(/Test stock-check close/gi, "স্টক যাচাই বন্ধ করা হয়েছে")
    .replace(/Stock check close/gi, "স্টক যাচাই বন্ধ করা হয়েছে")
    .replace(/800m-er moddhe sob rider-ke offer pathano hocche/gi, "আশেপাশের সব rider-কে offer পাঠানো হচ্ছে")
    .replace(/Order confirm/g, "অর্ডার confirm")
    .replace(/Order cancel/g, "অর্ডার বাতিল")
    .replace(/order cancel/g, "অর্ডার বাতিল")
    .replace(/Note:/g, "নোট:")
    .replace(/_Note:_/g, "_নোট:_");
}

function ItemTable({ payload }: { payload: OrderPayload }) {
  const subtotal =
    Number(payload.subtotal) ||
    payload.items.reduce(
      (s, it) => s + Number(it.unit_price || 0) * Number(it.qty || 0), 0,
    );
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
                <p className="truncate text-[11px] font-semibold leading-tight">{it.name}</p>
                <p className="text-[10px] opacity-70">{formatBDT(unit)} × {qty}</p>
              </div>
              <p className="shrink-0 text-[11px] font-bold tabular-nums">{formatBDT(unit * qty)}</p>
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
    case "rider_left":
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

// Live order map panel (mirrors mobile-customer MapPanel for parity).
// Renders an OSM iframe centred on whichever of pharmacy / customer / rider
// coordinates are currently available, with a "Open full map" link.
function MapPanel({ track }: { track: ConversationTrack | null }) {
  if (!track) {
    return (
      <div className="m-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-center text-[11px] text-slate-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-400">
        Map loading…
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
      <div className="m-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-center text-[11px] text-slate-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-400">
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
    <div className="m-2 overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-white/[0.04]">
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
          Full map খুলুন ↗
        </a>
      </div>
    </div>
  );
}
