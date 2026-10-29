"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send, ShieldCheck, ImagePlus, X } from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { InitialAvatar } from "@/components/initial-avatar";
import { api, resolveMediaUrl, session, uploadImage } from "@/lib/api";
import { fetchSiteContent, type SiteContent } from "@/lib/site";

/**
 * Customer ↔ MediDoor Admin support thread.
 *
 * Backend parity with the website messenger dock "Admin support" contact:
 *   GET  /api/customer/me/admin-thread          → { items: [...] }
 *   POST /api/customer/me/admin-thread          → send a reply
 *
 * A message's `direction` is either "admin_to_customer" (left bubble) or
 * "customer_to_admin" (right / brand bubble).
 */

type AdminMsg = {
  id: string;
  direction: "admin_to_customer" | "customer_to_admin";
  body: string | null;
  attachment_url: string | null;
  attachment_mime: string | null;
  is_read: boolean;
  created_at: string | null;
};

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function SupportPage() {
  const router = useRouter();
  const [items, setItems] = useState<AdminMsg[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState<SiteContent | null>(null);
  const [pending, setPending] = useState<{ url: string; mime: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const admin = site?.admin_support;
  const adminName = admin?.name || "MediDoor Admin";
  const adminTagline = admin?.tagline || "Verification & support";
  const adminAvatar = resolveMediaUrl(admin?.avatar_url) || null;

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: AdminMsg[] }>("/api/customer/me/admin-thread");
      setItems(r.items || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => {
    if (!session.access()) {
      router.replace("/login?role=customer&next=/support");
      return;
    }
    fetchSiteContent().then(setSite).catch(() => setSite(null));
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [router, load]);

  // Auto-scroll to the newest reply. NOTE: `scrollRef`'s div does not scroll —
  // `.app-scroll` is this app's only scroller, so scrolling the inner div was
  // a silent no-op that left every new message below the fold.
  useEffect(() => {
    const el = scrollRef.current?.closest<HTMLElement>(".app-scroll");
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  const pickImage = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const url = await uploadImage(file);
      setPending({ url, mime: file.type || "image/jpeg" });
    } catch {
      setError("ছবি আপলোড হয়নি — আবার চেষ্টা করুন।");
    } finally {
      setUploading(false);
    }
  };

  const send = async () => {
    const body = text.trim();
    if ((!body && !pending) || busy) return;
    setBusy(true);
    setError(null);
    // Optimistic bubble
    const optimistic: AdminMsg = {
      id: `tmp-${Date.now()}`,
      direction: "customer_to_admin",
      body: body || null,
      attachment_url: pending?.url || null,
      attachment_mime: pending?.mime || null,
      is_read: false,
      created_at: new Date().toISOString(),
    };
    setItems((m) => [...(m || []), optimistic]);
    setText("");
    const attach = pending;
    setPending(null);
    try {
      await api("/api/customer/me/admin-thread", {
        method: "POST",
        body: JSON.stringify({
          body,
          attachment_url: attach?.url || null,
          attachment_mime: attach?.mime || null,
        }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Message পাঠানো যায়নি");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <MobileHeader
        back
        title={
          <span className="flex items-center gap-2">
            <InitialAvatar name={adminName} src={adminAvatar} size={26} />
            <span className="truncate">{adminName}</span>
            <ShieldCheck size={14} className="shrink-0 text-brand-500" />
          </span>
        }
        subtitle={adminTagline}
      />

      <div
        ref={scrollRef}
        className="flex flex-col gap-2 px-3 pb-40 pt-2"
        style={{ minHeight: "calc(100dvh - 200px)" }}
      >
        {/* Intro / empty state */}
        {items && items.length === 0 && (
          <div className="mx-auto mt-4 max-w-[320px] rounded-2xl border border-slate-200 bg-white p-4 text-center dark:border-white/10 dark:bg-white/[0.04]">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
              <ShieldCheck size={22} />
            </div>
            <p className="mt-2 text-sm font-semibold">MediDoor সাপোর্ট টিম</p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              অর্ডার, রিফান্ড, অ্যাকাউন্ট বা যেকোনো সমস্যা — এখানে সরাসরি MediDoor
              admin-কে লিখুন। আমরা দ্রুত উত্তর দেব।
            </p>
          </div>
        )}

        {!items && !error && (
          <div className="flex items-center justify-center gap-2 p-8 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        )}

        {items?.map((m) => {
          const mine = m.direction === "customer_to_admin";
          return (
            <div
              key={m.id}
              className={`flex items-end gap-1.5 ${mine ? "justify-end" : "justify-start"}`}
            >
              {!mine && (
                <div className="mb-0.5 shrink-0">
                  <InitialAvatar name={adminName} src={adminAvatar} size={26} />
                </div>
              )}
              <div
                className={[
                  "max-w-[78%] overflow-hidden rounded-2xl text-[13px] leading-snug",
                  mine
                    ? "rounded-br-sm bg-brand-500 text-white"
                    : "rounded-bl-sm bg-slate-100 text-slate-900 dark:bg-white/[0.06] dark:text-slate-100",
                ].join(" ")}
              >
                {m.attachment_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={resolveMediaUrl(m.attachment_url)}
                    alt="attachment"
                    className="max-h-60 w-full object-cover"
                  />
                )}
                {m.body && <p className="whitespace-pre-wrap px-3 py-2">{m.body}</p>}
                <p
                  className={`px-3 pb-1.5 text-[9px] ${
                    mine ? "text-white/70" : "text-slate-400"
                  }`}
                >
                  {fmtTime(m.created_at)}
                </p>
              </div>
            </div>
          );
        })}

        {error && <p className="px-2 text-[11px] text-rose-500">{error}</p>}
      </div>

      {/* Composer */}
      <div
        className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200/60 bg-white/95 backdrop-blur-md dark:border-white/10 dark:bg-[#070b12]/95"
        style={{
          paddingBottom: "calc(var(--safe-bottom) + var(--bottom-nav-h) + 8px)",
          paddingTop: 8,
          paddingLeft: "calc(var(--safe-left) + 8px)",
          paddingRight: "calc(var(--safe-right) + 8px)",
        }}
      >
        <div className="mx-auto max-w-[480px]">
          {pending && (
            <div className="mb-1.5 flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-2 py-1.5 text-[11px] dark:border-white/10 dark:bg-white/[0.04]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={resolveMediaUrl(pending.url)} alt="preview" className="h-9 w-9 rounded-lg object-cover" />
              <span className="flex-1 truncate text-slate-500">ছবি যুক্ত হয়েছে</span>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="grid h-6 w-6 place-items-center rounded-full bg-slate-100 text-slate-500 dark:bg-white/10"
              >
                <X size={13} />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2 rounded-3xl border border-slate-200 bg-white px-2 py-1.5 dark:border-white/10 dark:bg-white/[0.04]">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => pickImage(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              aria-label="Attach image"
              className="tap grid h-9 w-9 shrink-0 place-items-center rounded-full text-slate-500 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-white/5"
            >
              {uploading ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={18} />}
            </button>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="MediDoor admin-কে লিখুন…"
              rows={1}
              className="min-h-[36px] max-h-32 min-w-0 flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-slate-400"
            />
            <button
              type="button"
              onClick={send}
              disabled={(!text.trim() && !pending) || busy}
              aria-label="Send"
              className="tap grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-500 text-white disabled:opacity-40"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
