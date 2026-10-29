"use client";

/**
 * Smart Prescription AI flow.
 *
 *  1. Customer uploads a prescription image (camera or gallery).
 *  2. POST `/api/ai/prescription-scan` → Gemini Vision extracts medicines
 *     and proposes nearby pharmacies.
 *  3. Customer picks one proposal → POST `/api/ai/prescription-handshake`.
 *  4. Pharmacy confirms stock → customer final-confirms → `/prescription-dispatch`.
 *  5. Route to `/chats/<conversation_id>`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Camera, CheckCircle2, Loader2, MapPin, Plus, Search, Send, Sparkles, Star, Upload, XCircle } from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { api, resolveMediaUrl, session, uploadImage } from "@/lib/api";
import { fetchPharmacy, userLocation, type StorefrontMedicine } from "@/lib/storefront";

type ExtraItem = {
  medicine_id: string;
  name: string;
  qty: number;
  unit_price: number;
  image_url: string | null;
};

type ProposalItem = {
  medicine_id: string;
  name: string;
  rx_name?: string | null;
  rx_strength?: string | null;
  rx_instructions?: string | null;
  qty: number;
  unit_price: number;
  image_url?: string | null;
  prescription_required?: boolean;
  match_score?: number;
};

type ProposalMissing = {
  rx_name: string;
  rx_strength?: string | null;
  qty: number;
  instructions?: string | null;
};

type ProposalPharmacy = {
  id: string;
  name: string;
  business_name?: string | null;
  banner_photo_url?: string | null;
  rating?: number | null;
  rating_count?: number | null;
  is_verified?: boolean;
  subscription_tier?: string | null;
  phone_number?: string | null;
};

type Proposal = {
  pharmacy: ProposalPharmacy;
  items: ProposalItem[];
  missing: ProposalMissing[];
  coverage_pct: number;
  subtotal: number;
  delivery_fee: number;
  total: number;
  distance_km?: number | null;
  eta_min?: number | null;
};

type ScanAi = {
  medicines: Array<{ name: string; strength?: string; quantity?: number }>;
  doctor_name?: string;
  doctor_specialty?: string;
  patient_name?: string;
  notes?: string;
};

type ScanResp =
  | {
      ok: true;
      ai: ScanAi;
      proposals: Proposal[];
      usage?: { used: number; limit: number };
    }
  | {
      ok: false;
      code: "ai_busy" | "not_prescription" | "no_image" | "no_pharmacies";
      message: string;
      ai?: ScanAi;
    };

type HandshakeResp = {
  ok: boolean;
  conversation_id: string;
  handshake_id: string;
  pharmacy_id: string;
  pharmacy_name: string;
  conversations: Array<{
    conversation_id: string;
    handshake_id: string;
    pharmacy_id: string;
    pharmacy_name: string;
  }>;
};

type ChatMessage = {
  id: string;
  preset_key: string | null;
  payload?: { handshake_id?: string; status?: string } | null;
};

function distanceLabel(distanceKm?: number | null): string {
  return typeof distanceKm === "number" && Number.isFinite(distanceKm)
    ? `${distanceKm.toFixed(distanceKm < 10 ? 1 : 0)} km`
    : "Nearby";
}

function errorHeading(message: string): string {
  if (/limit শেষ/.test(message)) return "Smart Prescription limit শেষ";
  if (/stock unavailable|stock নেই|pharmacy stock/i.test(message)) return "Pharmacy stock নেই";
  return "Prescription scan করা যায়নি";
}

function errorBody(message: string): string {
  if (/limit শেষ/.test(message)) {
    return "এই মাসের free AI scan quota শেষ হয়েছে। Profile থেকে quota renew করুন, অথবা পরের মাসে quota reset হলে আবার ব্যবহার করুন।";
  }
  return message;
}

export default function PrescriptionPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [stage, setStage] = useState<"idle" | "uploading" | "scanning" | "results" | "handshaking" | "awaiting_pharmacy" | "ready_to_confirm" | "final_dispatching">("idle");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedProposal, setSelectedProposal] = useState<Proposal | null>(null);
  const [handshake, setHandshake] = useState<HandshakeResp | null>(null);
  // Per-pharmacy customer-added OTC extras
  const [extrasByPharmacy, setExtrasByPharmacy] = useState<Record<string, ExtraItem[]>>({});

  useEffect(() => {
    if (!session.access()) {
      router.replace(`/login?role=customer&next=${encodeURIComponent("/prescription")}`);
      return;
    }
    const role = session.role();
    if (role && role !== "customer") {
      router.replace("/login?role=customer&msg=customer-only");
    }
  }, [router]);

  const reset = () => {
    setStage("idle");
    setImageUrl(null);
    setScan(null);
    setError(null);
    setSelectedProposal(null);
    setHandshake(null);
    setExtrasByPharmacy({});
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const buildPlan = (p: Proposal) => {
    const extras = (extrasByPharmacy[p.pharmacy.id] || []).map((it) => ({
      medicine_id: it.medicine_id,
      name: it.name,
      qty: it.qty,
      unit_price: it.unit_price,
      prescription_required: false,
      rx_strength: "",
      rx_instructions: "",
    }));
    const rxItems = p.items.map((it) => ({
      medicine_id: it.medicine_id,
      name: it.name,
      qty: it.qty,
      unit_price: it.unit_price,
      prescription_required: !!it.prescription_required,
      rx_strength: it.rx_strength ?? "",
      rx_instructions: it.rx_instructions ?? "",
    }));
    const items = [...rxItems, ...extras];
    const extrasSubtotal = extras.reduce((s, it) => s + it.unit_price * it.qty, 0);
    const subtotal = p.subtotal + extrasSubtotal;
    return {
      pharmacy_id: p.pharmacy.id,
      items,
      subtotal,
      delivery_fee: p.delivery_fee,
      total: subtotal + p.delivery_fee,
    };
  };

  const onFile = async (file: File) => {
    if (!session.access() || session.role() !== "customer") {
      router.push(`/login?role=customer&next=${encodeURIComponent("/prescription")}`);
      return;
    }
    setError(null);
    setStage("uploading");
    try {
      const url = await uploadImage(file);
      setImageUrl(url);
      setStage("scanning");
      const loc = userLocation.load();
      const res = await api<ScanResp>("/api/ai/prescription-scan", {
        method: "POST",
        body: JSON.stringify({
          image_url: url,
          lat: loc?.lat ?? null,
          lng: loc?.lng ?? null,
          radius_km: 5,
        }),
      });
      setScan(res);
      setStage("results");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
      setStage("idle");
    }
  };

  const onDispatch = async (p: Proposal) => {
    if (!imageUrl) return;
    if (!session.access() || session.role() !== "customer") {
      router.push(`/login?role=customer&next=${encodeURIComponent("/prescription")}`);
      return;
    }
    setStage("handshaking");
    setError(null);
    setSelectedProposal(p);
    try {
      const loc = userLocation.load();
      const ai = scan && scan.ok ? scan.ai : null;
      const res = await api<HandshakeResp>("/api/ai/prescription-handshake", {
        method: "POST",
        body: JSON.stringify({
          prescription_url: imageUrl,
          plans: [buildPlan(p)],
          note: ai?.notes,
          delivery_address: loc?.label ?? undefined,
          delivery_lat: loc?.lat ?? undefined,
          delivery_lng: loc?.lng ?? undefined,
        }),
      });
      setHandshake(res);
      setStage("awaiting_pharmacy");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pharmacy check failed");
      setStage("results");
    }
  };

  useEffect(() => {
    if (!handshake || (stage !== "awaiting_pharmacy" && stage !== "ready_to_confirm")) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    const poll = async () => {
      try {
        const rows = await api<ChatMessage[]>(`/api/conversations/${handshake.conversation_id}/messages`);
        for (let i = rows.length - 1; i >= 0; i--) {
          const message = rows[i];
          const payload = message.payload || {};
          if (payload.handshake_id && payload.handshake_id !== handshake.handshake_id) continue;
          if (message.preset_key === "ai_customer_confirm_prompt") {
            setStage("ready_to_confirm");
            return;
          }
          if (message.preset_key === "ai_handshake_rejected") {
            setError("Pharmacy stock unavailable বলেছে। অন্য pharmacy try করুন।");
            setStage("results");
            return;
          }
        }
      } catch {
        // keep polling; chat may be momentarily unavailable
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
  }, [handshake, stage]);

  const finalConfirm = async () => {
    if (!imageUrl || !selectedProposal || !handshake) return;
    setStage("final_dispatching");
    setError(null);
    try {
      const loc = userLocation.load();
      const ai = scan && scan.ok ? scan.ai : null;
      const res = await api<{ conversation_id: string }>("/api/ai/prescription-dispatch", {
        method: "POST",
        body: JSON.stringify({
          prescription_url: imageUrl,
          plans: [buildPlan(selectedProposal)],
          handshake_ids: [handshake.handshake_id],
          note: ai?.notes,
          delivery_address: loc?.label ?? undefined,
          delivery_lat: loc?.lat ?? undefined,
          delivery_lng: loc?.lng ?? undefined,
        }),
      });
      router.push(`/chats/${res.conversation_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Final confirm failed");
      setStage("ready_to_confirm");
    }
  };

  const cancelHandshake = async () => {
    if (!handshake) {
      setStage("results");
      return;
    }
    try {
      await api(`/api/conversations/${handshake.conversation_id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          body: "🚫 Order cancel করেছি।",
          preset_key: "customer_handshake_cancel",
          payload: { handshake_id: handshake.handshake_id },
        }),
      });
    } catch {
      // The timeout cleanup will still close this on the server if needed.
    }
    setHandshake(null);
    setSelectedProposal(null);
    setStage("results");
  };

  return (
    <>
      <MobileHeader title="Smart Prescription" subtitle="Powered by medi AI" />

      <div className="space-y-3 px-4 pt-3">
        {error && (
          <div
            className={`rounded-2xl border p-3 text-xs ${
              /limit শেষ/.test(error)
                ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                : "border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300"
            }`}
          >
            <p className="font-semibold">
              {errorHeading(error)}
            </p>
            <p className="mt-1 leading-relaxed">
              {errorBody(error)}
            </p>
          </div>
        )}

        {stage === "idle" && (
          <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
            <div className="bg-gradient-to-br from-brand-500 to-brand-600 px-4 py-5 text-white">
              <div className="flex items-start gap-3">
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white/20 backdrop-blur">
                  <Sparkles size={24} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-white/75">Powered by medi AI</p>
                  <h2 className="mt-1 text-lg font-bold leading-tight">Prescription upload korlei order ready</h2>
                  <p className="mt-1 text-xs leading-relaxed text-white/85">
                    AI medicine পড়বে, কাছের rated pharmacy match করবে, তারপর আপনি শুধু confirm করবেন।
                  </p>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[10px] font-medium">
                <StepPill n={1} label="Upload" />
                <StepPill n={2} label="AI scan" />
                <StepPill n={3} label="Send chat" />
              </div>
            </div>

            <div className="space-y-4 p-4">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="tap w-full rounded-2xl border-2 border-dashed border-brand-300 bg-gradient-to-b from-brand-50/80 to-white px-4 py-7 text-center transition active:scale-[0.99] dark:border-brand-500/40 dark:from-brand-500/10 dark:to-[#0d141d]"
              >
                <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg shadow-brand-500/30">
                  <Upload size={25} />
                </span>
                <span className="mt-3 block text-sm font-semibold text-slate-900 dark:text-white/90">
                  ছবি তুলুন বা gallery থেকে prescription দিন
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-slate-500 dark:text-white/55">
                  JPG / PNG / WebP · handwriting clear হলে result ভালো হবে
                </span>
                <span className="mt-3 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm dark:bg-white/10 dark:text-white/80">
                  <Camera size={13} /> Camera / Gallery
                </span>
              </button>

              <div className="grid grid-cols-3 gap-2">
                <InfoTile icon={<CheckCircle2 size={15} />} title="Medicine পড়বে" body="নাম, strength, qty" />
                <InfoTile icon={<Star size={15} />} title="Best pharmacy" body="rating + nearby stock" />
                <InfoTile icon={<Send size={15} />} title="Chat খুলবে" body="confirm করলে pharmacy পাবে" />
              </div>

              <div className="rounded-2xl border border-brand-200 bg-brand-50/70 p-3 dark:border-brand-500/25 dark:bg-brand-500/10">
                <p className="text-xs font-semibold text-brand-800 dark:text-brand-200">Upload করলে কী হবে?</p>
                <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
                  <li>• Doctor-এর লেখা medicine গুলো AI extract করবে।</li>
                  <li>• আপনার location ধরে nearby pharmacy inventory match করবে।</li>
                  <li>• মোট দাম, delivery fee, missing medicine সব দেখাবে।</li>
                  <li>• Confirm করলে pharmacy chat-এ order request চলে যাবে।</li>
                </ul>
              </div>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
                e.currentTarget.value = "";
              }}
            />
          </section>
        )}

        {(stage === "uploading" || stage === "scanning" || stage === "handshaking" || stage === "final_dispatching") && (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white p-6 text-center dark:border-white/10 dark:bg-white/[0.04]">
            <Loader2 size={26} className="animate-spin text-brand-500" />
            <p className="text-xs text-slate-500">
              {stage === "uploading" && "Uploading…"}
              {stage === "scanning" && "medi AI prescription পড়ছে…"}
              {stage === "handshaking" && "Pharmacy stock check শুরু হচ্ছে…"}
              {stage === "final_dispatching" && "Final order pharmacy-তে পাঠাচ্ছি…"}
            </p>
            {imageUrl && (
              <div className="relative mt-2 h-44 w-full overflow-hidden rounded-xl bg-black/5">
                <Image src={resolveMediaUrl(imageUrl)} alt="prescription" fill sizes="320px" className="object-contain" />
              </div>
            )}
          </div>
        )}

        {(stage === "awaiting_pharmacy" || stage === "ready_to_confirm") && handshake && selectedProposal && (
          <section className="rounded-3xl border border-emerald-200 bg-white p-4 shadow-sm dark:border-emerald-500/25 dark:bg-white/[0.04]">
            <div className="flex items-start gap-3">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                {stage === "awaiting_pharmacy" ? <Loader2 size={20} className="animate-spin" /> : <CheckCircle2 size={22} />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-slate-900 dark:text-white/90">
                  {stage === "awaiting_pharmacy" ? "Pharmacy stock check করছে" : "Pharmacy ready — final confirm দিন"}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  {selectedProposal.pharmacy.name} prescription-এর item গুলো verify করছে। Confirm না করা পর্যন্ত credit কাটা হবে না।
                </p>
              </div>
            </div>
            <div className="mt-3 rounded-2xl bg-emerald-50 p-3 text-xs dark:bg-emerald-500/10">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{selectedProposal.pharmacy.name}</span>
                <span className="font-bold text-emerald-700 dark:text-emerald-300">৳{(buildPlan(selectedProposal).total).toFixed(0)}</span>
              </div>
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                {buildPlan(selectedProposal).items.length} item · {distanceLabel(selectedProposal.distance_km)}
              </p>
            </div>
            {error && <p className="mt-3 rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">{error}</p>}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => router.push(`/chats/${handshake.conversation_id}`)}
                className="tap rounded-full border border-slate-200 px-3 py-2 text-xs font-semibold dark:border-white/10"
              >
                Chat খুলুন
              </button>
              {stage === "awaiting_pharmacy" ? (
                <button
                  type="button"
                  onClick={() => void cancelHandshake()}
                  className="tap rounded-full bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-600 dark:text-rose-300"
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void finalConfirm()}
                  className="tap rounded-full bg-emerald-600 px-3 py-2 text-xs font-bold text-white"
                >
                  Final Confirm
                </button>
              )}
            </div>
          </section>
        )}

        {stage === "results" && scan && (
          <>
            {imageUrl && (
              <div className="relative h-40 w-full overflow-hidden rounded-2xl border border-slate-200 dark:border-white/10">
                <Image src={resolveMediaUrl(imageUrl)} alt="prescription" fill sizes="480px" className="object-contain bg-white" />
              </div>
            )}

            {scan.ok ? (
              <>
                {scan.ai.doctor_specialty && (
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Doctor specialty: <strong>{scan.ai.doctor_specialty}</strong>
                  </p>
                )}

                {scan.proposals.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.02]">
                    <p>আশেপাশে কোনও pharmacy পেলাম না। Location update করুন বা পরে চেষ্টা করুন।</p>
                    <button onClick={reset} className="tap mt-3 rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white">
                      Try again
                    </button>
                  </div>
                )}

                {scan.proposals.map((p, i) => (
                  <ProposalCard
                    key={p.pharmacy.id + i}
                    p={p}
                    extras={extrasByPharmacy[p.pharmacy.id] || []}
                    onAddExtra={(item) =>
                      setExtrasByPharmacy((prev) => {
                        const cur = prev[p.pharmacy.id] || [];
                        const idx = cur.findIndex((x) => x.medicine_id === item.medicine_id);
                        if (idx >= 0) {
                          const copy = [...cur];
                          copy[idx] = { ...copy[idx], qty: copy[idx].qty + 1 };
                          return { ...prev, [p.pharmacy.id]: copy };
                        }
                        return { ...prev, [p.pharmacy.id]: [...cur, item] };
                      })
                    }
                    onChangeExtraQty={(medicineId, delta) =>
                      setExtrasByPharmacy((prev) => {
                        const cur = prev[p.pharmacy.id] || [];
                        const idx = cur.findIndex((x) => x.medicine_id === medicineId);
                        if (idx < 0) return prev;
                        const next = Math.max(0, cur[idx].qty + delta);
                        if (next === 0) {
                          return { ...prev, [p.pharmacy.id]: cur.filter((_, k) => k !== idx) };
                        }
                        const copy = [...cur];
                        copy[idx] = { ...copy[idx], qty: next };
                        return { ...prev, [p.pharmacy.id]: copy };
                      })
                    }
                    onRemoveExtra={(medicineId) =>
                      setExtrasByPharmacy((prev) => ({
                        ...prev,
                        [p.pharmacy.id]: (prev[p.pharmacy.id] || []).filter((x) => x.medicine_id !== medicineId),
                      }))
                    }
                    onPick={() => onDispatch(p)}
                  />
                ))}
              </>
            ) : (
              <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 text-center text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                <p className="font-medium">{scan.message}</p>
                <button onClick={reset} className="tap mt-3 rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white">
                  আবার চেষ্টা করুন
                </button>
              </div>
            )}

            <button onClick={reset} className="tap mx-auto block text-xs text-slate-500 underline">
              Upload a different prescription
            </button>
          </>
        )}
      </div>
    </>
  );
}

function ProposalCard({
  p,
  onPick,
  extras,
  onAddExtra,
  onChangeExtraQty,
  onRemoveExtra,
}: {
  p: Proposal;
  onPick: () => void;
  extras: ExtraItem[];
  onAddExtra: (item: ExtraItem) => void;
  onChangeExtraQty: (medicineId: string, delta: number) => void;
  onRemoveExtra: (medicineId: string) => void;
}) {
  const banner = resolveMediaUrl(p.pharmacy.banner_photo_url);
  const extrasSubtotal = extras.reduce((s, it) => s + it.unit_price * it.qty, 0);
  const liveSubtotal = p.subtotal + extrasSubtotal;
  const liveTotal = p.total + extrasSubtotal;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-white/[0.04]">
      <div className="flex items-center gap-3">
        <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-slate-200 dark:bg-white/10">
          {banner && <Image src={banner} alt={p.pharmacy.name} fill sizes="48px" className="object-cover" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{p.pharmacy.name}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            <MapPin size={10} className="-mt-0.5 mr-0.5 inline" />
            {distanceLabel(p.distance_km)} · ৳{p.delivery_fee} delivery
          </p>
        </div>
        {p.coverage_pct != null && (
          <span className="shrink-0 rounded-full bg-brand-50 px-2 py-1 text-[10px] font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
            {Math.round(p.coverage_pct)}% match
          </span>
        )}
      </div>

      <ul className="mt-3 space-y-1.5 text-xs">
        {p.items.slice(0, 6).map((it) => (
          <li key={it.medicine_id} className="flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{it.name}</span>
              {it.rx_strength && <span className="ml-1 text-slate-500">· {it.rx_strength}</span>}
              <span className="ml-1 text-slate-400">×{it.qty}</span>
            </span>
            <span className="shrink-0 font-semibold">৳{(it.unit_price * it.qty).toFixed(0)}</span>
          </li>
        ))}
        {p.items.length > 6 && (
          <li className="text-[11px] text-slate-500">+ আরও {p.items.length - 6}টি item</li>
        )}
        {p.missing.length > 0 && (
          <li className="text-[11px] text-amber-600 dark:text-amber-400">
            অনুপস্থিত: {p.missing.map((m) => m.rx_name).join(", ")}
          </li>
        )}
      </ul>

      <MobileOtcAddSection
        pharmacyId={p.pharmacy.id}
        pharmacyName={p.pharmacy.name}
        extras={extras}
        excludeIds={new Set(p.items.map((it) => it.medicine_id))}
        onAdd={onAddExtra}
        onChangeQty={onChangeExtraQty}
        onRemove={onRemoveExtra}
      />

      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2 text-xs dark:border-white/10">
        <span className="text-slate-500">
          Subtotal ৳{liveSubtotal.toFixed(0)} · Delivery ৳{p.delivery_fee}
        </span>
        <span className="font-bold text-brand-600 dark:text-brand-300">৳{liveTotal.toFixed(0)}</span>
      </div>

      <button
        onClick={onPick}
        className="tap mt-3 w-full rounded-full bg-brand-500 py-2 text-xs font-semibold text-white"
      >
        এই pharmacy-তে stock check পাঠান
      </button>
    </div>
  );
}

function MobileOtcAddSection({
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
  onAdd: (item: ExtraItem) => void;
  onChangeQty: (medicineId: string, delta: number) => void;
  onRemove: (medicineId: string) => void;
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
    if (!q) return base.slice(0, 6);
    return base
      .filter((m) => m.name.toLowerCase().includes(q) || (m.category || "").toLowerCase().includes(q))
      .slice(0, 10);
  }, [catalog, query, excludeIds]);

  const extrasSubtotal = extras.reduce((s, it) => s + it.unit_price * it.qty, 0);

  return (
    <div className="mt-3 rounded-xl border border-dashed border-emerald-300/50 bg-emerald-50/40 p-2.5 dark:border-emerald-500/30 dark:bg-emerald-500/5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-emerald-700 dark:text-emerald-300">
          <Plus size={12} />
          {extras.length > 0
            ? `+${extras.length} OTC · ৳${extrasSubtotal.toFixed(0)}`
            : "আরও OTC যোগ করুন"}
        </span>
        <span className="text-[10px] text-slate-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-2 grid gap-2">
          {extras.length > 0 && (
            <div className="grid gap-1">
              {extras.map((it) => (
                <div
                  key={it.medicine_id}
                  className="flex items-center justify-between gap-2 rounded-md bg-white px-2 py-1 text-[12px] dark:bg-white/5"
                >
                  <span className="min-w-0 flex-1 truncate">
                    <CheckCircle2 size={11} className="-mt-0.5 mr-1 inline text-emerald-500" />
                    {it.name}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => onChangeQty(it.medicine_id, -1)}
                      className="grid h-5 w-5 place-items-center rounded bg-slate-100 text-xs dark:bg-white/10"
                    >
                      −
                    </button>
                    <span className="w-5 text-center text-[11px] font-semibold tabular-nums">{it.qty}</span>
                    <button
                      onClick={() => onChangeQty(it.medicine_id, +1)}
                      className="grid h-5 w-5 place-items-center rounded bg-slate-100 text-xs dark:bg-white/10"
                    >
                      +
                    </button>
                    <span className="ml-1 w-12 text-right text-[11px] font-semibold tabular-nums">
                      ৳{(it.unit_price * it.qty).toFixed(0)}
                    </span>
                    <button
                      onClick={() => onRemove(it.medicine_id)}
                      className="grid h-5 w-5 place-items-center text-rose-500"
                    >
                      <XCircle size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`${pharmacyName}-এর OTC`}
              className="w-full rounded-md border border-slate-200 bg-white py-1 pl-6 pr-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-emerald-400 dark:border-white/10 dark:bg-white/5"
            />
          </div>

          {loading && <p className="text-center text-[11px] text-slate-400">load হচ্ছে…</p>}
          {!loading && loaded && filtered.length === 0 && (
            <p className="text-center text-[11px] text-slate-400">{query ? "মিল নেই।" : "OTC item নেই।"}</p>
          )}
          {!loading && filtered.length > 0 && (
            <div className="grid max-h-44 gap-1 overflow-y-auto">
              {filtered.map((m) => {
                const already = extras.some((x) => x.medicine_id === m.id);
                return (
                  <button
                    key={m.id}
                    onClick={() =>
                      onAdd({
                        medicine_id: m.id,
                        name: m.name,
                        qty: 1,
                        unit_price: Number(m.price || 0),
                        image_url: m.image_url ?? null,
                      })
                    }
                    className="flex items-center justify-between gap-2 rounded-md bg-white px-2 py-1 text-left text-[12px] hover:border hover:border-emerald-400 dark:bg-white/5"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{m.name}</p>
                      <p className="text-[10px] text-slate-500">৳{Number(m.price || 0).toFixed(0)}</p>
                    </div>
                    <span className="shrink-0 text-[11px] font-semibold text-emerald-600">
                      {already ? "+1" : "Add"}
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

function StepPill({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-2xl bg-white/15 px-2 py-2 backdrop-blur">
      <span className="mx-auto mb-1 grid h-5 w-5 place-items-center rounded-full bg-white text-[10px] font-bold text-brand-600">
        {n}
      </span>
      <span className="block truncate text-white/90">{label}</span>
    </div>
  );
}

function InfoTile({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-2.5 text-center dark:bg-white/[0.05]">
      <div className="mx-auto mb-1 grid h-7 w-7 place-items-center rounded-full bg-brand-500/10 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
        {icon}
      </div>
      <p className="text-[11px] font-semibold leading-tight text-slate-900 dark:text-white/90">{title}</p>
      <p className="mt-0.5 text-[10px] leading-tight text-slate-500 dark:text-slate-400">{body}</p>
    </div>
  );
}
