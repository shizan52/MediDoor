"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bot, Send, X, Sparkles, LogIn } from "lucide-react";
import Link from "next/link";
import { API_URL, session } from "@/lib/api";

type Msg = { role: "user" | "assistant"; content: string };

const STORE_KEY = "medidoor_medi_ai_chat";

function loadStored(): Msg[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Msg[];
    return Array.isArray(parsed) ? parsed.slice(-12) : [];
  } catch {
    return [];
  }
}

export function MediAIChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages(loadStored());
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-12)));
    }
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || busy || needLogin) return;
    setInput("");
    setError(null);
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setBusy(true);
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
        // Guest free-chat allowance used up — invite to log in.
        let msg = "Free medi AI chat শেষ — আরও chat করতে login করুন।";
        try {
          const body = (await res.json()) as { detail?: { message?: string } };
          if (body?.detail?.message) msg = body.detail.message;
        } catch {
          /* ignore */
        }
        setNeedLogin(true);
        setError(msg);
        return;
      }
      if (!res.ok) {
        throw new Error("medi AI এখন উত্তর দিতে পারছে না — একটু পরে আবার চেষ্টা করুন।");
      }
      const data = (await res.json()) as { reply: string };
      setMessages([...next, { role: "assistant", content: data.reply }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <motion.button
        onClick={() => setOpen((v) => !v)}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.94 }}
        className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-brand-500 text-white shadow-xl shadow-brand-500/40 ring-2 ring-white/40 dark:ring-white/10"
        aria-label="Open medi AI"
      >
        {open ? <X size={22} /> : <Bot size={24} />}
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={{ duration: 0.18 }}
            className="fixed bottom-24 right-5 z-50 flex h-[460px] w-[min(380px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 bg-white/90 dark:bg-[#0b1018]/95 backdrop-blur-xl shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-black/5 dark:border-white/5 bg-brand-500/10 px-4 py-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500 text-white">
                <Sparkles size={16} />
              </div>
              <div>
                <p className="text-sm font-semibold leading-none">medi AI</p>
                <p className="mt-0.5 text-[11px] opacity-60">MediDoor assistant · short answers</p>
              </div>
            </div>

            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm">
              {messages.length === 0 && (
                <div className="rounded-xl bg-brand-500/5 p-3 text-[13px] opacity-80">
                  হাই! আমি <b>medi AI</b> — MediDoor সম্পর্কে কিছু জিজ্ঞাসা করুন। আমি সংক্ষেপে উত্তর দেব।
                </div>
              )}
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={
                    m.role === "user"
                      ? "ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-brand-500 px-3 py-2 text-white"
                      : "max-w-[88%] rounded-2xl rounded-bl-sm bg-black/5 dark:bg-white/5 px-3 py-2"
                  }
                >
                  {m.content}
                </div>
              ))}
              {busy && (
                <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-black/5 dark:bg-white/5 px-3 py-2 opacity-70">
                  <span className="inline-flex gap-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-200ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-100ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
                  </span>
                </div>
              )}
              {error && (
                <div className="rounded-xl border border-red-300/50 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-[12px] text-red-700 dark:text-red-300">
                  {error}
                </div>
              )}
            </div>

            {needLogin ? (
              <div className="border-t border-black/5 dark:border-white/5 bg-white/60 dark:bg-white/5 px-3 py-3">
                <Link
                  href="/login?role=customer"
                  className="flex w-full items-center justify-center gap-2 rounded-full bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
                >
                  <LogIn size={15} /> Login করে chat চালিয়ে যান
                </Link>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
                className="flex items-center gap-2 border-t border-black/5 dark:border-white/5 bg-white/60 dark:bg-white/5 px-3 py-2"
              >
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="MediDoor সম্পর্কে জিজ্ঞাসা করুন…"
                  className="flex-1 rounded-full bg-black/5 dark:bg-white/10 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500/40"
                  disabled={busy}
                />
                <button
                  type="submit"
                  disabled={busy || !input.trim()}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-500 text-white disabled:opacity-50"
                >
                  <Send size={16} />
                </button>
              </form>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
