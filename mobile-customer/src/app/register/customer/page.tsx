"use client";

/**
 * Mobile customer registration. Reached after Google OAuth when the
 * backend returns `registered=0`. Mirrors the website's RegisterCard
 * but tuned for the 480 px shell — single column, big touch targets,
 * native date picker. Submitting POSTs `/api/auth/register/customer`
 * and routes home.
 */
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Camera, Check, CircleUserRound, Loader2, Sparkles, UserRound } from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { InitialAvatar } from "@/components/initial-avatar";
import { api, resolveMediaUrl, session, uploadImage, type Role } from "@/lib/api";

type MeResp = { is_registered: boolean; role: Role };

export default function CustomerRegisterPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    profile_photo_url: "",
    first_name: "",
    last_name: "",
    phone_number: "",
    date_of_birth: "",
    gender: "" as "" | "male" | "female" | "other",
  });

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    api<MeResp>("/api/auth/me")
      .then((me) => {
        if (me.is_registered) router.replace("/");
        else if (me.role !== "customer") router.replace("/login?msg=customer-only");
        else setChecking(false);
      })
      .catch(() => { session.clear(); router.replace("/login"); });
  }, [router]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  const onPhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    setError(null);
    try { set("profile_photo_url", await uploadImage(f)); }
    catch (ex) { setError(ex instanceof Error ? ex.message : "Upload failed"); }
    finally { setUploading(false); e.target.value = ""; }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {};
      (Object.keys(form) as (keyof typeof form)[]).forEach((k) => {
        const v = form[k];
        if (v !== "" && v != null) payload[k] = v;
      });
      await api("/api/auth/register/customer", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      router.replace("/");
    } catch (ex) {
      const msg = ex instanceof Error ? ex.message : "Registration failed";
      if (msg.includes("409")) { router.replace("/"); return; }
      setError(msg);
    } finally { setSubmitting(false); }
  };

  if (checking) {
    return (
      <>
        <MobileHeader title="Sign up" />
        <div className="flex items-center justify-center gap-2 py-12 text-xs text-slate-400">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </>
    );
  }

  const fullName = [form.first_name, form.last_name].filter(Boolean).join(" ") || "You";
  const avatar = resolveMediaUrl(form.profile_photo_url);

  return (
    <>
      <MobileHeader title="Sign up" subtitle="Tell us about you" />
      <form onSubmit={onSubmit} className="space-y-4 px-4 pb-32 pt-3">
        {/* Photo */}
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="tap relative grid h-24 w-24 place-items-center overflow-hidden rounded-full bg-slate-100 ring-2 ring-brand-300 dark:bg-white/[0.04]"
            aria-label="Upload profile photo"
          >
            {avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatar} alt="" className="h-full w-full object-cover" />
            ) : (
              <InitialAvatar name={fullName} src={null} size={96} />
            )}
            <span className="absolute bottom-0 right-0 grid h-7 w-7 place-items-center rounded-full bg-brand-500 text-white">
              {uploading ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
            </span>
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPhoto} />
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Profile photo (optional)</p>
        </div>

        <Field label="First name" required value={form.first_name}
          onChange={(v) => set("first_name", v)} />
        <Field label="Last name" required value={form.last_name}
          onChange={(v) => set("last_name", v)} />
        <Field label="Phone number" required type="tel" placeholder="+8801…"
          value={form.phone_number} onChange={(v) => set("phone_number", v)} />
        <Field label="Date of birth" type="date"
          value={form.date_of_birth} onChange={(v) => set("date_of_birth", v)} />
        <GenderPicker value={form.gender} onChange={(v) => set("gender", v)} />

        {error && (
          <p className="rounded-xl border border-rose-300 bg-rose-50 p-2 text-[12px] text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="tap w-full rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-500/30 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Complete registration"}
        </button>
      </form>
    </>
  );
}

function GenderPicker({
  value,
  onChange,
}: {
  value: "" | "male" | "female" | "other";
  onChange: (value: "" | "male" | "female" | "other") => void;
}) {
  const choices = [
    { value: "male", label: "Male", Icon: UserRound },
    { value: "female", label: "Female", Icon: CircleUserRound },
    { value: "other", label: "Other", Icon: Sparkles },
  ] as const;

  return (
    <div className="block">
      <span id="gender-label" className="mb-1 block text-[11px] font-semibold uppercase tracking-wider opacity-70">Gender</span>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-labelledby="gender-label">
        {choices.map(({ value: choiceValue, label, Icon }) => {
          const selected = value === choiceValue;
          return (
            <button
              key={choiceValue}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(selected ? "" : choiceValue)}
              className={[
                "tap relative isolate min-h-[68px] overflow-hidden rounded-2xl border px-2 py-2.5 text-center text-[11px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-brand-400/70 active:translate-y-0.5",
                selected
                  ? "border-brand-400 bg-brand-500/15 text-brand-900 shadow-lg shadow-brand-500/20 dark:text-white"
                  : "border-slate-200 bg-white/75 text-slate-700 shadow-sm shadow-black/5 dark:border-white/10 dark:bg-white/[0.045] dark:text-slate-300",
              ].join(" ")}
            >
              <span className={[
                "pointer-events-none absolute inset-x-2 top-1 h-9 rounded-full blur-2xl transition",
                selected ? "bg-brand-400/35 opacity-100" : "bg-cyan-300/20 opacity-0",
              ].join(" ")} />
              <span className="relative mx-auto mb-1.5 grid h-8 w-8 place-items-center rounded-xl border border-white/40 bg-white/75 text-brand-600 shadow-inner shadow-white/60 dark:border-white/10 dark:bg-white/10 dark:text-brand-200 dark:shadow-none">
                <Icon size={16} strokeWidth={2.2} />
              </span>
              <span className="relative block leading-tight">{label}</span>
              {selected && (
                <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-brand-500 text-white shadow-md shadow-brand-500/30">
                  <Check size={12} strokeWidth={3} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Field({
  label, required, type, placeholder, value, onChange,
}: {
  label: string;
  required?: boolean;
  type?: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider opacity-70">
        {label}{required && <span className="text-rose-500"> *</span>}
      </span>
      <input
        type={type ?? "text"}
        required={required}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-400 dark:border-white/10 dark:bg-white/[0.04]"
      />
    </label>
  );
}
