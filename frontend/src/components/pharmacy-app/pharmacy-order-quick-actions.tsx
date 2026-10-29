"use client";

/**
 * Pharmacy-side order workflow quick actions — mobile port of the
 * website's `OrderQuickActions` (frontend/src/components/messenger-dock.tsx).
 *
 * Strict step-gating — ONE primary action at a time, plus a persistent
 * row of secondary issue actions (Stock-out / Delay) until handed over.
 *
 *   pending request → Confirm | Reject | Quote | Modify items
 *   quote sent      → (waiting for customer to accept)
 *   confirmed       → Mark Preparing
 *   preparing       → Call rider
 *   rider called    → "Waiting for rider…"
 *   rider joined    → Handed to rider
 *   handed_over     → "On the way…"
 *   delivered       → "Delivery complete"
 *
 * Multi-order safe: scopes state to messages AFTER the most recent
 * `order_request` so an old delivery_complete / rating_submitted does
 * not freeze the buttons for a brand-new order.
 */
import { useState } from "react";
import {
  Check, XCircle, Package, Bike, CheckCircle2, Receipt, Loader2,
} from "lucide-react";
import {
  ORDER_PRESETS, formatBDT,
  type ConversationMessage, type OrderPayload,
} from "@/lib/conversations";
import { PharmacyOrderComposer } from "@/components/pharmacy-app/pharmacy-order-composer";

export type SendFn = (p: {
  body?: string;
  attachment_url?: string | null;
  preset_key?: string | null;
  payload?: OrderPayload | null;
}) => void | Promise<void>;

type Status = "confirmed" | "rejected" | "preparing" | "on_the_way" | "delivered" | null;

function lastOrderState(messages: ConversationMessage[]): {
  hasOpenRequest: boolean;
  lastStatus: Status;
} {
  let hasOpenRequest = false;
  let lastStatus: Status = null;
  for (const m of messages) {
    if (m.preset_key === ORDER_PRESETS.request) hasOpenRequest = true;
    if (m.preset_key === ORDER_PRESETS.confirm || m.preset_key === ORDER_PRESETS.reject) {
      hasOpenRequest = false;
      lastStatus = m.preset_key === ORDER_PRESETS.confirm ? "confirmed" : "rejected";
    }
    if (m.preset_key === ORDER_PRESETS.status_preparing) lastStatus = "preparing";
    if (m.preset_key === ORDER_PRESETS.status_on_the_way) lastStatus = "on_the_way";
    if (m.preset_key === ORDER_PRESETS.status_delivered) lastStatus = "delivered";
    if (m.preset_key === ORDER_PRESETS.delivery_complete) lastStatus = "delivered";
  }
  return { hasOpenRequest, lastStatus };
}

export function PharmacyOrderQuickActions({
  pharmacyId,
  hasRider,
  messages,
  busy,
  onSend,
}: {
  pharmacyId: string;
  hasRider: boolean;
  messages: ConversationMessage[];
  busy?: boolean;
  onSend: SendFn;
}) {
  // Scope to latest order_request (multi-order safe).
  let lastOrderRequest = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].preset_key === ORDER_PRESETS.request) { lastOrderRequest = i; break; }
  }
  let latestHandshake = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].preset_key === "ai_handshake") { latestHandshake = i; break; }
  }
  if (latestHandshake > lastOrderRequest) {
    const smartScope = messages.slice(latestHandshake);
    const stockAccepted = smartScope.some((m) =>
      m.preset_key === "pharmacy_handshake_ok" ||
      m.preset_key === "ai_customer_confirm_prompt",
    );
    const closed = smartScope.some((m) =>
      m.preset_key === "pharmacy_handshake_reject" ||
      m.preset_key === "customer_handshake_cancel" ||
      m.preset_key === "ai_handshake_rejected" ||
      m.preset_key === "ai_handshake_cancelled" ||
      m.preset_key === "ai_handshake_completed",
    );
    if (stockAccepted && !closed) {
      return (
        <Bar>
          <Pill tone="emerald" icon={<CheckCircle2 size={11} />}>
            কাস্টমার final confirm করলে অর্ডার শুরু হবে
          </Pill>
        </Bar>
      );
    }
    if (!closed) {
      return (
        <Bar>
          <Pill tone="indigo" icon={<Loader2 size={11} className="animate-spin" />}>
            স্টক যাচাই card থেকে Confirm বা Reject দিন
          </Pill>
        </Bar>
      );
    }
    return (
      <Bar>
        <Pill tone="rose" icon={<XCircle size={11} />}>
          স্টক যাচাই শেষ — কাস্টমার নতুন request করতে পারবেন
        </Pill>
      </Bar>
    );
  }
  const scopeStart = Math.max(lastOrderRequest, 0);
  const scoped = messages.slice(scopeStart);
  const { hasOpenRequest, lastStatus } = lastOrderState(scoped);

  let calledRider = false;
  let handedOver = false;
  let deliveryDone = false;
  let riderJoinedThisOrder = false;
  for (const m of scoped) {
    if (m.preset_key === ORDER_PRESETS.call_rider) calledRider = true;
    if (m.preset_key === ORDER_PRESETS.handed_over) handedOver = true;
    if (m.preset_key === ORDER_PRESETS.delivery_complete) deliveryDone = true;
    if (m.preset_key === ORDER_PRESETS.rider_joined) riderJoinedThisOrder = true;
  }
  const riderActive = hasRider && riderJoinedThisOrder;

  const [composer, setComposer] = useState<"quote" | "modify" | null>(null);
  const [issueMode, setIssueMode] = useState<"stockout" | "delay" | null>(null);

  // Latest open request (for Modify items composer prefill).
  const openRequest = hasOpenRequest
    ? [...scoped].reverse().find((m) => m.preset_key === ORDER_PRESETS.request)
    : null;
  const openRequestItems =
    (openRequest?.payload as OrderPayload | undefined)?.items ?? null;
  const openRequestNote =
    (openRequest?.payload as OrderPayload | undefined)?.note ?? "";

  // ---------------- Render branches ----------------

  if (lastStatus === "delivered" || deliveryDone) {
    return (
      <Bar>
        <Pill tone="emerald" icon={<CheckCircle2 size={11} />}>Delivery সম্পন্ন</Pill>
      </Bar>
    );
  }

  if (lastStatus === "rejected") {
    return (
      <Bar>
        <Pill tone="rose" icon={<XCircle size={11} />}>অর্ডার বাতিল হয়েছে — কাস্টমার নতুন request পাঠাতে পারবেন</Pill>
      </Bar>
    );
  }

  if (handedOver) {
    return (
      <Bar>
        <Pill tone="purple" icon={<Bike size={11} />}>
          Rider পথে আছে — delivery confirmation-এর অপেক্ষা
        </Pill>
      </Bar>
    );
  }

  if (riderActive) {
    return (
      <>
        <Bar>
          <Btn
            tone="purple"
            disabled={busy}
            onClick={() => onSend({
              body: "🤝 Medicine rider-কে hand over করা হয়েছে।",
              preset_key: ORDER_PRESETS.handed_over,
            })}
          >
            <Bike size={12} /> Rider-কে দিন
          </Btn>
          <IssueButtons
            mode={issueMode} setMode={setIssueMode}
            onCancelStockOut={(item, reason) => {
              const head = item
                ? `❌ দুঃখিত, "${item}" stock-এ নেই — অর্ডার বাতিল করতে হচ্ছে।`
                : "❌ দুঃখিত, কিছু item stock-এ নেই — অর্ডার বাতিল করতে হচ্ছে।";
              const body = reason ? `${head}\nকারণ: ${reason}` : head;
              onSend({ body, preset_key: ORDER_PRESETS.reject });
            }}
            onDelay={(mins, reason) => {
              const body = `⏱️ একটু দেরি হবে — আনুমানিক ${mins} মিনিট।${reason ? `\nকারণ: ${reason}` : ""}`;
              onSend({ body, preset_key: ORDER_PRESETS.delay });
            }}
          />
        </Bar>
      </>
    );
  }

  if (calledRider) {
    return (
      <Bar>
        <Pill tone="indigo" icon={<Bike size={11} />}>
          5 km-এর মধ্যে rider notified — accept-এর অপেক্ষা
        </Pill>
        <IssueButtons
          mode={issueMode} setMode={setIssueMode}
          onCancelStockOut={(item, reason) => {
            const head = item
              ? `❌ দুঃখিত, "${item}" stock-এ নেই — অর্ডার বাতিল।`
              : "❌ দুঃখিত, কিছু item stock-এ নেই — অর্ডার বাতিল।";
            onSend({ body: reason ? `${head}\nকারণ: ${reason}` : head, preset_key: ORDER_PRESETS.reject });
          }}
          onDelay={(mins, reason) => {
            onSend({
              body: `⏱️ একটু দেরি হবে — আনুমানিক ${mins} মিনিট।${reason ? `\nকারণ: ${reason}` : ""}`,
              preset_key: ORDER_PRESETS.delay,
            });
          }}
        />
      </Bar>
    );
  }

  if (lastStatus === "preparing") {
    return (
      <Bar>
        <Btn
          tone="indigo"
          disabled={busy}
          onClick={() => onSend({
            body: "📞 আশেপাশের সব rider-কে offer পাঠানো হচ্ছে…",
            preset_key: ORDER_PRESETS.call_rider,
          })}
        >
          <Bike size={12} /> Rider ডাকুন
        </Btn>
        <IssueButtons
          mode={issueMode} setMode={setIssueMode}
          onCancelStockOut={(item, reason) => {
            const head = item ? `❌ "${item}" stock-এ নেই — অর্ডার বাতিল।`
                              : "❌ কিছু item stock-এ নেই — অর্ডার বাতিল।";
            onSend({ body: reason ? `${head}\nকারণ: ${reason}` : head, preset_key: ORDER_PRESETS.reject });
          }}
          onDelay={(mins, reason) => {
            onSend({
              body: `⏱️ একটু দেরি হবে — আনুমানিক ${mins} মিনিট।${reason ? `\nকারণ: ${reason}` : ""}`,
              preset_key: ORDER_PRESETS.delay,
            });
          }}
        />
      </Bar>
    );
  }

  if (lastStatus === "confirmed") {
    return (
      <Bar>
        <Btn
          tone="amber"
          disabled={busy}
          onClick={() => onSend({
            body: "🟢 অর্ডার প্যাকিং চলছে — একটু অপেক্ষা করুন।",
            preset_key: ORDER_PRESETS.status_preparing,
          })}
        >
          <Package size={12} /> Packing শুরু
        </Btn>
        <IssueButtons
          mode={issueMode} setMode={setIssueMode}
          onCancelStockOut={(item, reason) => {
            const head = item ? `❌ "${item}" stock-এ নেই — অর্ডার বাতিল।`
                              : "❌ কিছু item stock-এ নেই — অর্ডার বাতিল।";
            onSend({ body: reason ? `${head}\nকারণ: ${reason}` : head, preset_key: ORDER_PRESETS.reject });
          }}
          onDelay={(mins, reason) => {
            onSend({
              body: `⏱️ একটু দেরি হবে — আনুমানিক ${mins} মিনিট।${reason ? `\nকারণ: ${reason}` : ""}`,
              preset_key: ORDER_PRESETS.delay,
            });
          }}
        />
      </Bar>
    );
  }

  // Default — pending request OR no order yet → Confirm / Reject / Quote / Modify.
  return (
    <>
      <Bar>
        {openRequest && (
          <>
            <Btn
              tone="emerald"
              disabled={busy}
              onClick={() => onSend({
                body: `✅ অর্ডার confirm করেছি — মোট ${formatBDT(openRequest.payload?.total ?? 0)}, প্যাকিং শুরু করছি।`,
                preset_key: ORDER_PRESETS.confirm,
              })}
            >
              <Check size={12} /> Confirm
            </Btn>
            <Btn
              tone="rose"
              disabled={busy}
              onClick={() => setIssueMode("stockout")}
            >
              <XCircle size={12} /> Reject
            </Btn>
          </>
        )}
        <Btn
          tone="brand"
          disabled={busy}
          onClick={() => setComposer("quote")}
        >
          <Receipt size={12} /> Quote
        </Btn>
        {openRequestItems && openRequestItems.length > 0 && (
          <Btn
            tone="indigo"
            disabled={busy}
            onClick={() => setComposer("modify")}
          >
            ✏️ Items modify
          </Btn>
        )}
        {!openRequest && (
          <span className="ml-auto self-center rounded-full bg-white/70 px-2.5 py-1 text-[10px] font-semibold text-slate-500 ring-1 ring-black/5 dark:bg-white/10 dark:text-slate-300 dark:ring-white/10">
            Customer-এর next request-এর অপেক্ষা
          </span>
        )}
      </Bar>

      {issueMode && (
        <Bar>
          <IssueButtons
            mode={issueMode} setMode={setIssueMode}
            onCancelStockOut={(item, reason) => {
              const head = item
                ? `❌ দুঃখিত, "${item}" stock-এ নেই — অর্ডার বাতিল করতে হচ্ছে।`
                : "❌ দুঃখিত, কিছু item stock-এ নেই — অর্ডার বাতিল করতে হচ্ছে।";
              onSend({ body: reason ? `${head}\nকারণ: ${reason}` : head, preset_key: ORDER_PRESETS.reject });
            }}
            onDelay={(mins, reason) => {
              onSend({
                body: `⏱️ একটু দেরি হবে — আনুমানিক ${mins} মিনিট।${reason ? `\nকারণ: ${reason}` : ""}`,
                preset_key: ORDER_PRESETS.delay,
              });
            }}
          />
        </Bar>
      )}

      {composer && (
        <PharmacyOrderComposer
          pharmacyId={pharmacyId}
          mode={composer}
          initialItems={composer === "modify" ? openRequestItems ?? undefined : undefined}
          initialNote={composer === "modify" ? openRequestNote : undefined}
          onClose={() => setComposer(null)}
          onSubmit={(payload, body) => {
            setComposer(null);
            onSend({ body, preset_key: ORDER_PRESETS.quote, payload });
          }}
        />
      )}
    </>
  );
}

/* ---------------- Tiny presentational helpers ---------------- */

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-200/70 bg-gradient-to-r from-emerald-500/10 via-white to-teal-500/10 px-2 py-2 dark:border-white/10 dark:from-emerald-500/10 dark:via-white/[0.03] dark:to-teal-500/10">
      {children}
    </div>
  );
}

function Btn({
  tone, onClick, disabled, children,
}: {
  tone: "emerald" | "rose" | "brand" | "indigo" | "amber" | "purple";
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const cls: Record<string, string> = {
    emerald: "bg-emerald-500 hover:bg-emerald-600",
    rose: "bg-rose-500 hover:bg-rose-600",
    brand: "bg-brand-500 hover:bg-brand-600",
    indigo: "bg-indigo-500 hover:bg-indigo-600",
    amber: "bg-amber-500 hover:bg-amber-600",
    purple: "bg-purple-500 hover:bg-purple-600",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`tap inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm disabled:opacity-50 ${cls[tone]}`}
    >
      {disabled ? <Loader2 size={11} className="animate-spin" /> : null}
      {children}
    </button>
  );
}

function Pill({
  tone, icon, children,
}: {
  tone: "emerald" | "rose" | "amber" | "indigo" | "purple";
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const cls: Record<string, string> = {
    emerald: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
    rose: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
    indigo: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200",
    purple: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200",
  };
  return (
    <span className={`inline-flex max-w-full items-center gap-1 whitespace-normal rounded-full px-2.5 py-1 text-left text-[10px] font-semibold leading-snug shadow-sm ring-1 ring-black/5 dark:ring-white/10 ${cls[tone]}`}>
      {icon}{children}
    </span>
  );
}

/* ---------------- Stock-out + Delay (issue actions) ---------------- */

function IssueButtons({
  mode, setMode,
  onCancelStockOut, onDelay,
}: {
  mode: "stockout" | "delay" | null;
  setMode: (m: "stockout" | "delay" | null) => void;
  onCancelStockOut: (item: string, reason: string) => void;
  onDelay: (minutes: number, reason: string) => void;
}) {
  const [item, setItem] = useState("");
  const [stockReason, setStockReason] = useState("");
  const [delayMins, setDelayMins] = useState("10");
  const [delayReason, setDelayReason] = useState("");

  if (mode === "stockout") {
    return (
      <div className="ml-auto w-full rounded-xl border border-rose-300/60 bg-rose-50 px-2 py-2 text-[11px] dark:border-rose-500/30 dark:bg-rose-950/30">
        <p className="mb-1.5 font-semibold text-rose-800 dark:text-rose-200">
          কোন item stock-এ নেই? (অর্ডার auto-cancel হবে)
        </p>
        <input
          value={item} onChange={(e) => setItem(e.target.value)}
          placeholder="যেমন: Napa 500mg" autoFocus
          className="mb-1 w-full rounded-md border border-rose-300/40 bg-white px-2 py-1 text-[11px] dark:bg-white/5"
        />
        <input
          value={stockReason} onChange={(e) => setStockReason(e.target.value)}
          placeholder="কেন? (supplier-এ নেই / discontinued…)"
          className="mb-1 w-full rounded-md border border-rose-300/40 bg-white px-2 py-1 text-[11px] dark:bg-white/5"
        />
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => {
              onCancelStockOut(item.trim(), stockReason.trim());
              setMode(null); setItem(""); setStockReason("");
            }}
            className="tap rounded-full bg-rose-500 px-2.5 py-0.5 text-[10px] font-semibold text-white"
          >Cancel confirm</button>
          <button
            type="button"
            onClick={() => { setMode(null); setItem(""); setStockReason(""); }}
            className="tap rounded-full bg-black/10 px-2.5 py-0.5 text-[10px] dark:bg-white/10"
          >ফিরে যান</button>
        </div>
      </div>
    );
  }

  if (mode === "delay") {
    return (
      <div className="ml-auto w-full rounded-xl border border-amber-300/60 bg-amber-50 px-2 py-2 text-[11px] dark:border-amber-500/30 dark:bg-amber-950/30">
        <p className="mb-1.5 font-semibold text-amber-800 dark:text-amber-200">
          কত মিনিট delay হবে আর কেন?
        </p>
        <div className="mb-1 flex gap-1.5">
          <input
            type="number" min={1} value={delayMins}
            onChange={(e) => setDelayMins(e.target.value)}
            placeholder="মিনিট"
            className="w-16 rounded-md border border-amber-300/40 bg-white px-2 py-1 text-[11px] dark:bg-white/5"
          />
          <input
            value={delayReason} onChange={(e) => setDelayReason(e.target.value)}
            placeholder="কারণ" autoFocus
            className="flex-1 rounded-md border border-amber-300/40 bg-white px-2 py-1 text-[11px] dark:bg-white/5"
          />
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => {
              const mins = Math.max(1, Math.round(Number(delayMins) || 0));
              onDelay(mins, delayReason.trim());
              setMode(null); setDelayReason("");
            }}
            className="tap rounded-full bg-amber-500 px-2.5 py-0.5 text-[10px] font-semibold text-white"
          >Delay note পাঠান</button>
          <button
            type="button"
            onClick={() => { setMode(null); setDelayReason(""); }}
            className="tap rounded-full bg-black/10 px-2.5 py-0.5 text-[10px] dark:bg-white/10"
          >ফিরে যান</button>
        </div>
      </div>
    );
  }

  return (
    <div className="ml-auto flex gap-1.5">
      <button
        type="button" onClick={() => setMode("delay")}
        className="tap inline-flex items-center gap-1 rounded-full border border-amber-400/50 bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-200"
        title="Delay notice পাঠান"
      >⏱️ Delay</button>
      <button
        type="button" onClick={() => setMode("stockout")}
        className="tap inline-flex items-center gap-1 rounded-full border border-rose-400/50 bg-rose-50 px-2 py-1 text-[10px] font-semibold text-rose-800 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-200"
        title="Stock নেই → cancel"
      >❌ Stock নেই</button>
    </div>
  );
}
