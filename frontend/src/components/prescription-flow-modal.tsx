"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload,
  Loader2,
  CheckCircle2,
  XCircle,
  Sparkles,
  MapPin,
  Star,
  Pill,
  AlertTriangle,
  ArrowLeft,
  Send,
  X,
  Camera,
  Search,
  Plus,
} from "lucide-react";
import { api, uploadImage } from "@/lib/api";
import { fetchPharmacy, userLocation, type StorefrontMedicine } from "@/lib/storefront";

/* ---------- Customer-added OTC extras (per pharmacy, in the review step) ---------- */
type ExtraItem = {
  medicine_id: string;
  name: string;
  qty: number;
  unit_price: number;
  image_url: string | null;
};

/* ---------- Backend types ---------- */
type ScanItem = {
  medicine_id: string;
  name: string;
  rx_name: string;
  rx_strength: string;
  rx_instructions: string;
  qty: number;
  unit_price: number;
  image_url: string | null;
  prescription_required: boolean;
  match_score: number;
};
type Missing = { rx_name: string; rx_strength: string; qty: number; instructions: string };
type Proposal = {
  pharmacy: {
    id: string;
    name: string;
    business_name: string;
    banner_photo_url: string | null;
    rating: number;
    rating_count: number;
    is_verified: boolean;
    subscription_tier: string;
    phone_number: string | null;
  };
  items: ScanItem[];
  missing: Missing[];
  coverage_pct: number;
  subtotal: number;
  delivery_fee: number;
  total: number;
  distance_km: number | null;
  eta_min: number;
};
type AiBlock = {
  medicines: { name: string; strength: string; form: string; quantity: number; instructions: string }[];
  doctor_name: string;
  patient_name: string;
  notes: string;
};
type ScanOk = { ok: true; ai: AiBlock; proposals: Proposal[] };
type ScanFail = {
  ok: false;
  code: "ai_busy" | "not_prescription" | "no_image" | "no_pharmacies";
  message: string;
  manual_options?: { id: string; name: string; rating: number; distance_km: number | null; delivery_fee: number }[];
  ai?: AiBlock;
};
type ScanResp = ScanOk | ScanFail;

type Step =
  | "pick"
  | "uploading"
  | "scanning"
  | "review"
  | "handshaking"          // sending handshake to pharmacy(ies)
  | "awaiting_pharmacy"    // pharmacy(ies) checking stock
  | "ready_to_confirm"     // pharmacy said yes — show big Final Confirm
  | "final_dispatching"    // user clicked Final Confirm — placing real order
  | "done"
  | "error";

type HandshakeConv = {
  conversation_id: string;
  handshake_id: string;
  pharmacy_id: string;
  pharmacy_name: string;
};
type HandshakeResp = {
  ok: boolean;
  is_split: boolean;
  conversations: HandshakeConv[];
  conversation_id: string;
  handshake_id: string;
};

type ChatMessage = {
  id: string;
  preset_key: string | null;
  payload?: { handshake_id?: string; status?: string; pharmacy_name?: string } | null;
  created_at?: string | null;
};
type PharmacyState =
  | "awaiting_pharmacy"
  | "pharmacy_ok"
  | "pharmacy_rejected";

export function PrescriptionFlowModal({
  open,
  onClose,
  lat,
  lng,
  address,
}: {
  open: boolean;
  onClose: () => void;
  lat: number | null;
  lng: number | null;
  address?: string | null;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [step, setStep] = useState<Step>("pick");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResp | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [handshake, setHandshake] = useState<HandshakeResp | null>(null);
  // Per-conversation pharmacy state (key = conversation_id)
  const [pharmacyStates, setPharmacyStates] = useState<Record<string, PharmacyState>>({});
  // Per-pharmacy customer-added OTC extras (key = pharmacy_id)
  const [extrasByPharmacy, setExtrasByPharmacy] = useState<Record<string, ExtraItem[]>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // reset on close
  useEffect(() => {
    if (!open) {
      setTimeout(() => {
        setStep("pick");
        setPreviewUrl(null);
        setUploadedUrl(null);
        setScan(null);
        setErrorMsg("");
        setHandshake(null);
        setPharmacyStates({});
        setExtrasByPharmacy({});
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, 200);
    }
  }, [open]);

  const reset = () => {
    setStep("pick");
    setPreviewUrl(null);
    setUploadedUrl(null);
    setScan(null);
    setErrorMsg("");
    setHandshake(null);
    setPharmacyStates({});
    setExtrasByPharmacy({});
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const onFile = useCallback(
    async (file: File) => {
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) {
        setErrorMsg("File too large (max 8 MB)");
        setStep("error");
        return;
      }
      setPreviewUrl(URL.createObjectURL(file));
      setStep("uploading");
      try {
        const url = await uploadImage(file);
        setUploadedUrl(url);
        setStep("scanning");
        const resp = await api<ScanResp>("/api/ai/prescription-scan", {
          method: "POST",
          body: JSON.stringify({
            image_url: url,
            lat: lat ?? undefined,
            lng: lng ?? undefined,
            radius_km: 5.0,
          }),
        });
        setScan(resp);
        setStep("review");
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setStep("error");
      }
    },
    [lat, lng]
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) void onFile(f);
  };

  // Build the `plans[]` array that handshake/dispatch both expect.
  const buildPlans = () => {
    if (!scan || !scan.ok) return [];
    return scan.proposals.map((proposal) => {
      const rxItems = proposal.items.map((it) => ({
        medicine_id: it.medicine_id,
        name: it.name,
        qty: it.qty,
        unit_price: it.unit_price,
        prescription_required: it.prescription_required,
        rx_strength: it.rx_strength,
        rx_instructions: it.rx_instructions,
      }));
      // Customer-added OTC extras (always non-Rx — we filter on add).
      const extras = (extrasByPharmacy[proposal.pharmacy.id] || []).map((it) => ({
        medicine_id: it.medicine_id,
        name: it.name,
        qty: it.qty,
        unit_price: it.unit_price,
        prescription_required: false as const,
        rx_strength: "",
        rx_instructions: "",
      }));
      const items = [...rxItems, ...extras];
      const extrasSubtotal = extras.reduce((s, it) => s + it.unit_price * it.qty, 0);
      const subtotal = proposal.subtotal + extrasSubtotal;
      const total = subtotal + proposal.delivery_fee;
      return {
        pharmacy_id: proposal.pharmacy.id,
        items,
        subtotal,
        delivery_fee: proposal.delivery_fee,
        total,
      };
    });
  };

  // Phase 1 — open handshake(s). The pharmacy sees a stock-check card and
  // can hit Confirm / Reject; we poll the conversation(s) and light up the
  // Final-Confirm button as soon as the pharmacy says yes.
  const sendOrder = async () => {
    if (!uploadedUrl || !scan || !scan.ok || scan.proposals.length === 0) return;
    setStep("handshaking");
    try {
      const resp = await api<HandshakeResp>("/api/ai/prescription-handshake", {
        method: "POST",
        body: JSON.stringify({
          prescription_url: uploadedUrl,
          plans: buildPlans(),
          note: scan.ai.notes,
          delivery_address: address ?? undefined,
          delivery_lat: lat ?? undefined,
          delivery_lng: lng ?? undefined,
        }),
      });
      setHandshake(resp);
      const initial: Record<string, PharmacyState> = {};
      for (const c of resp.conversations) initial[c.conversation_id] = "awaiting_pharmacy";
      setPharmacyStates(initial);
      setStep("awaiting_pharmacy");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStep("error");
    }
  };

  // Phase 2 — customer hit Final Confirm. This consumes 1 credit and
  // creates the real `order_request` + Order rows.
  const finalConfirm = async () => {
    if (!uploadedUrl || !scan || !scan.ok || !handshake) return;
    setStep("final_dispatching");
    try {
      // Only dispatch the plans whose pharmacy said "ok" — drop any that
      // explicitly rejected. (For now plans[] order mirrors conversations[]
      // order, since both come from the same scan.proposals list.)
      const allPlans = buildPlans();
      const okConvs = handshake.conversations.filter(
        (c) => pharmacyStates[c.conversation_id] === "pharmacy_ok",
      );
      if (okConvs.length === 0) {
        throw new Error("কোনও pharmacy এই order accept করেনি।");
      }
      // Re-align plans with the surviving conversations by pharmacy_id.
      const survivingPlans = allPlans.filter((p) =>
        okConvs.some((c) => c.pharmacy_id === p.pharmacy_id),
      );
      const handshake_ids = okConvs.map((c) => c.handshake_id);
      const resp = await api<{
        ok: boolean;
        conversation_id: string;
        dispatched: { conversation_id: string; pharmacy_id: string; pharmacy_name: string; order_id: string }[];
      }>("/api/ai/prescription-dispatch", {
        method: "POST",
        body: JSON.stringify({
          prescription_url: uploadedUrl,
          plans: survivingPlans,
          handshake_ids,
          note: scan.ai.notes,
          delivery_address: address ?? undefined,
          delivery_lat: lat ?? undefined,
          delivery_lng: lng ?? undefined,
        }),
      });
      setStep("done");
      setTimeout(() => {
        onClose();
        router.push(`/customer?chat=${resp.conversation_id}`);
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("medidoor-open-chat"));
        }, 400);
      }, 1200);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStep("error");
    }
  };

  // Polling effect — once handshake is open, watch the conversation(s)
  // every 3s for `ai_customer_confirm_prompt` or `ai_handshake_rejected`.
  useEffect(() => {
    if (!handshake || (step !== "awaiting_pharmacy" && step !== "ready_to_confirm")) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    const poll = async () => {
      const updated: Record<string, PharmacyState> = { ...pharmacyStates };
      let changed = false;
      for (const c of handshake.conversations) {
        try {
          const msgs = await api<ChatMessage[]>(`/api/conversations/${c.conversation_id}/messages`);
          // walk newest → oldest so we read the latest verdict first
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            const pl = m.payload || {};
            if (pl.handshake_id && pl.handshake_id !== c.handshake_id) continue;
            if (m.preset_key === "ai_customer_confirm_prompt") {
              if (updated[c.conversation_id] !== "pharmacy_ok") {
                updated[c.conversation_id] = "pharmacy_ok";
                changed = true;
              }
              break;
            }
            if (m.preset_key === "ai_handshake_rejected") {
              if (updated[c.conversation_id] !== "pharmacy_rejected") {
                updated[c.conversation_id] = "pharmacy_rejected";
                changed = true;
              }
              break;
            }
          }
        } catch {
          /* ignore polling glitches */
        }
      }
      if (changed) setPharmacyStates(updated);
      // Decide UI state: ALL settled means show big Confirm if ANY ok; if
      // all rejected, surface error.
      const states = handshake.conversations.map((c) => updated[c.conversation_id] || "awaiting_pharmacy");
      const allSettled = states.every((s) => s !== "awaiting_pharmacy");
      const anyOk = states.some((s) => s === "pharmacy_ok");
      if (allSettled) {
        if (anyOk) setStep((cur) => (cur === "awaiting_pharmacy" ? "ready_to_confirm" : cur));
        else {
          setErrorMsg("সব pharmacy stock unavailable জানিয়েছে — অন্য prescription / অন্য এলাকা চেষ্টা করুন।");
          setStep("error");
        }
      } else if (anyOk) {
        // At least one yes — let the user confirm even while others are still thinking
        setStep((cur) => (cur === "awaiting_pharmacy" ? "ready_to_confirm" : cur));
      }
    };
    void poll();
    pollRef.current = setInterval(() => void poll(), 3000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handshake, step]);

  const openChatNow = () => {
    if (!handshake) return;
    onClose();
    router.push(`/customer?chat=${handshake.conversation_id}`);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("medidoor-open-chat"));
    }, 400);
  };

  if (!open) return null;

  // Which of the 4 stepper stages is active — drives the compact mobile label.
  const STEP_LABELS = ["Upload", "AI scan", "Pharmacy check", "Final confirm"] as const;
  const activeStepIndex =
    step === "scanning"
      ? 1
      : step === "review" || step === "handshaking" || step === "awaiting_pharmacy"
        ? 2
        : step === "ready_to_confirm" || step === "final_dispatching" || step === "done"
          ? 3
          : 0;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] grid place-items-center bg-black/60 backdrop-blur-md p-3 sm:p-6"
        onClick={(e) => {
          if (e.target === e.currentTarget && step !== "uploading" && step !== "scanning" && step !== "handshaking" && step !== "final_dispatching")
            onClose();
        }}
      >
        <motion.div
          initial={{ scale: 0.96, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.96, opacity: 0, y: 20 }}
          transition={{ type: "spring", stiffness: 280, damping: 26 }}
          className="relative w-full max-w-3xl max-h-[92vh] overflow-hidden rounded-3xl bg-white dark:bg-[#0d141d] shadow-2xl border border-white/10"
        >
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-black/5 dark:border-white/10 bg-gradient-to-r from-brand-500 to-brand-600 px-5 py-4 text-white">
            <div className="grid h-10 w-10 place-items-center rounded-2xl bg-white/20 backdrop-blur">
              <Sparkles size={20} />
            </div>
            <div className="flex-1">
              <h2 className="text-base sm:text-lg font-bold leading-tight">
                Smart Prescription Order
              </h2>
              <p className="text-xs text-white/85 leading-tight">
                AI আপনার prescription পড়বে → সবচেয়ে ভালো pharmacy বাছবে → আপনি শুধু Confirm করবেন।
              </p>
            </div>
            <button
              onClick={onClose}
              disabled={
                step === "uploading" ||
                step === "scanning" ||
                step === "handshaking" ||
                step === "final_dispatching"
              }
              className="grid h-9 w-9 place-items-center rounded-full bg-white/15 hover:bg-white/25 disabled:opacity-40"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          {/* Stepper */}
          <div className="border-b border-black/5 dark:border-white/10 bg-brand-50/40 dark:bg-brand-500/5 px-5 py-2">
            {/* Mobile: show only the current step so labels never truncate (C3) */}
            <p className="text-[11px] font-semibold text-brand-700 dark:text-brand-300 sm:hidden">
              ধাপ {activeStepIndex + 1}/৪ · {STEP_LABELS[activeStepIndex]}
            </p>
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] font-medium sm:mt-0">
            {(["Upload", "AI scan", "Pharmacy check", "Final confirm"] as const).map((label, i) => {
              const active =
                (i === 0 && (step === "pick" || step === "uploading" || step === "error")) ||
                (i === 1 && step === "scanning") ||
                (i === 2 &&
                  (step === "review" || step === "handshaking" || step === "awaiting_pharmacy")) ||
                (i === 3 &&
                  (step === "ready_to_confirm" || step === "final_dispatching" || step === "done"));
              const done =
                (i === 0 && step !== "pick" && step !== "uploading" && step !== "error") ||
                (i === 1 &&
                  step !== "pick" &&
                  step !== "uploading" &&
                  step !== "scanning" &&
                  step !== "error") ||
                (i === 2 &&
                  (step === "ready_to_confirm" ||
                    step === "final_dispatching" ||
                    step === "done")) ||
                (i === 3 && step === "done");
              return (
                <div key={label} className="flex flex-1 items-center gap-2">
                  <span
                    className={`grid h-6 w-6 place-items-center rounded-full text-[10px] font-bold ${
                      done
                        ? "bg-emerald-500 text-white"
                        : active
                        ? "bg-brand-600 text-white"
                        : "bg-black/10 dark:bg-white/10 text-black/40 dark:text-white/40"
                    }`}
                  >
                    {done ? <CheckCircle2 size={12} /> : i + 1}
                  </span>
                  <span className={`hidden sm:inline ${active || done ? "text-black/80 dark:text-white/80" : "text-black/40 dark:text-white/40"}`}>
                    {label}
                  </span>
                  {i < 3 && <div className="flex-1 h-px bg-black/10 dark:bg-white/10" />}
                </div>
              );
            })}
            </div>
          </div>

          {/* Body */}
          <div className="overflow-y-auto max-h-[calc(92vh-150px)]">
            {step === "pick" && (
              <PickStep onPick={() => fileRef.current?.click()} onDrop={onDrop} />
            )}

            {(step === "uploading" || step === "scanning") && (
              <ProgressStep
                previewUrl={previewUrl}
                title={step === "uploading" ? "Image upload হচ্ছে…" : "🤖 AI prescription পড়ছে…"}
                sub={
                  step === "uploading"
                    ? "একটু wait করুন।"
                    : "Doctor's handwriting decode + nearby pharmacy match — এটা সাধারণত 5–20 second সময় নেয়।"
                }
              />
            )}

            {step === "review" && scan && (
              <ReviewStep
                scan={scan}
                onRetry={reset}
                onSend={sendOrder}
                extrasByPharmacy={extrasByPharmacy}
                onAddExtra={(pharmacyId, item) =>
                  setExtrasByPharmacy((prev) => {
                    const cur = prev[pharmacyId] || [];
                    const idx = cur.findIndex((x) => x.medicine_id === item.medicine_id);
                    if (idx >= 0) {
                      const copy = [...cur];
                      copy[idx] = { ...copy[idx], qty: copy[idx].qty + 1 };
                      return { ...prev, [pharmacyId]: copy };
                    }
                    return { ...prev, [pharmacyId]: [...cur, item] };
                  })
                }
                onChangeExtraQty={(pharmacyId, medicineId, delta) =>
                  setExtrasByPharmacy((prev) => {
                    const cur = prev[pharmacyId] || [];
                    const idx = cur.findIndex((x) => x.medicine_id === medicineId);
                    if (idx < 0) return prev;
                    const next = Math.max(0, cur[idx].qty + delta);
                    if (next === 0) {
                      const copy = cur.filter((_, i) => i !== idx);
                      return { ...prev, [pharmacyId]: copy };
                    }
                    const copy = [...cur];
                    copy[idx] = { ...copy[idx], qty: next };
                    return { ...prev, [pharmacyId]: copy };
                  })
                }
                onRemoveExtra={(pharmacyId, medicineId) =>
                  setExtrasByPharmacy((prev) => ({
                    ...prev,
                    [pharmacyId]: (prev[pharmacyId] || []).filter(
                      (x) => x.medicine_id !== medicineId,
                    ),
                  }))
                }
              />
            )}

            {step === "handshaking" && (
              <ProgressStep
                previewUrl={previewUrl}
                title="🤝 medi AI handshake পাঠানো হচ্ছে…"
                sub="Pharmacy-কে আগে stock availability check করতে বলা হচ্ছে। আপনার credit এখনো কাটেনি।"
              />
            )}

            {step === "awaiting_pharmacy" && handshake && (
              <AwaitingPharmacyStep
                handshake={handshake}
                states={pharmacyStates}
                onOpenChat={openChatNow}
              />
            )}

            {step === "ready_to_confirm" && handshake && (
              <ReadyToConfirmStep
                handshake={handshake}
                states={pharmacyStates}
                scan={scan}
                onConfirm={finalConfirm}
                onOpenChat={openChatNow}
                onCancel={reset}
              />
            )}

            {step === "final_dispatching" && (
              <ProgressStep
                previewUrl={previewUrl}
                title="📨 Final order pharmacy-তে পাঠানো হচ্ছে…"
                sub="Order এখন pharmacy-তে যাচ্ছে। 1 credit consume হবে।"
              />
            )}

            {step === "done" && (
              <div className="grid place-items-center gap-3 px-6 py-12 text-center">
                <div className="grid h-16 w-16 place-items-center rounded-full bg-emerald-500 text-white">
                  <CheckCircle2 size={36} />
                </div>
                <h3 className="text-lg font-bold">Order pathano hoyeche!</h3>
                <p className="text-sm text-black/60 dark:text-white/60 max-w-md">
                  Chat খোলা হচ্ছে — pharmacy reply দিলেই আপনি জানতে পারবেন।
                </p>
              </div>
            )}

            {step === "error" && (
              <div className="grid place-items-center gap-3 px-6 py-10 text-center">
                <div
                  className={`grid h-14 w-14 place-items-center rounded-full ${
                    /limit শেষ/.test(errorMsg)
                      ? "bg-amber-500/15 text-amber-600 dark:text-amber-300"
                      : "bg-rose-500/15 text-rose-500"
                  }`}
                >
                  {/limit শেষ/.test(errorMsg) ? <AlertTriangle size={32} /> : <XCircle size={32} />}
                </div>
                <h3 className="text-base font-bold">
                  {/limit শেষ/.test(errorMsg) ? "Smart Prescription limit শেষ" : "কিছু একটা ভুল হয়েছে"}
                </h3>
                <p className="text-sm text-black/60 dark:text-white/60 max-w-md break-words">
                  {/limit শেষ/.test(errorMsg)
                    ? "এই মাসের free AI prescription scan quota শেষ হয়েছে। Profile থেকে quota renew করুন, অথবা পরের মাসে quota reset হলে আবার ব্যবহার করুন।"
                    : errorMsg}
                </p>
                <button
                  onClick={reset}
                  className="mt-2 rounded-full bg-brand-500 px-5 py-2 text-sm font-medium text-white hover:bg-brand-600"
                >
                  অন্য ছবি upload করুন
                </button>
              </div>
            )}
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
              e.target.value = "";
            }}
          />
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/* ---------- Sub-components ---------- */

function PickStep({ onPick, onDrop }: { onPick: () => void; onDrop: (e: React.DragEvent) => void }) {
  return (
    <div className="px-5 py-6">
      <div
        onClick={onPick}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="group relative grid cursor-pointer place-items-center gap-3 rounded-2xl border-2 border-dashed border-brand-300 bg-gradient-to-b from-brand-50/60 to-white px-6 py-12 text-center text-slate-900 transition hover:border-brand-500 hover:bg-brand-50 dark:border-brand-500/40 dark:from-brand-500/10 dark:to-[#101923] dark:text-white/90 dark:hover:border-brand-400 dark:hover:bg-brand-500/10"
      >
        <motion.div
          animate={{ y: [0, -6, 0] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
          className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg shadow-brand-500/40"
        >
          <Upload size={26} />
        </motion.div>
        <p className="text-base font-semibold text-black/80 dark:text-white/85">
          ছবি তুলুন বা Gallery থেকে দিন
        </p>
        <p className="text-xs text-black/55 dark:text-white/55">
          JPG / PNG / WebP · max 8 MB · doctor-এর হাতের লেখা ও clear হলে best
        </p>
        <div className="mt-2 flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm dark:bg-white/10 dark:text-white/80">
            <Camera size={12} /> Camera
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm dark:bg-white/10 dark:text-white/80">
            <Upload size={12} /> Gallery
          </span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 text-[11px]">
        <Tip n={1} text="AI medicine গুলো পড়বে" />
        <Tip n={2} text="সবচেয়ে rated pharmacy আমি বাছবো" />
        <Tip n={3} text="আপনি শুধু Confirm করবেন" />
      </div>
    </div>
  );
}

function Tip({ n, text }: { n: number; text: string }) {
  return (
    <div className="rounded-xl bg-black/5 dark:bg-white/5 p-2.5 text-center">
      <div className="mx-auto mb-1 grid h-5 w-5 place-items-center rounded-full bg-brand-500 text-[10px] font-bold text-white">
        {n}
      </div>
      <p className="text-black/65 dark:text-white/65 leading-tight">{text}</p>
    </div>
  );
}

function ProgressStep({
  previewUrl,
  title,
  sub,
}: {
  previewUrl: string | null;
  title: string;
  sub: string;
}) {
  return (
    <div className="grid place-items-center gap-4 px-6 py-10 text-center">
      {previewUrl && (
        <div className="relative h-40 w-40 overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 shadow-md">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt="prescription" className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
          <div className="absolute inset-x-0 bottom-2 grid place-items-center">
            <Loader2 size={22} className="animate-spin text-white drop-shadow" />
          </div>
        </div>
      )}
      <h3 className="text-base font-bold">{title}</h3>
      <p className="text-sm text-black/60 dark:text-white/60 max-w-md">{sub}</p>
    </div>
  );
}

function ReviewStep({
  scan,
  onRetry,
  onSend,
  extrasByPharmacy,
  onAddExtra,
  onChangeExtraQty,
  onRemoveExtra,
}: {
  scan: ScanResp;
  onRetry: () => void;
  onSend: () => void;
  extrasByPharmacy: Record<string, ExtraItem[]>;
  onAddExtra: (pharmacyId: string, item: ExtraItem) => void;
  onChangeExtraQty: (pharmacyId: string, medicineId: string, delta: number) => void;
  onRemoveExtra: (pharmacyId: string, medicineId: string) => void;
}) {
  if (!scan.ok) {
    return (
      <div className="px-5 py-6 grid gap-4">
        <div className="flex items-start gap-3 rounded-2xl border border-amber-300/40 bg-amber-50 dark:bg-amber-500/10 p-4">
          <AlertTriangle className="text-amber-600 shrink-0 mt-0.5" size={20} />
          <div className="text-sm">
            <p className="font-semibold mb-1">
              {scan.code === "ai_busy"
                ? "AI এখন একটু busy"
                : scan.code === "not_prescription"
                ? "এটি prescription নয়"
                : scan.code === "no_pharmacies"
                ? "কাছাকাছি pharmacy পাওয়া যায়নি"
                : "Image পাওয়া যায়নি"}
            </p>
            <p className="text-black/65 dark:text-white/65">{scan.message}</p>
          </div>
        </div>

        {scan.manual_options && scan.manual_options.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50 mb-2">
              নিজে pharmacy বাছাই করুন
            </h4>
            <div className="grid gap-2">
              {scan.manual_options.map((p) => (
                <a
                  key={p.id}
                  href={`/store/${p.id}`}
                  className="flex items-center justify-between rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-3 hover:border-brand-400"
                >
                  <div>
                    <p className="text-sm font-semibold">{p.name}</p>
                    <p className="text-xs text-black/50 dark:text-white/50 flex items-center gap-3">
                      <span className="inline-flex items-center gap-1">
                        <Star size={10} className="text-amber-500" /> {p.rating}
                      </span>
                      {p.distance_km != null && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin size={10} /> {p.distance_km} km
                        </span>
                      )}
                      <span>৳{p.delivery_fee} delivery</span>
                    </p>
                  </div>
                  <span className="text-xs font-medium text-brand-600">খুলুন →</span>
                </a>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={onRetry}
          className="mx-auto inline-flex items-center gap-2 rounded-full bg-black/5 dark:bg-white/10 px-4 py-2 text-sm hover:bg-black/10"
        >
          <ArrowLeft size={14} /> অন্য ছবি upload করুন
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 px-5 py-5">
      {/* Extracted */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <Pill size={14} className="text-brand-600" />
          <h3 className="text-sm font-bold">AI যা পড়েছে</h3>
          {scan.ai.doctor_name && (
            <span className="text-[11px] text-black/50 dark:text-white/50 ml-auto">
              Dr. {scan.ai.doctor_name}
            </span>
          )}
        </div>
        <div className="rounded-2xl border border-black/5 dark:border-white/10 bg-brand-50/30 dark:bg-brand-500/5 p-3">
          <ul className="grid gap-1.5 text-sm">
            {scan.ai.medicines.map((m, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold">{m.name}</span>
                {m.strength && <span className="text-black/55 dark:text-white/55">({m.strength})</span>}
                <span className="text-xs text-brand-700 dark:text-brand-300">× {m.quantity}</span>
                {m.instructions && (
                  <span className="text-xs text-black/50 dark:text-white/50 italic">— {m.instructions}</span>
                )}
              </li>
            ))}
          </ul>
          {scan.ai.notes && (
            <p className="mt-2 text-xs text-black/55 dark:text-white/55 border-t border-black/5 dark:border-white/10 pt-2">
              💡 {scan.ai.notes}
            </p>
          )}
        </div>
      </section>

      {/* Proposal — single best pharmacy OR multi-pharmacy split plan */}
      {scan.proposals.length > 0 && (() => {
        const props = scan.proposals;
        const isSplit = props.length > 1;
        const grandTotal = props.reduce(
          (s, p) =>
            s +
            p.total +
            (extrasByPharmacy[p.pharmacy.id] || []).reduce(
              (ss, it) => ss + it.unit_price * it.qty,
              0,
            ),
          0,
        );
        const totalItems = props.reduce((s, p) => s + p.items.length, 0);
        const totalMissing = props[props.length - 1].missing.length;
        return (
          <section>
            {/* AI conversational intro bubble */}
            <div className="mb-3 flex items-start gap-2.5">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-md shadow-brand-500/30">
                <Sparkles size={16} />
              </div>
              <div className="flex-1 rounded-2xl rounded-tl-sm bg-brand-50 dark:bg-brand-500/10 px-3.5 py-2.5 text-sm leading-relaxed">
                {isSplit ? (
                  <p className="text-black/80 dark:text-white/85">
                    আমি দেখলাম — এক pharmacy-তে সব ওষুধ নেই, তাই{" "}
                    <span className="font-bold text-brand-700 dark:text-brand-300">
                      {props.length}টি pharmacy
                    </span>{" "}
                    থেকে split order করছি — মোট{" "}
                    <span className="font-bold text-brand-700 dark:text-brand-300">
                      ৳{grandTotal.toFixed(0)}
                    </span>
                    । আপনি Confirm চাপলে দুটি pharmacy-তেই একসাথে order যাবে।
                    {totalMissing > 0 && ` (${totalMissing}টি ওষুধ এখনো পাওয়া যায়নি — pharmacy alternative দিতে পারে।)`}
                  </p>
                ) : (
                  <p className="text-black/80 dark:text-white/85">
                    আমি দেখলাম — কাছের সবচেয়ে ভালো rated pharmacy{" "}
                    <span className="font-bold text-brand-700 dark:text-brand-300">
                      {props[0].pharmacy.name}
                    </span>{" "}
                    আপনার medicine গুলো{" "}
                    <span className="font-bold text-brand-700 dark:text-brand-300">
                      মোট ৳{props[0].total.toFixed(0)}
                    </span>{" "}
                    এ offer করছে।{" "}
                    {props[0].missing.length === 0
                      ? "সব ওষুধ পাওয়া যাচ্ছে। ✨"
                      : `${props[0].items.length}টি পাওয়া যাচ্ছে, ${props[0].missing.length}টি নেই — pharmacy চাইলে alternative দেবে।`}
                  </p>
                )}
              </div>
            </div>

            {/* One rich card per pharmacy in the plan */}
            <div className="grid gap-3">
              {props.map((p, idx) => {
                const initials = p.pharmacy.name.slice(0, 2).toUpperCase();
                return (
                  <div
                    key={p.pharmacy.id}
                    className="overflow-hidden rounded-2xl border-2 border-brand-300/50 dark:border-brand-500/30 bg-white dark:bg-white/5 shadow-lg"
                  >
                    {/* Split badge */}
                    {isSplit && (
                      <div className="bg-brand-500 text-white text-[10px] font-bold uppercase tracking-wide px-3 py-1.5 flex items-center justify-between">
                        <span>Pharmacy {idx + 1} / {props.length}</span>
                        <span className="text-white/80">{p.items.length}টি item</span>
                      </div>
                    )}
                    {/* Pharmacy header */}
                    <div className="flex items-center gap-3 bg-gradient-to-r from-brand-50 to-white dark:from-brand-500/10 dark:to-transparent px-4 py-3">
                      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-white font-bold">
                        {initials}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2">
                          <p className="font-bold text-base">{p.pharmacy.name}</p>
                          {p.pharmacy.is_verified && (
                            <span className="text-[10px] rounded-full bg-emerald-500/15 text-emerald-600 px-1.5 py-0.5 font-semibold">
                              ✓ verified
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-black/55 dark:text-white/55 flex flex-wrap items-center gap-x-3 mt-0.5">
                          <span className="inline-flex items-center gap-1 font-medium text-amber-600">
                            <Star size={11} fill="currentColor" /> {p.pharmacy.rating || "নতুন"}
                            {p.pharmacy.rating_count > 0 && (
                              <span className="text-black/40 dark:text-white/40">
                                ({p.pharmacy.rating_count})
                              </span>
                            )}
                          </span>
                          {p.distance_km != null && (
                            <span className="inline-flex items-center gap-1">
                              <MapPin size={11} /> {p.distance_km} km · ~{p.eta_min} min
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] uppercase tracking-wide text-black/45 dark:text-white/45">
                          {isSplit ? "এই pharmacy" : "মোট"}
                        </p>
                        <p className="text-xl font-extrabold text-brand-700 dark:text-brand-300 leading-tight">
                          ৳{p.total.toFixed(0)}
                        </p>
                      </div>
                    </div>

                    {/* Items */}
                    <div className="px-4 py-3 grid gap-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-black/45 dark:text-white/45">
                        {isSplit ? "এই pharmacy যা দেবে" : "Pharmacy যা যা দেবে"}
                      </p>
                      {p.items.map((it) => (
                        <div
                          key={it.medicine_id}
                          className="flex items-center justify-between gap-2 text-sm"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />
                            <span className="truncate">
                              <span className="font-medium">{it.name}</span>
                              <span className="text-black/50 dark:text-white/50"> × {it.qty}</span>
                            </span>
                          </div>
                          <span className="text-sm font-semibold tabular-nums shrink-0">
                            ৳{(it.unit_price * it.qty).toFixed(0)}
                          </span>
                        </div>
                      ))}

                      {/* Show missing only on the LAST card, since earlier
                          cards' missing items are filled by later ones */}
                      {idx === props.length - 1 && p.missing.length > 0 && (
                        <>
                          <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-rose-500/80">
                            এখনো stock-এ নেই (pharmacy alternative দিতে পারে)
                          </p>
                          {p.missing.map((m, mi) => (
                            <div
                              key={mi}
                              className="flex items-center gap-2 text-sm text-black/45 dark:text-white/45"
                            >
                              <XCircle size={14} className="text-rose-400 shrink-0" />
                              <span className="line-through truncate">
                                {m.rx_name} {m.rx_strength} × {m.qty}
                              </span>
                            </div>
                          ))}
                        </>
                      )}
                    </div>

                    {/* Customer-added OTC extras (no Rx needed) */}
                    <OtcAddSection
                      pharmacyId={p.pharmacy.id}
                      pharmacyName={p.pharmacy.name}
                      extras={extrasByPharmacy[p.pharmacy.id] || []}
                      excludeIds={new Set(p.items.map((it) => it.medicine_id))}
                      onAdd={onAddExtra}
                      onChangeQty={onChangeExtraQty}
                      onRemove={onRemoveExtra}
                    />

                    {/* Price breakdown */}
                    <div className="border-t border-black/5 dark:border-white/10 px-4 py-3 bg-black/[0.015] dark:bg-white/[0.02] grid gap-1 text-sm">
                      <div className="flex justify-between text-black/65 dark:text-white/65">
                        <span>Subtotal</span>
                        <span className="tabular-nums">৳{(p.subtotal + (extrasByPharmacy[p.pharmacy.id] || []).reduce((s, it) => s + it.unit_price * it.qty, 0)).toFixed(0)}</span>
                      </div>
                      <div className="flex justify-between text-black/65 dark:text-white/65">
                        <span>Delivery fee</span>
                        <span className="tabular-nums">৳{p.delivery_fee.toFixed(0)}</span>
                      </div>
                      <div className="flex justify-between font-bold text-base mt-1 pt-1 border-t border-black/5 dark:border-white/10">
                        <span>মোট</span>
                        <span className="tabular-nums text-brand-700 dark:text-brand-300">
                          ৳{(p.total + (extrasByPharmacy[p.pharmacy.id] || []).reduce((s, it) => s + it.unit_price * it.qty, 0)).toFixed(0)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Grand total for split */}
            {isSplit && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl bg-brand-500 text-white px-4 py-3 shadow-lg shadow-brand-500/30">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-white/80 font-semibold">
                    সব pharmacy মিলিয়ে মোট ({totalItems} item)
                  </p>
                  <p className="text-[10px] text-white/70">
                    Credit 1 বার খরচ হবে — দুটি pharmacy-তেই একসাথে যাবে।
                  </p>
                </div>
                <p className="text-2xl font-extrabold tabular-nums leading-none">
                  ৳{grandTotal.toFixed(0)}
                </p>
              </div>
            )}

            {/* Reassurance line */}
            <p className="mt-2 text-[11px] text-black/50 dark:text-white/50 text-center">
              Confirm করার পর pharmacy-র সাথে chat খুলবে — সেখানে দাম negotiate বা medicine change করা যাবে।
            </p>
          </section>
        );
      })()}

      {/* Footer actions */}
      <div className="sticky bottom-0 -mx-5 -mb-5 flex items-center gap-3 border-t border-black/5 dark:border-white/10 bg-white/95 dark:bg-[#0d141d]/95 backdrop-blur px-5 py-3">
        <button
          onClick={onRetry}
          className="rounded-full bg-black/5 dark:bg-white/10 px-4 py-2 text-sm hover:bg-black/10"
        >
          অন্য ছবি
        </button>
        <button
          onClick={onSend}
          disabled={scan.proposals.length === 0}
          className="ml-auto inline-flex items-center gap-2 rounded-full bg-brand-500 disabled:bg-black/20 disabled:dark:bg-white/15 disabled:cursor-not-allowed px-6 py-2.5 text-sm font-bold text-white hover:bg-brand-600 transition shadow-lg shadow-brand-500/30"
        >
          <Send size={14} />
          Pharmacy-কে stock check করতে পাঠান
        </button>
      </div>
    </div>
  );
}

/* ---------- OTC additions: customer adds extra non-Rx meds from this pharmacy ---------- */
function OtcAddSection({
  pharmacyId,
  pharmacyName,
  extras,
  excludeIds,
  onAdd,
  onChangeQty,
  onRemove,
}: {
  pharmacyId: string;
  pharmacyName: string;
  extras: ExtraItem[];
  excludeIds: Set<string>;
  onAdd: (pharmacyId: string, item: ExtraItem) => void;
  onChangeQty: (pharmacyId: string, medicineId: string, delta: number) => void;
  onRemove: (pharmacyId: string, medicineId: string) => void;
}) {
  const [open, setOpen] = useState(extras.length > 0);
  const [catalog, setCatalog] = useState<StorefrontMedicine[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    setLoading(true);
    // Storefront enforces the 5 km connect gate — send the customer's
    // browsing location or the catalog fetch 400s and the picker stays empty.
    const loc = userLocation.load();
    fetchPharmacy(pharmacyId, { lat: loc?.lat, lng: loc?.lng })
      .then((d) => {
        if (cancelled) return;
        const all: StorefrontMedicine[] = [];
        const seen = new Set<string>();
        for (const c of d.categories) {
          for (const it of c.items) {
            if (seen.has(it.id)) continue;
            // OTC only — prescription-required items hidden here.
            if (it.prescription_required) continue;
            seen.add(it.id);
            all.push(it);
          }
        }
        setCatalog(all);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setCatalog([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, loaded, pharmacyId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = catalog.filter((m) => !excludeIds.has(m.id));
    if (!q) return base.slice(0, 8);
    return base
      .filter((m) => m.name.toLowerCase().includes(q) || (m.category || "").toLowerCase().includes(q))
      .slice(0, 12);
  }, [catalog, query, excludeIds]);

  const extrasSubtotal = extras.reduce((s, it) => s + it.unit_price * it.qty, 0);

  return (
    <div className="border-t border-dashed border-black/10 dark:border-white/10 px-4 py-3 bg-emerald-50/40 dark:bg-emerald-500/5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
          <Plus size={14} />
          {extras.length > 0
            ? `আপনার যোগ করা OTC (${extras.length}) — ৳${extrasSubtotal.toFixed(0)}`
            : "আরও OTC ওষুধ যোগ করুন (prescription লাগবে না)"}
        </span>
        <span className="text-xs text-black/45 dark:text-white/45">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div className="mt-3 grid gap-2.5">
          {extras.length > 0 && (
            <div className="grid gap-1.5">
              {extras.map((it) => (
                <div
                  key={it.medicine_id}
                  className="flex items-center justify-between gap-2 rounded-lg bg-white dark:bg-white/5 border border-emerald-300/40 px-2.5 py-1.5 text-sm"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                    <span className="truncate font-medium">{it.name}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => onChangeQty(pharmacyId, it.medicine_id, -1)}
                      className="grid h-6 w-6 place-items-center rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10"
                      aria-label="কম"
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-xs font-semibold tabular-nums">
                      {it.qty}
                    </span>
                    <button
                      onClick={() => onChangeQty(pharmacyId, it.medicine_id, +1)}
                      className="grid h-6 w-6 place-items-center rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10"
                      aria-label="বেশি"
                    >
                      +
                    </button>
                    <span className="ml-2 text-xs font-semibold tabular-nums w-14 text-right">
                      ৳{(it.unit_price * it.qty).toFixed(0)}
                    </span>
                    <button
                      onClick={() => onRemove(pharmacyId, it.medicine_id)}
                      className="ml-1 grid h-6 w-6 place-items-center rounded-md text-rose-500 hover:bg-rose-500/10"
                      aria-label="বাদ"
                    >
                      <XCircle size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="relative">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-black/40 dark:text-white/40"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`${pharmacyName}-এর OTC catalog খুঁজুন…`}
              className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>

          {loading && (
            <p className="text-xs text-black/50 dark:text-white/50 text-center py-2">
              Catalog load হচ্ছে…
            </p>
          )}

          {!loading && loaded && filtered.length === 0 && (
            <p className="text-xs text-black/50 dark:text-white/50 text-center py-2">
              {query ? "মিল পাওয়া যায়নি।" : "এই pharmacy-তে আর OTC item নেই।"}
            </p>
          )}

          {!loading && filtered.length > 0 && (
            <div className="grid gap-1 max-h-56 overflow-y-auto">
              {filtered.map((m) => {
                const already = extras.some((x) => x.medicine_id === m.id);
                return (
                  <button
                    key={m.id}
                    onClick={() =>
                      onAdd(pharmacyId, {
                        medicine_id: m.id,
                        name: m.name,
                        qty: 1,
                        unit_price: Number(m.price || 0),
                        image_url: m.image_url ?? null,
                      })
                    }
                    className="flex items-center justify-between gap-2 rounded-lg border border-transparent bg-white dark:bg-white/5 hover:border-emerald-400 px-2.5 py-1.5 text-sm text-left"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{m.name}</p>
                      <p className="text-[11px] text-black/50 dark:text-white/50 truncate">
                        ৳{Number(m.price || 0).toFixed(0)}
                        {m.category ? ` · ${m.category}` : ""}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 inline-flex items-center gap-1 text-xs font-semibold ${
                        already
                          ? "text-emerald-600"
                          : "text-emerald-700 dark:text-emerald-300"
                      }`}
                    >
                      {already ? (
                        <>
                          <CheckCircle2 size={12} /> +1
                        </>
                      ) : (
                        <>
                          <Plus size={12} /> Add
                        </>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- New: handshake + dual-confirm sub-components ---------- */

function AwaitingPharmacyStep({
  handshake,
  states,
  onOpenChat,
}: {
  handshake: HandshakeResp;
  states: Record<string, PharmacyState>;
  onOpenChat: () => void;
}) {
  const total = handshake.conversations.length;
  const okCount = handshake.conversations.filter(
    (c) => states[c.conversation_id] === "pharmacy_ok",
  ).length;
  const rejectedCount = handshake.conversations.filter(
    (c) => states[c.conversation_id] === "pharmacy_rejected",
  ).length;
  const settled = okCount + rejectedCount;
  const isSplit = handshake.is_split || total > 1;
  return (
    <div className="px-5 py-6 space-y-4">
      <div className="flex items-start gap-3 rounded-2xl border border-brand-300/40 bg-brand-50/60 dark:bg-brand-500/10 p-4">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-500 text-white">
          <Sparkles size={18} />
        </div>
        <div className="text-sm flex-1">
          <p className="font-bold mb-1">
            {isSplit
              ? `medi AI ${total}টি pharmacy-কে একসাথে stock check করতে পাঠিয়েছে`
              : "medi AI pharmacy-কে stock check করতে পাঠিয়েছে"}
          </p>
          <p className="text-black/65 dark:text-white/65 leading-relaxed">
            Pharmacy reply দিলে এই window-এ আর chat — দুই জায়গায় Final Confirm button active হবে। এখনো credit consume হয়নি — Confirm দিলে 1 credit কাটবে।
          </p>
        </div>
      </div>

      {isSplit && (
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-white dark:bg-white/5 border border-black/5 dark:border-white/10 px-4 py-2.5">
          <div className="flex items-center gap-2 text-xs font-medium text-black/65 dark:text-white/70">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-500 text-white text-[11px] font-bold">
              {settled}/{total}
            </span>
            <span>
              {okCount > 0 && (
                <span className="text-emerald-600 dark:text-emerald-300 font-semibold">
                  {okCount} ready
                </span>
              )}
              {okCount > 0 && rejectedCount > 0 && <span className="mx-1">·</span>}
              {rejectedCount > 0 && (
                <span className="text-rose-600 dark:text-rose-300 font-semibold">
                  {rejectedCount} unavailable
                </span>
              )}
              {settled === 0 && <span>সব pharmacy এখনো reply দিচ্ছে…</span>}
            </span>
          </div>
          <div className="flex-1 h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden max-w-[40%]">
            <div
              className="h-full bg-gradient-to-r from-brand-400 to-brand-600 transition-all"
              style={{ width: `${(settled / total) * 100}%` }}
            />
          </div>
        </div>
      )}

      <div className="space-y-2">
        {handshake.conversations.map((c) => {
          const s = states[c.conversation_id] || "awaiting_pharmacy";
          return (
            <div
              key={c.conversation_id}
              className="flex items-center gap-3 rounded-2xl border border-black/5 dark:border-white/10 bg-white dark:bg-white/5 p-3"
            >
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-500/10 text-brand-700 dark:text-brand-300">
                <Pill size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate">{c.pharmacy_name}</p>
                <p className="text-[11px] text-black/55 dark:text-white/55">
                  {s === "awaiting_pharmacy" && "Pharmacy stock check করছে…"}
                  {s === "pharmacy_ok" && "✅ Pharmacy stock confirm করেছে"}
                  {s === "pharmacy_rejected" && "❌ Pharmacy stock unavailable"}
                </p>
              </div>
              {s === "awaiting_pharmacy" && (
                <Loader2 size={18} className="animate-spin text-brand-600" />
              )}
              {s === "pharmacy_ok" && <CheckCircle2 size={20} className="text-emerald-500" />}
              {s === "pharmacy_rejected" && <XCircle size={20} className="text-rose-500" />}
            </div>
          );
        })}
      </div>

      <button
        onClick={onOpenChat}
        className="w-full rounded-full border border-black/10 dark:border-white/10 px-4 py-2.5 text-sm font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-500/10"
      >
        Chat খুলে pharmacy-এর reply দেখুন
      </button>
    </div>
  );
}

function ReadyToConfirmStep({
  handshake,
  states,
  scan,
  onConfirm,
  onOpenChat,
  onCancel,
}: {
  handshake: HandshakeResp;
  states: Record<string, PharmacyState>;
  scan: ScanResp | null;
  onConfirm: () => void;
  onOpenChat: () => void;
  onCancel: () => void;
}) {
  const okConvs = handshake.conversations.filter(
    (c) => states[c.conversation_id] === "pharmacy_ok",
  );
  const rejectedConvs = handshake.conversations.filter(
    (c) => states[c.conversation_id] === "pharmacy_rejected",
  );
  const pendingConvs = handshake.conversations.filter(
    (c) => (states[c.conversation_id] || "awaiting_pharmacy") === "awaiting_pharmacy",
  );
  const isSplit = handshake.is_split || handshake.conversations.length > 1;
  // Per-pharmacy price lookup for chip display
  const priceFor = (pharmacyId: string): number | null => {
    if (!scan || !scan.ok) return null;
    const p = scan.proposals.find((pp) => pp.pharmacy.id === pharmacyId);
    return p ? p.total : null;
  };
  // Total only across confirmed plans
  let total = 0;
  if (scan && scan.ok) {
    for (const c of okConvs) {
      const p = scan.proposals.find((pp) => pp.pharmacy.id === c.pharmacy_id);
      if (p) total += p.total;
    }
  }
  return (
    <div className="px-5 py-6 space-y-4">
      <div className="flex items-start gap-3 rounded-2xl border border-emerald-300/50 bg-emerald-50 dark:bg-emerald-500/10 p-4">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-500 text-white">
          <CheckCircle2 size={18} />
        </div>
        <div className="text-sm">
          <p className="font-bold mb-1">
            {isSplit && okConvs.length > 1
              ? `${okConvs.length}টি pharmacy ready — এখন Final Confirm দিন`
              : "Pharmacy ready — এখন Final Confirm দিন"}
          </p>
          <p className="text-black/65 dark:text-white/65 leading-relaxed">
            Confirm দিলে 1 Smart Prescription credit consume হবে এবং pharmacy প্রকৃত order pabe। Chat এতেও একটি "Confirm final order" card আছে — যেকোন একজায়গায় Confirm করলেই চলবে।
          </p>
        </div>
      </div>

      {pendingConvs.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-amber-300/40 bg-amber-50 dark:bg-amber-500/10 px-4 py-2.5 text-[12px]">
          <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
          <p className="text-amber-800 dark:text-amber-200 leading-snug">
            <span className="font-semibold">{pendingConvs.length}টি pharmacy</span> এখনো reply দেয়নি।
            অপেক্ষা করতে পারেন, অথবা এখনই Final Confirm দিলে শুধু ready pharmacy-তেই order যাবে।
          </p>
        </div>
      )}

      <div className="space-y-2">
        {okConvs.map((c) => {
          const price = priceFor(c.pharmacy_id);
          return (
            <div
              key={c.conversation_id}
              className="flex items-center gap-3 rounded-2xl border border-emerald-300/40 bg-white dark:bg-white/5 p-3"
            >
              <CheckCircle2 size={20} className="text-emerald-500 shrink-0" />
              <p className="text-sm font-semibold flex-1 truncate">{c.pharmacy_name}</p>
              {price != null && (
                <span className="text-[12px] font-bold tabular-nums text-brand-700 dark:text-brand-300">
                  ৳{price.toFixed(0)}
                </span>
              )}
              <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                ready
              </span>
            </div>
          );
        })}
        {pendingConvs.map((c) => (
          <div
            key={c.conversation_id}
            className="flex items-center gap-3 rounded-2xl border border-black/5 dark:border-white/10 bg-white dark:bg-white/5 p-3"
          >
            <Loader2 size={18} className="animate-spin text-brand-600 shrink-0" />
            <p className="text-sm font-semibold flex-1 truncate">{c.pharmacy_name}</p>
            <span className="text-[11px] font-medium text-black/55 dark:text-white/55">
              এখনো অপেক্ষা…
            </span>
          </div>
        ))}
        {rejectedConvs.map((c) => (
          <div
            key={c.conversation_id}
            className="flex items-center gap-3 rounded-2xl border border-rose-300/40 bg-white dark:bg-white/5 p-3 opacity-70"
          >
            <XCircle size={20} className="text-rose-500 shrink-0" />
            <p className="text-sm font-semibold flex-1 truncate line-through">{c.pharmacy_name}</p>
            <span className="text-[11px] font-medium text-rose-600 dark:text-rose-300">
              unavailable
            </span>
          </div>
        ))}
      </div>

      {total > 0 && (
        <div className="rounded-2xl bg-brand-500/10 px-4 py-3 text-sm">
          {isSplit && okConvs.length > 1 ? (
            <>
              <div className="space-y-1 mb-2">
                {okConvs.map((c) => {
                  const price = priceFor(c.pharmacy_id);
                  if (price == null) return null;
                  return (
                    <div
                      key={c.conversation_id}
                      className="flex items-center justify-between text-[12px] text-black/70 dark:text-white/70"
                    >
                      <span className="truncate">{c.pharmacy_name}</span>
                      <span className="tabular-nums font-medium">৳{price.toFixed(0)}</span>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-black/10 dark:border-white/10 font-bold text-brand-800 dark:text-brand-200">
                <span>মোট ({okConvs.length} pharmacy মিলিয়ে)</span>
                <span className="tabular-nums">৳{total.toFixed(0)}</span>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between font-semibold text-brand-800 dark:text-brand-200">
              <span>Total</span>
              <span className="tabular-nums">৳{total.toFixed(0)}</span>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <button
          onClick={onCancel}
          className="rounded-full bg-black/5 dark:bg-white/10 px-4 py-2 text-sm hover:bg-black/10"
        >
          Cancel
        </button>
        <button
          onClick={onOpenChat}
          className="rounded-full border border-black/10 dark:border-white/10 px-4 py-2 text-sm hover:bg-brand-50 dark:hover:bg-brand-500/10"
        >
          Chat-এ দেখুন
        </button>
        <button
          onClick={onConfirm}
          disabled={okConvs.length === 0}
          className="ml-auto inline-flex items-center gap-2 rounded-full bg-emerald-600 disabled:bg-black/20 disabled:dark:bg-white/15 disabled:cursor-not-allowed px-6 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 transition shadow-lg shadow-emerald-500/30"
        >
          <CheckCircle2 size={14} />
          Final Confirm — Order পাঠান
        </button>
      </div>
    </div>
  );
}