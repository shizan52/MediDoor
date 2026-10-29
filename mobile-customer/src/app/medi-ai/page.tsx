"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Loader2, Send, Sparkles } from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { API_URL, session } from "@/lib/api";

type Msg = { role: "user" | "assistant"; content: string };
const KEY = "medidoor_medi_ai_chat";

/**
 * medi AI bot chat. Same backend route as the website (`/api/ai/chat`),
 * mobile-tuned UI. No auth required.
 */
export default function MediAIPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) setMessages(JSON.parse(raw));
    } catch {}
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(KEY, JSON.stringify(messages.slice(-12))); } catch {}
    // Scroll the REAL scroller: `scrollRef`'s div doesn't scroll (`.app-scroll`
    // does), so scrolling it was a no-op and medi AI's reply stayed below the
    // fold until the user scrolled by hand.
    const el = scrollRef.current?.closest<HTMLElement>(".app-scroll");
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    const next: Msg[] = [...messages, { role: "user", content: body }];
    setMessages(next);
    setText("");
    setBusy(true);
    setError(null);
    try {
      const token = session.access();
      const res = await fetch(`${API_URL}/api/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ messages: next.slice(-10) }),
      });
      if (res.status === 401) {
        throw new Error("Free medi AI chat শেষ — আরও chat করতে login করুন।");
      }
      if (!res.ok) {
        throw new Error("medi AI এখন উত্তর দিতে পারছে না — একটু পরে আবার চেষ্টা করুন।");
      }
      const data = (await res.json()) as { reply: string };
      setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <MobileHeader title="medi AI" subtitle="Bengali health assistant" back />

      <div ref={scrollRef} className="flex flex-col gap-2 px-3 pb-32 pt-2" style={{ minHeight: "calc(100dvh - 200px)" }}>
        {messages.length === 0 && (
          <div className="mx-auto mt-4 max-w-[300px] rounded-2xl border border-slate-200 bg-white p-4 text-center dark:border-white/10 dark:bg-white/[0.04]">
            <Sparkles size={22} className="mx-auto text-brand-500" />
            <p className="mt-2 text-sm font-semibold">কেমন আছেন?</p>
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              আপনার সমস্যার কথা বাংলায় বলুন — কোন pharmacy বা medicine লাগলে সেটাও জিজ্ঞেস করতে পারেন।
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex items-end gap-1.5 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            {m.role === "assistant" && (
              // Brand chip so customers visually recognise the AI side
              // — mirrors the website's medi-ai chat avatar.
              <div className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full bg-brand-500 ring-1 ring-brand-500/30">
                <Image src="/brand/logo-inside.png" alt="medi AI" width={20} height={20} />
              </div>
            )}
            <div
              className={[
                "max-w-[78%] rounded-2xl px-3 py-2 text-[13px] leading-snug",
                m.role === "user"
                  ? "rounded-br-sm bg-brand-500 text-white"
                  : "rounded-bl-sm bg-slate-100 text-slate-900 dark:bg-white/[0.06] dark:text-slate-100",
              ].join(" ")}
            >
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <p className="self-start pl-9 text-[11px] text-slate-400">
            <Loader2 size={12} className="-mt-0.5 mr-1 inline animate-spin" /> medi AI ভাবছে…
          </p>
        )}
        {error && <p className="text-[11px] text-rose-500">{error}</p>}
      </div>

      <div
        className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200/60 bg-white/95 backdrop-blur-md dark:border-white/10 dark:bg-[#070b12]/95"
        style={{
          paddingBottom: "calc(var(--safe-bottom) + var(--bottom-nav-h) + 8px)",
          paddingTop: 8,
          paddingLeft: "calc(var(--safe-left) + 8px)",
          paddingRight: "calc(var(--safe-right) + 8px)",
        }}
      >
        <div className="mx-auto flex max-w-[480px] items-end gap-2 rounded-3xl border border-slate-200 bg-white px-2 py-1.5 dark:border-white/10 dark:bg-white/[0.04]">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="medi AI কে কিছু জিজ্ঞেস করুন…"
            rows={1}
            className="min-h-[36px] max-h-32 min-w-0 flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-slate-400"
          />
          <button
            type="button"
            onClick={send}
            disabled={!text.trim() || busy}
            aria-label="Send"
            className="tap grid h-9 w-9 place-items-center rounded-full bg-brand-500 text-white disabled:opacity-40"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={15} />}
          </button>
        </div>
      </div>
    </>
  );
}
