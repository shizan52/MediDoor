"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  CalendarX,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import {
  pharmacyApi,
  type PharmacyMe,
  type VerificationDetail,
  type VerificationStatus,
} from "@/lib/pharmacy";

// Human labels for the DGDA verification fields, keyed by their API name.
const VERIFY_FIELD_LABELS: Record<string, string> = {
  pharmacy_name: "Pharmacy name",
  owner_name: "Owner / manager name",
  pharmacy_license_no: "Pharmacy license no.",
  pharmacist_name: "Registered pharmacist name",
  pharmacist_reg_no: "Pharmacist registration no.",
};

/**
 * Turn a raw `API 4xx: {json}` error into a short, human, Bengali-friendly
 * line. Pharmacists must never see raw pydantic validation JSON (Problem 5).
 */
function friendlyVerifyError(raw: string): string {
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) return raw;
  try {
    const parsed = JSON.parse(raw.slice(jsonStart));
    const detail = (parsed as { detail?: unknown })?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const fields = detail
        .map((d) => {
          const loc = (d as { loc?: (string | number)[] })?.loc ?? [];
          const key = String(loc[loc.length - 1] ?? "");
          return VERIFY_FIELD_LABELS[key] || null;
        })
        .filter((x): x is string => Boolean(x));
      const uniq = Array.from(new Set(fields));
      if (uniq.length) {
        return `${uniq.join(", ")} — এই ঘর${uniq.length > 1 ? "গুলো" : "টি"} ঠিকভাবে পূরণ করতে হবে।`;
      }
    }
  } catch {
    /* body was not JSON — fall through to the generic line */
  }
  return "তথ্য পাঠানো যায়নি — সব ঘর ঠিকভাবে পূরণ করে আবার চেষ্টা করুন।";
}

/**
 * Full-screen overlay that gates the pharmacy dashboard until the DGDA
 * verification bot has finished.
 *
 * State machine:
 *   pending   → spinner; polls /verification every 4 s while status === pending
 *   verified  → success card, fades away after 1.5 s (parent re-renders)
 *   mismatch  → show wrong fields + edit form; resubmit flips status → pending
 *               which automatically re-arms the poller (see effect below)
 *   not_found → same form, asking for the correct license number
 *   expired   → license matched but renewal date is before 2013 — block publish;
 *               Retry hits /verify-retry after the pharmacy renews.
 *   error     → retry button re-runs verification with the SAME stored values
 *
 * IMPORTANT — polling correctness:
 *   The poll loop is driven by an effect keyed on `detail?.status` so it
 *   self-heals after a resubmit: a flip from `mismatch` → `pending` (via
 *   resubmit) re-arms a fresh interval automatically. The previous version
 *   queued exactly one setTimeout chain inside `tick()` and so a flip could
 *   leave the spinner stuck indefinitely until a hard page reload.
 */
const POLL_INTERVAL_MS = 4_000;
const PROBLEM_POLL_INTERVAL_MS = 12_000; // gentle re-poll on transient failures
const SUCCESS_SPLASH_MS = 1500;

export function PharmacyVerificationGate({
  me,
  onVerified,
}: {
  me: PharmacyMe;
  onVerified: (m: PharmacyMe) => void;
}) {
  const [detail, setDetail] = useState<VerificationDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showSuccessSplash, setShowSuccessSplash] = useState(false);

  // Avoid double-firing the verified handoff (poll might race with resubmit
  // returning verified almost simultaneously).
  const verifiedHandledRef = useRef(false);

  /** Single-shot fetch — used both initially and as the poll callback. */
  const fetchOnce = useCallback(async (): Promise<VerificationDetail | null> => {
    try {
      const d = await pharmacyApi.verification();
      setDetail(d);
      setLocalError(null);
      return d;
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Verification status load failed");
      return null;
    }
  }, []);

  // Verified handoff — only fires once.
  const handleVerified = useCallback(async () => {
    if (verifiedHandledRef.current) return;
    verifiedHandledRef.current = true;
    try {
      const fresh = await pharmacyApi.me();
      setShowSuccessSplash(true);
      window.setTimeout(() => onVerified(fresh), SUCCESS_SPLASH_MS);
    } catch {
      onVerified({ ...me });
    }
  }, [me, onVerified]);

  // Initial load.
  useEffect(() => {
    void fetchOnce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll loop — re-arms whenever status changes. While "pending" we poll
  // fast; while sitting on a problem state we still gently re-poll so the
  // user sees a flip the moment a backend retry succeeds.
  useEffect(() => {
    const status = detail?.status;
    if (!status || status === "verified") return;
    const delay =
      status === "pending" ? POLL_INTERVAL_MS : PROBLEM_POLL_INTERVAL_MS;
    const id = window.setTimeout(() => void fetchOnce(), delay);
    return () => window.clearTimeout(id);
  }, [detail?.status, detail?.checked_at, fetchOnce]);

  // Whenever poll returns "verified", trigger the handoff.
  useEffect(() => {
    if (detail?.status === "verified") void handleVerified();
  }, [detail?.status, handleVerified]);

  const status: VerificationStatus = detail?.status ?? me.verification.status;

  // Already verified by the time the gate mounted — render nothing.
  if (status === "verified" && !showSuccessSplash) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="relative max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-3xl border border-white/10 bg-white shadow-2xl dark:bg-[#0e1622]"
      >
        <Header status={status} />

        <div className="space-y-4 px-6 py-5 sm:px-8">
          {status === "pending" && <PendingBody detail={detail} />}
          {status === "verified" && <VerifiedBody detail={detail} />}
          {(status === "mismatch" || status === "not_found") && (
            <ResubmitBody
              me={me}
              detail={detail}
              busy={busy}
              setBusy={setBusy}
              setLocalError={setLocalError}
              onResubmitted={(d) => setDetail(d)}
            />
          )}
          {status === "expired" && (
            <ExpiredBody
              me={me}
              detail={detail}
              busy={busy}
              setBusy={setBusy}
              setLocalError={setLocalError}
              onResubmitted={(d) => setDetail(d)}
            />
          )}
          {status === "error" && (
            <ErrorBody
              busy={busy}
              setBusy={setBusy}
              setLocalError={setLocalError}
              onResubmitted={(d) => setDetail(d)}
            />
          )}

          {localError && (
            <p className="rounded-xl border border-red-300/50 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {localError}
            </p>
          )}

          <p className="pt-2 text-[11px] leading-relaxed opacity-60">
            যাচাই হয় বাংলাদেশ সরকারের{" "}
            <a
              href="https://www.dgdagov.info/index.php/pharmacies/allopathic-retail-pharmacy"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              DGDA pharmacy registry
            </a>{" "}
            থেকে। যাচাই সম্পূর্ণ না হওয়া পর্যন্ত আপনি shop publish বা order নিতে পারবেন না।
          </p>
        </div>
      </motion.div>
    </div>
  );
}

/* -------------------------- header -------------------------- */

function Header({ status }: { status: VerificationStatus }) {
  const { Icon, color, title, subtitle } = headerCopy(status);
  return (
    <div
      className={`flex items-start gap-3 px-6 pb-4 pt-5 text-white sm:px-8 ${color}`}
    >
      <Icon size={26} className="mt-0.5 flex-shrink-0" />
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-[13px] opacity-90">{subtitle}</p>
      </div>
    </div>
  );
}

function headerCopy(status: VerificationStatus) {
  switch (status) {
    case "pending":
      return {
        Icon: Loader2,
        color: "bg-gradient-to-r from-brand-500 to-emerald-500 [&>svg]:animate-spin",
        title: "DGDA verification চলছে…",
        subtitle: "একটু অপেক্ষা করুন — তথ্য মিলিয়ে নিচ্ছি।",
      };
    case "verified":
      return {
        Icon: ShieldCheck,
        color: "bg-gradient-to-r from-emerald-500 to-brand-500",
        title: "Pharmacy verified!",
        subtitle: "আপনার সব তথ্য DGDA registry-তে মিলে গেছে।",
      };
    case "mismatch":
      return {
        Icon: ShieldAlert,
        color: "bg-gradient-to-r from-amber-500 to-rose-500",
        title: "তথ্য মিলছে না",
        subtitle: "DGDA registry-তে কিছু field ভিন্ন — ঠিক করে আবার পাঠান।",
      };
    case "not_found":
      return {
        Icon: ShieldQuestion,
        color: "bg-gradient-to-r from-amber-500 to-rose-500",
        title: "License খুঁজে পাওয়া যায়নি",
        subtitle: "DGDA registry-তে এই license number নেই।",
      };
    case "expired":
      return {
        Icon: CalendarX,
        color: "bg-gradient-to-r from-rose-500 to-rose-700",
        title: "Renewal date পুরোনো",
        subtitle: "2013 সালের আগের renewal record approve করা হবে না।",
      };
    case "error":
    default:
      return {
        Icon: AlertTriangle,
        color: "bg-gradient-to-r from-slate-600 to-slate-800",
        title: "এখন যাচাই করা যাচ্ছে না",
        subtitle: "DGDA সার্ভারে সমস্যা — কিছুক্ষণ পরে আবার চেষ্টা করুন।",
      };
  }
}

/* -------------------------- bodies -------------------------- */

function PendingBody({ detail }: { detail: VerificationDetail | null }) {
  return (
    <>
      <p className="text-sm">
        {detail?.message ??
          "আপনার pharmacy যাচাই করা হচ্ছে — কয়েক মুহূর্ত অপেক্ষা করুন…"}
      </p>
      <div className="flex items-center gap-2 text-xs opacity-70">
        <Loader2 size={14} className="animate-spin" />
        <span>প্রতি কয়েক সেকেন্ডে status আপডেট হচ্ছে।</span>
      </div>
    </>
  );
}

function VerifiedBody({ detail }: { detail: VerificationDetail | null }) {
  return (
    <>
      <div className="flex items-start gap-2 rounded-2xl border border-emerald-300/60 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-200">
        <CheckCircle2 size={18} className="mt-0.5 flex-shrink-0" />
        <p>{detail?.message ?? "আপনার pharmacy DGDA registry-তে verified।"}</p>
      </div>
      {detail?.dgda_record && <DgdaRecordCard record={detail.dgda_record} />}
    </>
  );
}

function DgdaRecordCard({ record }: { record: NonNullable<VerificationDetail["dgda_record"]> }) {
  const rows: [string, string | undefined][] = [
    ["Pharmacy", record.pharmacy_name],
    ["License", record.license_no],
    ["Code", record.pharmacy_code],
    ["Owner", record.owner_name],
    ["Pharmacist", record.drug_seller_name],
    ["Pharmacist reg.", record.drug_seller_code],
    ["District", record.district],
    ["Issued", record.issue_date],
    ["Valid until", record.valid_until],
  ];
  const expired = record.is_expired;
  return (
    <dl
      className={`grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-2xl border p-4 text-xs ${
        expired
          ? "border-rose-300/70 bg-rose-50/70 dark:border-rose-500/30 dark:bg-rose-950/20"
          : "border-black/10 bg-black/[0.02] dark:border-white/10 dark:bg-white/5"
      }`}
    >
      {rows
        .filter(([, v]) => v && v.trim() && v !== "NameofPharmacy")
        .map(([k, v]) => {
          const isExpiry = k === "Valid until" && expired;
          return (
            <div key={k} className="contents">
              <dt className="opacity-60">{k}</dt>
              <dd
                className={`font-medium ${
                  isExpiry ? "text-rose-600 dark:text-rose-300" : ""
                }`}
              >
                {v}
                {isExpiry && (
                  <span className="ml-2 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
                    old renewal
                  </span>
                )}
              </dd>
            </div>
          );
        })}
    </dl>
  );
}

function ResubmitBody({
  me,
  detail,
  busy,
  setBusy,
  setLocalError,
  onResubmitted,
}: {
  me: PharmacyMe;
  detail: VerificationDetail | null;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setLocalError: (s: string | null) => void;
  onResubmitted: (d: VerificationDetail) => void;
}) {
  const submitted = detail?.submitted ?? {
    pharmacy_name: me.pharmacy_name,
    owner_name: me.owner_name,
    pharmacy_license_no: me.pharmacy_license_no,
    pharmacist_name: me.pharmacist_name,
    pharmacist_reg_no: me.pharmacist_reg_no,
  };
  const [pn, setPn] = useState(submitted.pharmacy_name);
  const [on, setOn] = useState(submitted.owner_name);
  const [ln, setLn] = useState(submitted.pharmacy_license_no);
  const [phn, setPhn] = useState(submitted.pharmacist_name ?? "");
  const [phr, setPhr] = useState(submitted.pharmacist_reg_no ?? "");
  const mismatch = new Set(detail?.mismatch_fields ?? []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const values = {
      pharmacy_name: pn.trim(),
      owner_name: on.trim(),
      pharmacy_license_no: ln.trim(),
      pharmacist_name: phn.trim(),
      pharmacist_reg_no: phr.trim(),
    };
    // Client-side required check — every field is mandatory server-side
    // (min_length=1). Catch empties here so the pharmacist gets a clear
    // Bengali prompt instead of a raw API 422 validation error.
    const missing = Object.entries(values)
      .filter(([, v]) => !v)
      .map(([k]) => VERIFY_FIELD_LABELS[k]);
    if (missing.length) {
      setLocalError(
        `${missing.join(", ")} — এই ঘর${missing.length > 1 ? "গুলো" : "টি"} পূরণ করতে হবে।`,
      );
      return;
    }
    setBusy(true);
    try {
      await pharmacyApi.resubmitVerification(values);
      const d = await pharmacyApi.verification();
      onResubmitted(d);
    } catch (err) {
      setLocalError(friendlyVerifyError(err instanceof Error ? err.message : "Resubmit failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="text-sm">{detail?.message ?? "তথ্য ঠিক করে আবার পাঠান।"}</p>

      <form onSubmit={onSubmit} className="space-y-3">
        <Field
          label="Pharmacy license no."
          value={ln}
          onChange={setLn}
          required
          flagged={mismatch.has("pharmacy_license_no") || detail?.status === "not_found"}
        />
        <Field
          label="Pharmacy name"
          value={pn}
          onChange={setPn}
          required
          flagged={mismatch.has("pharmacy_name")}
        />
        <Field
          label="Owner / manager name"
          value={on}
          onChange={setOn}
          required
          flagged={mismatch.has("owner_name")}
        />
        <Field
          label="Registered pharmacist name"
          value={phn}
          onChange={setPhn}
          required
          flagged={mismatch.has("pharmacist_name")}
        />
        <Field
          label="Pharmacist registration no."
          value={phr}
          onChange={setPhr}
          required
          flagged={mismatch.has("pharmacist_reg_no")}
          placeholder="e.g. B-13727"
        />
        <button
          type="submit"
          disabled={busy}
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white shadow hover:bg-brand-600 disabled:opacity-60"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : null}
          {busy ? "পাঠানো হচ্ছে…" : "Save & re-verify"}
        </button>
      </form>
    </>
  );
}

function ExpiredBody({
  me,
  detail,
  busy,
  setBusy,
  setLocalError,
  onResubmitted,
}: {
  me: PharmacyMe;
  detail: VerificationDetail | null;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setLocalError: (s: string | null) => void;
  onResubmitted: (d: VerificationDetail) => void;
}) {
  const validUntil = detail?.dgda_record?.valid_until;
  const onRetry = async () => {
    setLocalError(null);
    setBusy(true);
    try {
      await pharmacyApi.retryVerification();
      const d = await pharmacyApi.verification();
      onResubmitted(d);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="rounded-2xl border border-rose-300/60 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-200">
        {detail?.message ??
          `আপনার renewal date ${validUntil ?? "2013 সালের আগে"}। 2013 সালের আগের record approve করা হবে না। DGDA থেকে updated renewal করিয়ে আনুন।`}
      </div>
      {detail?.dgda_record && <DgdaRecordCard record={detail.dgda_record} />}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <a
          href="https://www.dgdagov.info/index.php/pharmacies/allopathic-retail-pharmacy"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-black/10 bg-white px-4 py-2.5 text-sm font-semibold shadow-sm hover:bg-black/[0.04] dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
        >
          DGDA registry দেখুন
        </a>
        <button
          onClick={onRetry}
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white shadow hover:bg-brand-600 disabled:opacity-60"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          {busy ? "চেক হচ্ছে…" : "Renewal হয়েছে — আবার যাচাই করুন"}
        </button>
      </div>
      <p className="text-[11px] opacity-60">
        Stored license: {me.pharmacy_license_no}
      </p>
    </>
  );
}

function ErrorBody({
  busy,
  setBusy,
  setLocalError,
  onResubmitted,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
  setLocalError: (s: string | null) => void;
  onResubmitted: (d: VerificationDetail) => void;
}) {
  const onRetry = async () => {
    setLocalError(null);
    setBusy(true);
    try {
      await pharmacyApi.retryVerification();
      const d = await pharmacyApi.verification();
      onResubmitted(d);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="text-sm">
        DGDA সার্ভারে এখন সংযোগ করা যাচ্ছে না। কিছুক্ষণ পরে আবার Retry করুন।
      </p>
      <button
        onClick={onRetry}
        disabled={busy}
        className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white shadow hover:bg-brand-600 disabled:opacity-60"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        {busy ? "Retrying…" : "Retry"}
      </button>
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  flagged,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  flagged: boolean;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-2 text-xs font-medium opacity-70">
        <span>
          {label}
          {required && <span className="ml-0.5 text-rose-500" title="আবশ্যক">*</span>}
        </span>
        {flagged && (
          <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-300">
            ভুল আছে
          </span>
        )}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-xl border px-3 py-2.5 text-sm outline-none ring-brand-500/40 focus:ring-2 ${
          flagged
            ? "border-rose-400/70 bg-rose-50/60 dark:border-rose-500/40 dark:bg-rose-950/20"
            : "border-black/10 bg-white/70 dark:border-white/10 dark:bg-white/5"
        }`}
      />
    </label>
  );
}
