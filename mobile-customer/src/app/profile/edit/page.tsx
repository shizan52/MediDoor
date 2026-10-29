"use client";

import { ChangeEvent, FormEvent, type InputHTMLAttributes, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Loader2, Save } from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { InitialAvatar } from "@/components/initial-avatar";
import { api, resolveMediaUrl, session, uploadImage, type Role } from "@/lib/api";

type CustomerProfile = {
  first_name?: string;
  last_name?: string;
  phone_number?: string;
  date_of_birth?: string | null;
  gender?: "male" | "female" | "other" | null;
  profile_photo_url?: string | null;
};

type Me = {
  gmail: string;
  role: Role;
  profile?: CustomerProfile | null;
};

type FormState = {
  first_name: string;
  last_name: string;
  phone_number: string;
  date_of_birth: string;
  gender: "" | "male" | "female" | "other";
  profile_photo_url: string;
};

const EMPTY: FormState = {
  first_name: "",
  last_name: "",
  phone_number: "",
  date_of_birth: "",
  gender: "",
  profile_photo_url: "",
};

export default function EditProfilePage() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [gmail, setGmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session.access()) {
      router.replace("/login?next=/profile/edit");
      return;
    }
    (async () => {
      try {
        const me = await api<Me>("/api/auth/me");
        if (me.role !== "customer") {
          router.replace("/login?msg=customer-only");
          return;
        }
        const profile = me.profile ?? null;
        setGmail(me.gmail);
        setForm({
          first_name: profile?.first_name || "",
          last_name: profile?.last_name || "",
          phone_number: profile?.phone_number || "",
          date_of_birth: profile?.date_of_birth || "",
          gender: profile?.gender || "",
          profile_photo_url: profile?.profile_photo_url || "",
        });
      } catch (ex) {
        setError(ex instanceof Error ? ex.message : "Load failed");
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  const name = [form.first_name, form.last_name].filter(Boolean).join(" ") || gmail || "Customer";
  const avatar = resolveMediaUrl(form.profile_photo_url);

  const setField = (key: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const onPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const url = await uploadImage(file);
      setField("profile_photo_url", url);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : "Upload failed");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api<Me>("/api/auth/me/customer", {
        method: "PATCH",
        body: JSON.stringify({
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
          phone_number: form.phone_number.trim(),
          date_of_birth: form.date_of_birth || null,
          gender: form.gender || null,
          profile_photo_url: form.profile_photo_url || null,
        }),
      });
      router.replace("/profile");
      router.refresh();
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <MobileHeader title="Edit Profile" back />
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-brand-500" />
        </div>
      ) : (
        <form onSubmit={onSubmit} className="px-4 pb-4 pt-3">
          <section className="rounded-[28px] border border-slate-200/80 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
            <div className="flex items-center gap-4">
              <InitialAvatar name={name} src={avatar || null} size={76} className="ring-4 ring-brand-50 dark:ring-white/10" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-bold">{name}</p>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">{gmail}</p>
                <label className="tap mt-3 inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-3 py-2 text-xs font-semibold text-white">
                  {uploading ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />}
                  Change photo
                  <input type="file" accept="image/*" className="hidden" onChange={onPhoto} disabled={uploading} />
                </label>
              </div>
            </div>
          </section>

          <section className="mt-4 rounded-[24px] border border-slate-200/80 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name" value={form.first_name} onChange={(v) => setField("first_name", v)} required />
              <Field label="Last name" value={form.last_name} onChange={(v) => setField("last_name", v)} required />
            </div>
            <Field label="Phone number" value={form.phone_number} onChange={(v) => setField("phone_number", v)} required className="mt-3" inputMode="tel" />
            <Field label="Birthday" value={form.date_of_birth} onChange={(v) => setField("date_of_birth", v)} className="mt-3" type="date" />
            <div className="mt-3">
              <label className="text-[11px] font-semibold uppercase tracking-normal text-slate-500 dark:text-slate-400">Gender</label>
              <div className="mt-1 grid grid-cols-3 gap-2">
                {(["male", "female", "other"] as const).map((gender) => (
                  <button
                    key={gender}
                    type="button"
                    onClick={() => setField("gender", form.gender === gender ? "" : gender)}
                    className={[
                      "tap h-11 rounded-2xl border text-xs font-semibold capitalize",
                      form.gender === gender
                        ? "border-brand-500 bg-brand-500 text-white"
                        : "border-slate-200 bg-white text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200",
                    ].join(" ")}
                  >
                    {gender}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {error && <p className="mt-3 rounded-2xl bg-rose-50 p-3 text-xs text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>}

          <button
            type="submit"
            disabled={saving || uploading}
            className="tap mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 text-sm font-bold text-white shadow-lg shadow-brand-500/20 disabled:opacity-60"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Save profile
          </button>
        </form>
      )}
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  className = "",
  type = "text",
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  className?: string;
  type?: string;
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-[11px] font-semibold uppercase tracking-normal text-slate-500 dark:text-slate-400">{label}</span>
      <input
        type={type}
        value={value}
        required={required}
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-medium outline-none transition focus:border-brand-400 focus:ring-4 focus:ring-brand-500/10 dark:border-white/10 dark:bg-white/[0.04]"
      />
    </label>
  );
}