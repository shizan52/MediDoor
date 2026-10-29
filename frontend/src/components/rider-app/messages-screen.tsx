"use client";

/**
 * Rider <-> MediDoor admin two-way message thread — 1:1 port of
 * mobile-rider/src/app/messages/page.tsx.
 *
 * The rider can read every admin message in chronological order and reply
 * directly. Backed by `/api/rider/me/admin-thread` (GET + POST). Polled
 * every 8s while the page is visible so admin replies appear without a
 * manual refresh.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Paperclip, RefreshCw, Send, ShieldAlert } from "lucide-react";
import { API_URL, api, session } from "@/lib/api";

type Msg = {
  id: string;
  direction: "admin_to_rider" | "rider_to_admin";
  body: string;
  attachment_url?: string | null;
  attachment_mime?: string | null;
  is_read: boolean;
  created_at: string | null;
};
type ListResp = { items: Msg[] };

function fmtClock(iso: string | null): string {
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

export function RiderMessagesScreen() {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (scroll = false) => {
    try {
      const r = await api<ListResp>("/api/rider/me/admin-thread");
      setMsgs(r.items || []);
      setError(null);
      if (scroll) {
        requestAnimationFrame(() => {
          if (scroller.current) {
            scroller.current.scrollTop = scroller.current.scrollHeight;
          }
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
      setMsgs((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => { void load(true); }, [load]);

  // Poll every 8s for admin replies.
  useEffect(() => {
    const t = setInterval(() => { void load(false); }, 8000);
    return () => clearInterval(t);
  }, [load]);

  // Auto-scroll to bottom when message list changes length.
  const lastLenRef = useRef(0);
  useEffect(() => {
    if (!msgs) return;
    if (msgs.length !== lastLenRef.current) {
      lastLenRef.current = msgs.length;
      requestAnimationFrame(() => {
        if (scroller.current) {
          scroller.current.scrollTop = scroller.current.scrollHeight;
        }
      });
    }
  }, [msgs]);

  const send = async (attachment?: { url: string; mime?: string | null }) => {
    const body = draft.trim();
    if ((!body && !attachment?.url) || sending) return;
    setSending(true);
    try {
      await api("/api/rider/me/admin-thread", {
        method: "POST",
        body: JSON.stringify({
          body,
          attachment_url: attachment?.url || null,
          attachment_mime: attachment?.mime || null,
        }),
      });
      setDraft("");
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  };

  const uploadAndSend = async (file: File) => {
    if (sending || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const headers: HeadersInit = {};
      const token = session.access();
      if (token) (headers as Record<string, string>).Authorization = `Bearer ${token}`;
      const res = await fetch(`${API_URL}/api/upload`, { method: "POST", body: fd, headers });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { url: string; mime?: string };
      await send({ url: data.url, mime: data.mime || file.type || null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <main className="flex h-[100dvh] flex-col bg-[#f4f5f7]">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3 shadow-sm">
        <Link href="/rider" className="rounded-full p-1 hover:bg-zinc-100" aria-label="Back">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100">
          <ShieldAlert size={18} className="text-emerald-700" />
        </div>
        <div className="flex-1 leading-tight">
          <div className="text-sm font-bold text-zinc-900">MediDoor Admin</div>
          <div className="text-[11px] text-zinc-500">Verification & support</div>
        </div>
        <button
          onClick={() => void load(true)}
          className="rounded-full p-1 text-zinc-500 hover:bg-zinc-100"
          aria-label="Refresh"
        >
          <RefreshCw size={18} />
        </button>
      </header>

      {/* Thread */}
      <div ref={scroller} className="flex-1 overflow-y-auto px-3 py-4">
        {msgs === null ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Loading…
          </div>
        ) : msgs.length === 0 ? (
          <div className="mx-auto mt-12 max-w-xs rounded-2xl border border-zinc-200 bg-white p-6 text-center">
            <ShieldAlert size={32} className="mx-auto mb-3 text-emerald-600" />
            <div className="text-sm font-bold text-zinc-900">কোনও message নেই</div>
            <p className="mt-2 text-xs leading-relaxed text-zinc-600">
              MediDoor admin আপনাকে message পাঠালে এখানে আসবে। আপনি চাইলে এখানেই
              admin কে question বা reply পাঠাতে পারেন।
            </p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {msgs.map((m) => {
              const mine = m.direction === "rider_to_admin";
              return (
                <li
                  key={m.id}
                  className={`flex ${mine ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 shadow-sm ${
                      mine
                        ? "rounded-br-md bg-emerald-600 text-white"
                        : "rounded-bl-md border border-zinc-200 bg-white text-zinc-900"
                    }`}
                  >
                    {!mine && (
                      <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                        MediDoor Admin
                      </div>
                    )}
                    <div className="whitespace-pre-line text-[13px] leading-snug">
                      {m.body || "(attachment)"}
                    </div>
                    {m.attachment_url && (
                      <AdminAttachment url={m.attachment_url} mime={m.attachment_mime} mine={mine} />
                    )}
                    <div
                      className={`mt-1 text-right text-[10px] ${
                        mine ? "text-emerald-100" : "text-zinc-400"
                      }`}
                    >
                      {fmtClock(m.created_at)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-zinc-200 bg-white px-3 py-2.5 pb-[max(env(safe-area-inset-bottom),12px)]">
        <div className="flex items-end gap-2">
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
            disabled={sending || uploading}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-100 text-zinc-600 disabled:opacity-40"
            aria-label="Attach image or PDF"
          >
            {uploading ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
          </button>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Admin কে কিছু লিখুন…"
            rows={1}
            className="flex-1 resize-none rounded-2xl border border-zinc-300 bg-white px-3 py-2 text-[13px] outline-none focus:border-emerald-500"
            style={{ maxHeight: 120 }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            onClick={() => void send()}
            disabled={sending || !draft.trim()}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-600 text-white shadow disabled:opacity-40"
            aria-label="Send"
          >
            <Send size={18} />
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-zinc-400">
          Enter = send · Shift+Enter = নতুন line
        </p>
      </div>
    </main>
  );
}

function AdminAttachment({ url, mime, mine }: { url: string; mime?: string | null; mine: boolean }) {
  const lower = url.toLowerCase();
  const isPdf = (mime || "").includes("pdf") || lower.endsWith(".pdf");
  const isImage = (mime || "").startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(lower);
  const label = decodeURIComponent((url.split("/").pop() || "attachment").slice(0, 44));

  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="mt-2 block overflow-hidden rounded-xl border border-white/40 bg-black/5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="attachment" className="max-h-44 w-full object-cover" />
      </a>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={`mt-2 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ${
        mine ? "border-white/40 bg-white/15 text-white" : "border-zinc-200 bg-zinc-50 text-zinc-700"
      }`}
    >
      <Paperclip size={14} />
      <span className="min-w-0 flex-1 truncate">{isPdf ? "PDF" : "Attachment"}: {label}</span>
    </a>
  );
}
