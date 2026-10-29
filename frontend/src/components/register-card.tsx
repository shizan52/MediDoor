"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Check, CircleUserRound, Sparkles, UserRound } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { PhotoUploadCrop } from "@/components/photo-upload-crop";
import { api, session, type Role } from "@/lib/api";

type FieldDef = {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** Image field rendered with the crop+upload widget instead of a text input. */
  image?: { shape: "circle" | "rect"; aspect: number };
  /** Make the field span both columns of the grid. */
  full?: boolean;
};

type RoleSchema = {
  title: string;
  fields: FieldDef[];
};

const SCHEMAS: Record<Role, RoleSchema> = {
  customer: {
    title: "Tell us about you",
    fields: [
      {
        name: "profile_photo_url",
        label: "Profile photo",
        image: { shape: "circle", aspect: 1 },
        full: true,
      },
      { name: "first_name",    label: "First name",    required: true },
      { name: "last_name",     label: "Last name",     required: true },
      { name: "phone_number",  label: "Phone number",  required: true, placeholder: "+8801…" },
      { name: "date_of_birth", label: "Date of birth", type: "date" },
      {
        name: "gender",
        label: "Gender",
        options: [
          { value: "",       label: "Select…" },
          { value: "male",   label: "Male" },
          { value: "female", label: "Female" },
          { value: "other",  label: "Other" },
        ],
      },
    ],
  },
  pharmacy: {
    title: "Your pharmacy details",
    fields: [
      {
        name: "banner_photo_url",
        label: "Pharmacy banner",
        image: { shape: "rect", aspect: 16 / 9 },
        full: true,
      },
      { name: "pharmacy_name",       label: "Pharmacy name",        required: true },
      { name: "owner_name",          label: "Owner / manager name", required: true },
      { name: "business_name",       label: "Business name",        required: true, full: true },
      { name: "pharmacy_license_no", label: "Pharmacy license no.", required: true, placeholder: "e.g. MDh-005" },
      { name: "pharmacist_name",     label: "Registered pharmacist name",  required: true, placeholder: "DGDA-নিবন্ধিত নাম" },
      { name: "pharmacist_reg_no",   label: "Pharmacist registration no.", required: true, placeholder: "e.g. B-13727" },
      {
        name: "pharmacy_license_doc_url",
        label: "License document",
        image: { shape: "rect", aspect: 4 / 3 },
        required: true,
      },
    ],
  },
  rider: {
    title: "Rider profile",
    fields: [
      {
        name: "profile_photo_url",
        label: "Profile photo",
        image: { shape: "circle", aspect: 1 },
        full: true,
      },
      { name: "full_name",    label: "Full name",    required: true },
      { name: "nick_name",    label: "Nick name" },
      { name: "phone_number", label: "WhatsApp number", required: true, placeholder: "+8801…" },
      { name: "age",          label: "Age", type: "number", required: true },
      // Document fields are rendered conditionally by `RegisterCard` based on
      // the doc-method toggle (NID vs birth-cert + student-ID). They are still
      // listed here so payload-building / image rendering work uniformly.
      { name: "nid_number",   label: "NID number",   full: true },
      {
        name: "nid_front_url",
        label: "NID front photo",
        image: { shape: "rect", aspect: 16 / 10 },
      },
      {
        name: "nid_back_url",
        label: "NID back photo",
        image: { shape: "rect", aspect: 16 / 10 },
      },
      {
        name: "birth_certificate_url",
        label: "Birth certificate photo",
        image: { shape: "rect", aspect: 16 / 10 },
      },
      {
        name: "student_id_card_url",
        label: "Student ID card photo",
        image: { shape: "rect", aspect: 16 / 10 },
      },
    ],
  },
};

// Document fields belonging to each rider doc-method. Used by `RegisterCard`
// to hide the fields of the un-selected branch from rendering AND from the
// submitted payload.
const RIDER_NID_FIELDS = new Set([
  "nid_number",
  "nid_front_url",
  "nid_back_url",
]);
const RIDER_BIRTH_FIELDS = new Set([
  "birth_certificate_url",
  "student_id_card_url",
]);
type RiderDocMethod = "nid" | "birth";

type MeResp = {
  is_registered: boolean;
  role: Role;
  profile?: {
    verification_status?: "pending" | "verified" | "rejected" | null;
    verification_note?: string | null;
    [k: string]: unknown;
  } | null;
};

export function RegisterCard({ role }: { role: Role }) {
  const router = useRouter();
  const schema = SCHEMAS[role];
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  // Rider-only: which document path the rider is using.
  const [riderDocMethod, setRiderDocMethod] = useState<RiderDocMethod>("nid");

  const goToRoleHome = (nextRole: Role) => {
    if (nextRole === "customer") {
      router.replace("/");
      return;
    }
    // Rider → /rider, Pharmacy → /pharmacy on the main website.
    // Mobile apps are APKs and not web-deployed.
    router.replace(`/${nextRole}`);
  };

  // Guard: if user is already registered, skip this page \u2014 except for riders
  // whose documents were rejected by the admin, who must be allowed back in
  // to resubmit. Pre-fill the form with their previous answers.
  useEffect(() => {
    if (!session.access()) {
      router.replace("/login");
      return;
    }
    api<MeResp>("/api/auth/me")
      .then((me) => {
        const status = me.profile?.verification_status;
        const isRejectedRider = role === "rider" && status === "rejected";
        if (me.is_registered && !isRejectedRider) {
          goToRoleHome(me.role);
          return;
        }
        if (isRejectedRider && me.profile) {
          const seed: Record<string, string> = {};
          for (const f of schema.fields) {
            const raw = (me.profile as Record<string, unknown>)[f.name];
            if (raw !== undefined && raw !== null) seed[f.name] = String(raw);
          }
          setValues(seed);
          if (
            !seed.nid_number && !seed.nid_front_url && !seed.nid_back_url &&
            (seed.birth_certificate_url || seed.student_id_card_url)
          ) {
            setRiderDocMethod("birth");
          }
          if (me.profile.verification_note) {
            setError(`Admin note: ${me.profile.verification_note}`);
          }
        }
        setChecking(false);
      })
      .catch(() => {
        session.clear();
        router.replace("/login");
      });
  }, [router, role, schema]);

  const onChange = (k: string, v: string) =>
    setValues((prev) => ({ ...prev, [k]: v }));

  // Decide if a rider field should be shown right now.
  const isRiderFieldVisible = (name: string): boolean => {
    if (role !== "rider") return true;
    if (riderDocMethod === "nid" && RIDER_BIRTH_FIELDS.has(name)) return false;
    if (riderDocMethod === "birth" && RIDER_NID_FIELDS.has(name)) return false;
    return true;
  };

  // Per-field required-ness (overrides the static schema for rider doc fields,
  // which depend on the chosen doc-method).
  const isFieldRequired = (f: FieldDef): boolean => {
    if (role === "rider") {
      if (riderDocMethod === "nid" && RIDER_NID_FIELDS.has(f.name)) return true;
      if (riderDocMethod === "birth" && RIDER_BIRTH_FIELDS.has(f.name)) return true;
      // The other branch's fields are never required while hidden.
      if (RIDER_NID_FIELDS.has(f.name) || RIDER_BIRTH_FIELDS.has(f.name)) return false;
    }
    return !!f.required;
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Explicit required-field guard. Hidden file widgets (License document,
    // rider NID/birth docs) don't trigger native HTML validation, so validate
    // here — otherwise a pharmacy could submit with no license image, which
    // admin needs whenever DGDA auto-verify doesn't match (Problem 8).
    const missing = schema.fields
      .filter((f) => isRiderFieldVisible(f.name) && isFieldRequired(f))
      .filter((f) => {
        const raw = values[f.name];
        return raw === undefined || String(raw).trim() === "";
      })
      .map((f) => f.label);
    if (missing.length) {
      setError(`${missing.join(", ")} — এই ঘর${missing.length > 1 ? "গুলো" : "টি"} পূরণ করতে হবে।`);
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const f of schema.fields) {
        if (!isRiderFieldVisible(f.name)) continue;
        const raw = values[f.name];
        if (raw === undefined || raw === "") continue;
        payload[f.name] = f.type === "number" ? Number(raw) : raw;
      }
      await api(`/api/auth/register/${role}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      goToRoleHome(role);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Registration failed";
      // 409 from license-uniqueness check — let the user fix the field instead
      // of bouncing them to /pharmacy. For all other 409 (already registered)
      // we still send them home.
      if (msg.includes("409")) {
        if (
          role === "pharmacy" &&
          /license/i.test(msg)
        ) {
          setError(
            "এই DGDA license number ইতিমধ্যে অন্য একটি pharmacy ব্যবহার করছে। সঠিক license দিয়ে আবার চেষ্টা করুন।"
          );
          return;
        }
        goToRoleHome(role);
        return;
      }
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (checking) {
    return (
      <main className="grid min-h-screen place-items-center">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
          <p className="mt-4 text-sm opacity-70">Loading…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="relative min-h-screen bg-gradient-to-br from-brand-50 via-white to-brand-100 dark:from-[#070b12] dark:via-[#0b1018] dark:to-[#091622]">
      <header className="flex items-center justify-between px-6 py-5 lg:px-10">
        <BrandLogo className="h-14 w-auto md:h-16" />
        <ThemeToggle />
      </header>

      <section className="mx-auto w-full max-w-2xl px-6 pb-16">
        <motion.form
          onSubmit={onSubmit}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="glass rounded-3xl p-8 shadow-2xl"
        >
          <p className="text-xs font-medium uppercase tracking-wider opacity-60">
            Registering as {role}
          </p>
          <h1 className="mt-1 text-3xl font-bold">{schema.title}</h1>
          <p className="mt-2 text-sm opacity-70">
            Complete your profile to start using MediDoor.
          </p>

          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {schema.fields.map((f) => {
              if (!isRiderFieldVisible(f.name)) return null;
              const required = isFieldRequired(f);
              // Insert the rider doc-method picker right before the first
              // document field so the choice + the relevant fields stay
              // visually grouped.
              const docPickerHere =
                role === "rider" && f.name === "nid_number";
              return (
                <div key={f.name} className={f.full ? "sm:col-span-2" : ""}>
                  {docPickerHere && (
                    <RiderDocMethodPicker
                      value={riderDocMethod}
                      onChange={setRiderDocMethod}
                    />
                  )}
                  {f.image ? (
                    <PhotoUploadCrop
                      label={f.label}
                      value={values[f.name] ?? null}
                      onChange={(url) => onChange(f.name, url ?? "")}
                      shape={f.image.shape}
                      aspect={f.image.aspect}
                      required={required}
                    />
                  ) : (
                    <Field
                      field={{ ...f, required }}
                      value={values[f.name] ?? ""}
                      onChange={onChange}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {error && (
            <p className="mt-4 rounded-xl border border-red-300/50 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="mt-6 w-full rounded-2xl bg-brand-500 px-5 py-3.5 font-medium text-white shadow-lg shadow-brand-500/30 transition hover:-translate-y-0.5 hover:bg-brand-600 disabled:opacity-60 disabled:hover:translate-y-0"
          >
            {submitting ? "Saving…" : "Complete registration"}
          </button>
        </motion.form>
      </section>
    </main>
  );
}

function Field({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: string;
  onChange: (k: string, v: string) => void;
}) {
  const inputCls =
    "w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2.5 text-sm text-slate-900 outline-none ring-brand-500/40 placeholder:text-slate-500 focus:ring-2 dark:border-white/10 dark:bg-white/5 dark:text-slate-100 dark:placeholder:text-slate-500 dark:[color-scheme:dark]";
  const labelId = `${field.name}-label`;

  if (field.options) {
    return (
      <div className="block">
        <span id={labelId} className="mb-1 block text-xs font-medium opacity-70">
          {field.label}
          {field.required && <span className="text-red-500"> *</span>}
        </span>
        <ChoiceField field={field} value={value} onChange={onChange} labelId={labelId} />
      </div>
    );
  }

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium opacity-70">
        {field.label}
        {field.required && <span className="text-red-500"> *</span>}
      </span>
      <input
        type={field.type ?? "text"}
        required={field.required}
        placeholder={field.placeholder}
        value={value}
        onChange={(e) => onChange(field.name, e.target.value)}
        className={inputCls}
      />
    </label>
  );
}

function ChoiceField({
  field,
  value,
  onChange,
  labelId,
}: {
  field: FieldDef;
  value: string;
  onChange: (k: string, v: string) => void;
  labelId: string;
}) {
  const choices = field.options?.filter((option) => option.value) ?? [];
  const IconByValue = {
    male: UserRound,
    female: CircleUserRound,
    other: Sparkles,
  } as const;

  return (
    <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-labelledby={labelId}>
      {choices.map((choice) => {
        const selected = value === choice.value;
        const Icon = IconByValue[choice.value as keyof typeof IconByValue] ?? Sparkles;

        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(field.name, selected && !field.required ? "" : choice.value)}
            className={[
              "group relative isolate min-h-[72px] overflow-hidden rounded-2xl border px-2.5 py-3 text-center text-xs font-semibold transition duration-200 focus:outline-none focus:ring-2 focus:ring-brand-400/70 active:translate-y-0.5",
              selected
                ? "border-brand-400 bg-brand-500/15 text-brand-900 shadow-lg shadow-brand-500/20 dark:text-white"
                : "border-black/10 bg-white/55 text-slate-700 shadow-sm shadow-black/5 hover:-translate-y-0.5 hover:border-brand-300 hover:bg-white/80 dark:border-white/10 dark:bg-white/[0.045] dark:text-slate-300 dark:hover:border-brand-300/60 dark:hover:bg-white/[0.075]",
            ].join(" ")}
          >
            <span
              className={[
                "pointer-events-none absolute inset-x-2 top-1 h-10 rounded-full blur-2xl transition",
                selected ? "bg-brand-400/35 opacity-100" : "bg-cyan-300/20 opacity-0 group-hover:opacity-70",
              ].join(" ")}
            />
            <span className="relative mx-auto mb-2 grid h-8 w-8 place-items-center rounded-xl border border-white/40 bg-white/75 text-brand-600 shadow-inner shadow-white/60 dark:border-white/10 dark:bg-white/10 dark:text-brand-200 dark:shadow-none">
              <Icon size={16} strokeWidth={2.2} />
            </span>
            <span className="relative block leading-tight">{choice.label}</span>
            {selected && (
              <span className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full bg-brand-500 text-white shadow-md shadow-brand-500/30">
                <Check size={12} strokeWidth={3} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function RiderDocMethodPicker({
  value,
  onChange,
}: {
  value: RiderDocMethod;
  onChange: (v: RiderDocMethod) => void;
}) {
  const opts: { value: RiderDocMethod; label: string; hint: string }[] = [
    { value: "nid",   label: "🆔 NID আছে",         hint: "NID number + front + back photo" },
    { value: "birth", label: "📄 NID নেই",          hint: "Birth certificate + Student ID card" },
  ];
  return (
    <div className="sm:col-span-2 mb-2 rounded-2xl border border-black/10 dark:border-white/10 bg-white/60 dark:bg-white/5 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider opacity-70">
        Identity document
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {opts.map((o) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className={[
                "rounded-xl border px-3 py-2.5 text-left transition",
                active
                  ? "border-brand-500 bg-brand-50 dark:bg-brand-500/10"
                  : "border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/10",
              ].join(" ")}
            >
              <p className="text-sm font-medium">{o.label}</p>
              <p className="mt-0.5 text-[11px] opacity-70">{o.hint}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
