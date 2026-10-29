"use client";

/**
 * Interactive Smart-Rx handshake card for the customer mobile app.
 *
 * Renders 5 preset_keys:
 *   - ai_handshake               → violet "stock check sent" card with the
 *                                  prescription image + items list +
 *                                  waiting status + Cancel button (customer
 *                                  can cancel before pharmacy replies).
 *   - ai_customer_confirm_prompt → emerald Final-Confirm card with
 *                                  Final-Confirm + Cancel buttons. Calls
 *                                  /api/ai/prescription-dispatch.
 *   - ai_handshake_completed     → green pill "Order placed".
 *   - ai_handshake_rejected      → rose card "Pharmacy rejected".
 *   - ai_handshake_cancelled     → grey pill.
 */
import { useMemo, useState } from "react";
import Image from "next/image";
import { Bot, Check, CheckCircle2, FileText, XCircle } from "lucide-react";
import { api, resolveMediaUrl } from "@/lib/api";
import {
  formatBDT,
  type ConversationMessage,
  type OrderPayload,
} from "@/lib/conversations";

type SendFn = (p: {
  body?: string;
  preset_key?: string | null;
  payload?: OrderPayload | null;
}) => void;

type HandshakePayload = {
  handshake_id?: string;
  items?: Array<{
    medicine_id?: string;
    name: string;
    qty: number;
    unit_price: number;
    rx_strength?: string | null;
  }>;
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
  pharmacy_reason?: string;
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
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // The handshake is resolved (no further action possible) if a later
  // completed / rejected / cancelled message refers to the same handshake_id.
  const resolved = useMemo(() => allMessages.some((x) => {
    if (!x.preset_key) return false;
    if (
      x.preset_key !== "ai_handshake_completed" &&
      x.preset_key !== "ai_handshake_rejected" &&
      x.preset_key !== "ai_handshake_cancelled"
    ) {
      return false;
    }
    const p = (x.payload || {}) as unknown as { handshake_id?: string };
    return (
      p.handshake_id === handshakeId &&
      new Date(x.created_at ?? 0).getTime() > new Date(msg.created_at ?? 0).getTime()
    );
  }), [allMessages, handshakeId, msg.created_at]);

  // For ai_handshake: has the pharmacy already replied (confirm prompt or reject)?
  const pharmacyReplied = useMemo(() => allMessages.some((x) => {
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

  // ---- pills ----
  if (msg.preset_key === "ai_handshake_completed") {
    return (
      <div className="my-2 flex justify-center">
        <div className="max-w-[90%] rounded-full bg-emerald-500/15 px-3 py-1 text-center text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
          ✅ অর্ডার হয়েছে — ফার্মেসি এখন প্যাকিং করবে।
        </div>
      </div>
    );
  }
  if (msg.preset_key === "ai_handshake_rejected") {
    return (
      <div className="my-2 flex justify-center">
        <div className="max-w-[90%] rounded-2xl border border-rose-300/50 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-center text-[11px] text-rose-700 dark:text-rose-200">
          <p className="mb-0.5 font-semibold">❌ ফার্মেসিতে স্টক নেই</p>
          {payload.pharmacy_reason && <p className="opacity-80">{normalizeHandshakeText(payload.pharmacy_reason)}</p>}
          <p className="mt-1 opacity-70">অন্য ফার্মেসি চেষ্টা করতে Smart Prescription আবার চালান।</p>
        </div>
      </div>
    );
  }
  if (msg.preset_key === "ai_handshake_cancelled") {
    const isTimeout = Boolean((payload as { timeout?: boolean }).timeout);
    // Prefer the server-provided body (richer context) over a generic
    // "Order cancelled" so customers can tell apart timeout vs explicit
    // cancellation vs order-page cancel. Falls back when body is empty.
    const label = normalizeHandshakeText(msg.body) || "🚫 অর্ডার বাতিল হয়েছে";
    return (
      <div className="my-2 flex justify-center">
        <div className={`max-w-[90%] rounded-2xl px-3 py-1.5 text-center text-[11px] font-semibold ${
          isTimeout
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
            : "bg-slate-500/15 text-slate-600 dark:text-slate-300"
        }`}>
          {label}
        </div>
      </div>
    );
  }

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

  const rxUrl = payload.prescription_url || msg.attachment_url;
  const splitLabel =
    payload.split_part && payload.split_total
      ? ` (${payload.split_part}/${payload.split_total})`
      : "";

  // ---- ai_handshake — sent, waiting for pharmacy ----
  if (msg.preset_key === "ai_handshake") {
    return (
      <div className="my-2 flex justify-center">
        <div className="w-full max-w-[94%] rounded-2xl border-2 border-violet-400/60 bg-gradient-to-br from-violet-50 to-fuchsia-50 dark:from-violet-950/40 dark:to-fuchsia-950/30 p-3 text-[12px] text-slate-900 dark:text-slate-50 shadow-md shadow-violet-500/15">
          <div className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold text-violet-700 dark:text-violet-200">
            <Bot size={14} /> medi AI — স্টক যাচাই পাঠানো হয়েছে{splitLabel}
          </div>
          {rxUrl && (
            <div className="mb-2 overflow-hidden rounded-xl ring-1 ring-violet-300/50">
              <div className="flex items-center gap-1 bg-violet-500/10 px-2 py-1 text-[10px] font-bold text-violet-700 dark:text-violet-200">
                <FileText size={11} /> প্রেসক্রিপশন
              </div>
              <div className="relative h-36 w-full bg-black/10">
                <Image
                  src={resolveMediaUrl(rxUrl)}
                  alt="prescription"
                  fill
                  sizes="360px"
                  className="object-cover"
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
                    {it.rx_strength && <span className="opacity-60"> ({it.rx_strength})</span>}{" "}
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
          {!resolved && !pharmacyReplied && (
            <>
              <p className="mb-2 text-center text-[11px] text-violet-700 dark:text-violet-300">
                ফার্মেসি স্টক যাচাই করছে — উত্তর আসা পর্যন্ত অপেক্ষা করুন।
              </p>
              <button
                onClick={cancelOrder}
                disabled={busy}
                className="tap w-full rounded-full bg-rose-500/10 px-3 py-1.5 text-[12px] font-semibold text-rose-700 dark:text-rose-300 disabled:opacity-50"
              >
                <XCircle size={11} className="mr-1 inline-block" /> অর্ডার বাতিল
              </button>
            </>
          )}
          {pharmacyReplied && !resolved && (
            <p className="text-center text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
              ✅ ফার্মেসি উত্তর দিয়েছে — নিচের card-এ confirm করুন।
            </p>
          )}
          {resolved && (
            <p className="text-center text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              — বন্ধ —
            </p>
          )}
        </div>
      </div>
    );
  }

  // ---- ai_customer_confirm_prompt — pharmacy OK, customer must Final-Confirm ----
  if (msg.preset_key !== "ai_customer_confirm_prompt") return null;
  const cpStatus = (payload.status ?? "") as string;
  // "confirmed" is a SUCCESS terminal state — it must never fall into the
  // cancelled bucket or the customer sees "🚫 বাতিল হয়েছে" right after a
  // successful Final Confirm.
  const cardConfirmed = cpStatus === "confirmed";
  const cardCancelled = cpStatus === "cancelled" || cpStatus === "timeout";

  const finalConfirm = async () => {
    if (busy || resolved || !handshakeId) return;
    if (!payload.prescription_url || !payload.pharmacy_id || !payload.items?.length) {
      setConfirmError("অর্ডারের তথ্য অসম্পূর্ণ — Smart Prescription window থেকে confirm করুন।");
      return;
    }
    setBusy(true);
    setConfirmError(null);
    try {
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
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : "Confirm করা যায়নি");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="my-2 flex justify-center">
      <div className="w-full max-w-[94%] rounded-2xl border-2 border-emerald-400/60 bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/40 dark:to-teal-950/30 p-3 text-[12px] text-slate-900 dark:text-slate-50 shadow-md shadow-emerald-500/15">
        <div className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold text-emerald-700 dark:text-emerald-200">
          <CheckCircle2 size={14} /> ফার্মেসি ready — final order confirm করুন
        </div>
        <p className="mb-2 text-[12px] text-slate-700 dark:text-slate-200">
          ফার্মেসি স্টক confirm করেছে। Confirm করলে 1 Smart Prescription credit কাটা হবে।
        </p>
        {payload.items && payload.items.length > 0 && (
          <ul className="mb-2 space-y-1 rounded-xl bg-white/70 dark:bg-white/5 p-2">
            {payload.items.map((it, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  <span className="font-semibold">{it.name}</span>{" "}
                  <span className="opacity-60">×{it.qty}</span>
                </span>
                <span className="tabular-nums font-semibold">
                  {formatBDT((it.unit_price || 0) * (it.qty || 0))}
                </span>
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
        {!resolved && !cardCancelled && !cardConfirmed && (
          <div className="flex flex-col gap-2">
            <button
              onClick={() => void finalConfirm()}
              disabled={busy}
              className="tap inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-emerald-600 px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
            >
              <Check size={14} /> Final Confirm — অর্ডার পাঠান
            </button>
            <button
              onClick={cancelOrder}
              disabled={busy}
              className="tap inline-flex w-full items-center justify-center gap-1 rounded-full bg-rose-500/10 px-4 py-1.5 text-[12px] font-semibold text-rose-700 dark:text-rose-300 disabled:opacity-50"
            >
              <XCircle size={11} /> অর্ডার বাতিল
            </button>
          </div>
        )}
        {(resolved || cardCancelled || cardConfirmed) && (
          <p className="text-center text-[12px] font-bold text-emerald-700 dark:text-emerald-300">
            {cardCancelled ? "🚫 বাতিল হয়েছে" : "✅ অর্ডার confirm হয়েছে"}
          </p>
        )}
      </div>
    </div>
  );
}
