"use client";

/**
 * Mobile pharmacy registration. Reached after Google OAuth when the
 * backend returns `registered=0`. Mirrors the website's RegisterCard
 * (pharmacy schema) tuned for the 480 px shell — single column, big
 * touch targets, banner crop modal reused from /profile/edit.
 *
 * License document is uploaded as a flat image (no crop). After POST
 * `/api/auth/register/pharmacy` the user is sent to `/` where the
 * VerificationGate kicks in.
 */
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, Loader2, Save } from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { BannerCropModal } from "@/components/banner-crop-modal";
import { api, resolveMediaUrl, session, uploadImage, type Role } from "@/lib/api";

type MeResp = { is_registered: boolean; role: Role };

export default function PharmacyRegisterPage() {
  const router = useRouter();
  const licenseRef = useRef<HTMLInputElement | null>(null);
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState<"banner" | "license" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const bannerRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState({
    banner_photo_url: "",
    pharmacy_name: "",
    owner_name: "",
    business_name: "",
    pharmacy_license_no: "",
    pharmacist_name: "",
    pharmacist_reg_no: "",
    pharmacy_license_doc_url: "",
  });

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    api<MeResp>("/api/auth/me")
      .then((me) => {
        if (me.is_registered) router.replace("/");
        else if (me.role !== "pharmacy") router.replace("/login?msg=wrong-role");
        else setChecking(false);
      })
      .catch(() => { session.clear(); router.replace("/login"); });
  }, [router]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  const onBanner = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setCropFile(f);
    e.target.value = "";
  };

  const onLicense = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading("license");
    setError(null);
    try { set("pharmacy_license_doc_url", await uploadImage(f)); }
    catch (ex) { setError(ex instanceof Error ? ex.message : "Upload failed"); }
    finally { setUploading(null); e.target.value = ""; }
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
      await api("/api/auth/register/pharmacy", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      router.replace("/");
    } catch (ex) {
      const msg = ex instanceof Error ? ex.message : "Registration failed";
      if (msg.includes("409")) {
        if (/license/i.test(msg)) {
          setError("এই DGDA license number ইতিমধ্যে ব্যবহৃত। সঠিক license দিয়ে আবার চেষ্টা করুন।");
          return;
        }
        router.replace("/");
        return;
      }
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

  const banner = resolveMediaUrl(form.banner_photo_url);
  const license = resolveMediaUrl(form.pharmacy_license_doc_url);

  return (
    <>
      <MobileHeader title="Pharmacy sign up" subtitle="Your pharmacy details" />
      <form onSubmit={onSubmit} className="space-y-4 px-4 pb-32 pt-3">
        {/* Banner */}
        <div>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider opacity-70">
            Pharmacy banner
          </span>
          <button
            type="button"
            onClick={() => bannerRef.current?.click()}
            disabled={uploading === "banner"}
            className="relative grid h-32 w-full place-items-center overflow-hidden rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/[0.04]"
            aria-label="Upload banner"
          >
            {banner ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={banner} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex flex-col items-center gap-1 text-slate-400">
                <ImagePlus size={20} />
                <span className="text-[11px]">Tap to upload (16:9)</span>
              </div>
            )}
          </button>
          <input ref={bannerRef} type="file" accept="image/*" hidden onChange={onBanner} />
        </div>

        <Field label="Pharmacy name" required value={form.pharmacy_name}
          onChange={(v) => set("pharmacy_name", v)} />
        <Field label="Owner / manager name" required value={form.owner_name}
          onChange={(v) => set("owner_name", v)} />
        <Field label="Business name" required value={form.business_name}
          onChange={(v) => set("business_name", v)} />
        <Field label="Pharmacy license no." required placeholder="e.g. MDh-005"
          value={form.pharmacy_license_no}
          onChange={(v) => set("pharmacy_license_no", v)} />
        <Field label="Registered pharmacist name" required placeholder="DGDA-নিবন্ধিত নাম"
          value={form.pharmacist_name}
          onChange={(v) => set("pharmacist_name", v)} />
        <Field label="Pharmacist registration no." required placeholder="e.g. B-13727"
          value={form.pharmacist_reg_no}
          onChange={(v) => set("pharmacist_reg_no", v)} />

        {/* License document */}
        <div>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider opacity-70">
            License document <span className="text-rose-500">*</span>
          </span>
          <button
            type="button"
            onClick={() => licenseRef.current?.click()}
            disabled={uploading === "license"}
            className="relative grid h-28 w-full place-items-center overflow-hidden rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/[0.04]"
            aria-label="Upload license document"
          >
            {license ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={license} alt="" className="h-full w-full object-cover" />
            ) : uploading === "license" ? (
              <Loader2 size={18} className="animate-spin text-slate-400" />
            ) : (
              <div className="flex flex-col items-center gap-1 text-slate-400">
                <ImagePlus size={18} />
                <span className="text-[11px]">Tap to upload license image</span>
              </div>
            )}
          </button>
          <input ref={licenseRef} type="file" accept="image/*" hidden onChange={onLicense} />
        </div>

        {error && (
          <p className="rounded-xl border border-rose-300 bg-rose-50 p-2 text-[12px] text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="tap w-full rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-500/30 disabled:opacity-50"
        >
          <Save size={14} className="-mt-0.5 mr-1.5 inline" />
          {submitting ? "Saving…" : "Complete registration"}
        </button>
      </form>

      {cropFile && (
        <BannerCropModal
          file={cropFile}
          onClose={() => setCropFile(null)}
          onUploaded={(url) => { set("banner_photo_url", url); setCropFile(null); }}
        />
      )}
    </>
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
