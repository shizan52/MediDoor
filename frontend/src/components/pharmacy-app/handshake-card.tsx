"use client";

/**
 * Interactive Smart-Rx handshake card for the pharmacy mobile app.
 *
 * Renders 5 preset_keys with proper action UI:
 *   - ai_handshake               → big violet "Stock check" card with the
 *                                  prescription image + itemised stock
 *                                  list + Accept/Reject buttons.
 *   - ai_customer_confirm_prompt → emerald pill "Customer is final-confirming…"
 *   - ai_handshake_completed     → green pill "Customer confirmed — pack now."
 *   - ai_handshake_rejected      → rose pill "Stock rejected by pharmacy."
 *   - ai_handshake_cancelled     → grey pill "Customer cancelled."
 *
 * Without this card the system messages would render as a plain text bubble
 * (no action buttons), which is why pharmacy mobile users couldn't respond
 * to a Smart Prescription handshake at all.
 */
import { useMemo, useState } from "react";
import Image from "next/image";
import { Bot, Check, CheckCircle2, FileText, XCircle } from "lucide-react";
import { resolveMediaUrl } from "@/lib/api";
import {
  formatBDT,
  type ConversationMessage,
  type OrderPayload,
} from "@/lib/conversations";

type SendFn = (p: {
  body?: string;
  preset_key?: string;
  payload?: OrderPayload | null;
}) => void;

type HandshakePayload = {
  handshake_id?: string;
  items?: Array<{
    name: string;
    qty: number;
    unit_price: number;
    rx_strength?: string | null;
  }>;
  subtotal?: number;
  delivery_fee?: number;
  total?: number;
  prescription_url?: string | null;
  pharmacy_name?: string;
  pharmacy_reason?: string;
  status?: string;
  split_part?: number | null;
  split_total?: number | null;
};

function normalizeHandshakeText(text?: string | null): string {
  return (text || "")
    .trim()
    .replace(/Timeout — pharmacy did not respond within 5 min\.?/gi, "সময় শেষ — ফার্মেসি ৫ মিনিটের মধ্যে উত্তর দেয়নি।")
    .replace(/Test stock-check close/gi, "স্টক যাচাই বন্ধ করা হয়েছে")
    .replace(/Stock check close/gi, "স্টক যাচাই বন্ধ করা হয়েছে");
}

export function HandshakeCard({
  msg,
  allMessages,
  onAction,
}: {
  msg: ConversationMessage;
  allMessages: ConversationMessage[];
  onAction: SendFn;
}) {
  const payload = (msg.payload || {}) as unknown as HandshakePayload;
  const handshakeId = payload.handshake_id || "";
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectText, setRejectText] = useState("");
  const [busy, setBusy] = useState(false);

  const pharmacyResponded = useMemo(() => allMessages.some((x) => {
    if (!x.preset_key) return false;
    if (
      x.preset_key !== "ai_customer_confirm_prompt" &&
      x.preset_key !== "ai_handshake_rejected"
    ) {
      return false;
    }
    const p = (x.payload || {}) as unknown as { handshake_id?: string };
    return (
      p.handshake_id === handshakeId &&
      new Date(x.created_at ?? 0).getTime() > new Date(msg.created_at ?? 0).getTime()
    );
  }), [allMessages, handshakeId, msg.created_at]);

  // ---- pill states ----
  if (msg.preset_key === "ai_handshake_completed") {
    return (
      <div className="my-2 flex justify-center">
        <div className="max-w-[88%] rounded-full bg-emerald-500/15 px-3 py-1 text-center text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
          ✅ Customer final confirm করেছে — অর্ডার হয়েছে। এখন প্যাকিং শুরু করুন।
        </div>
      </div>
    );
  }
  if (msg.preset_key === "ai_handshake_rejected") {
    return (
      <div className="my-2 flex justify-center">
        <div className="max-w-[88%] rounded-2xl border border-rose-300/50 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-center text-[11px] text-rose-700 dark:text-rose-200">
          <p className="font-semibold mb-0.5">❌ স্টক reject করা হয়েছে</p>
          {payload.pharmacy_reason && <p className="opacity-80">{normalizeHandshakeText(payload.pharmacy_reason)}</p>}
        </div>
      </div>
    );
  }
  if (msg.preset_key === "ai_handshake_cancelled") {
    const isTimeout = Boolean((payload as { timeout?: boolean }).timeout);
    const label = normalizeHandshakeText(msg.body) || "🚫 Customer অর্ডার বাতিল করেছে";
    return (
      <div className="my-2 flex justify-center">
        <div className={`max-w-[88%] rounded-2xl px-3 py-1.5 text-center text-[11px] font-semibold ${
          isTimeout
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
            : "bg-slate-500/15 text-slate-600 dark:text-slate-300"
        }`}>
          {label}
        </div>
      </div>
    );
  }
  if (msg.preset_key === "ai_customer_confirm_prompt") {
    return (
      <div className="my-2 flex justify-center">
        <div className="max-w-[90%] rounded-2xl border-2 border-emerald-400/60 bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/40 dark:to-teal-950/30 px-3 py-2 text-center text-[11px] font-semibold text-emerald-700 dark:text-emerald-200">
          <CheckCircle2 size={12} className="mr-1 inline-block" />
          Customer-এর Final Confirm-এর অপেক্ষায়…
        </div>
      </div>
    );
  }

  // ---- ai_handshake (real action card) ----
  if (msg.preset_key !== "ai_handshake") return null;

  const status = (payload.status ?? "") as string;
  const cardCancelled = status === "cancelled";
  const cardTimeout = status === "timeout";
  const cardRejected = status === "rejected";
  const cardConfirmed = status === "confirmed";
  const cardClosed = cardCancelled || cardTimeout || cardRejected || cardConfirmed;
  const acceptHandshake = () => {
    if (busy || pharmacyResponded || cardClosed || !handshakeId) return;
    setBusy(true);
    onAction({
      body: "✅ সব ওষুধ available। Order confirm করতে পারেন।",
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
      payload: ({
        handshake_id: handshakeId,
        pharmacy_reason: rejectText.trim() || "Stock নেই",
      } as unknown) as OrderPayload,
    });
    setRejectOpen(false);
    setTimeout(() => setBusy(false), 600);
  };

  const rxUrl = payload.prescription_url || msg.attachment_url;
  const splitLabel =
    payload.split_part && payload.split_total
      ? ` (${payload.split_part}/${payload.split_total})`
      : "";

  return (
    <div className="my-2 flex justify-center">
      <div className="w-full max-w-[94%] rounded-2xl border-2 border-violet-400/60 bg-gradient-to-br from-violet-50 to-fuchsia-50 dark:from-violet-950/40 dark:to-fuchsia-950/30 p-3 text-[12px] text-slate-900 dark:text-slate-50 shadow-md shadow-violet-500/15">
        <div className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold text-violet-700 dark:text-violet-200">
          <Bot size={14} /> medi AI — স্টক যাচাই{splitLabel}
        </div>

        {rxUrl && (
          <div className="mb-2 overflow-hidden rounded-xl ring-1 ring-violet-300/50">
            <div className="flex items-center gap-1 bg-violet-500/10 px-2 py-1 text-[10px] font-bold text-violet-700 dark:text-violet-200">
              <FileText size={11} /> প্রেসক্রিপশন
            </div>
            <div className="relative h-40 w-full bg-black/10">
              <Image
                src={resolveMediaUrl(rxUrl)}
                alt="prescription"
                fill
                sizes="360px"
                className="object-cover"
                unoptimized
              />
            </div>
          </div>
        )}

        {payload.items && payload.items.length > 0 && (
          <ul className="mb-2 space-y-1 rounded-xl bg-white/70 dark:bg-white/5 p-2">
            {payload.items.map((it, i) => (
              <li key={i} className="flex items-start justify-between gap-2">
                <span className="truncate">
                  <span className="font-semibold">{it.name}</span>
                  {it.rx_strength && (
                    <span className="opacity-60"> ({it.rx_strength})</span>
                  )}{" "}
                  <span className="opacity-60">×{it.qty}</span>
                </span>
                <span className="tabular-nums font-semibold">
                  {formatBDT((it.unit_price || 0) * (it.qty || 0))}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="mb-2 flex items-center justify-between rounded-lg bg-violet-500/10 px-2 py-1 text-[13px] font-extrabold text-violet-800 dark:text-violet-100">
          <span>মোট</span>
          <span className="tabular-nums">{formatBDT(payload.total ?? 0)}</span>
        </div>

        {!pharmacyResponded && !cardClosed && !rejectOpen && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setRejectOpen(true)}
              disabled={busy}
              className="tap rounded-full bg-rose-500/10 px-3 py-1.5 text-[12px] font-semibold text-rose-700 dark:text-rose-300 disabled:opacity-50"
            >
              <XCircle size={11} className="mr-1 inline-block" /> Reject
            </button>
            <button
              onClick={acceptHandshake}
              disabled={busy}
              className="tap ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-600 px-4 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
            >
              <Check size={12} /> Accept — স্টক আছে
            </button>
          </div>
        )}

        {rejectOpen && (
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
                className="tap rounded-full bg-black/5 dark:bg-white/10 px-3 py-1.5 text-[12px]"
              >
                বাতিল
              </button>
              <button
                onClick={rejectHandshake}
                disabled={busy}
                className="tap ml-auto rounded-full bg-rose-600 px-4 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                Reject confirm
              </button>
            </div>
          </div>
        )}

        {pharmacyResponded && (
          <p className="text-center text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
            ✅ উত্তর পাঠানো হয়েছে
          </p>
        )}
        {cardCancelled && !pharmacyResponded && (
          <p className="text-center text-[11px] font-semibold text-slate-600 dark:text-slate-300">
            🚫 Customer বাতিল করেছে
          </p>
        )}
        {cardTimeout && !pharmacyResponded && (
          <p className="text-center text-[11px] font-semibold text-amber-700 dark:text-amber-300">
            ⏰ সময় শেষ — স্টক যাচাই বন্ধ
          </p>
        )}
      </div>
    </div>
  );
}
