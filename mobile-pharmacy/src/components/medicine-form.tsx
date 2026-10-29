"use client";

/**
 * Reusable medicine create/edit form for the pharmacy mobile app.
 * Image is mandatory (backend rule). Category is NOT user-editable —
 * MediAI assigns it on save / publish.
 */
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, ImagePlus, Loader2, Save, Sparkles, Trash2, X,
} from "lucide-react";
import { resolveMediaUrl, uploadImage } from "@/lib/api";
import { pharmacyApi, type MedicineInput, type PharmacyMedicine } from "@/lib/pharmacy";

type Props =
  | { mode: "new"; id?: undefined }
  | { mode: "edit"; id: string };

export function MedicineForm(props: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [loaded, setLoaded] = useState<PharmacyMedicine | null>(null);
  const [name, setName] = useState("");
  const [shortDesc, setShortDesc] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [price, setPrice] = useState<number | "">("");
  const [stock, setStock] = useState<number | "">("");
  const [isActive, setIsActive] = useState(true);
  const [rxRequired, setRxRequired] = useState(false);

  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (props.mode !== "edit") return;
    pharmacyApi.listMedicines().then((d) => {
      const m = d.items.find((x) => x.id === props.id);
      if (!m) { setError("Medicine not found"); return; }
      setLoaded(m);
      setName(m.name);
      setShortDesc(m.short_description || "");
      setImageUrl(m.image_url || "");
      setPrice(m.price);
      setStock(m.stock);
      setIsActive(m.is_active);
      setRxRequired(!!m.prescription_required);
    }).catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
  }, [props]);

  const onPick = async (f: File) => {
    setUploading(true);
    setError(null);
    try {
      const url = await uploadImage(f);
      setImageUrl(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally { setUploading(false); }
  };

  const onSave = async () => {
    setError(null);
    if (!name.trim()) { setError("Name দিন।"); return; }
    if (!imageUrl) { setError("Image upload করুন (mandatory)।"); return; }
    if (price === "" || Number(price) < 0) { setError("Valid price দিন।"); return; }
    if (stock === "" || Number(stock) < 0) { setError("Valid stock দিন।"); return; }

    const payload: MedicineInput = {
      name: name.trim(),
      image_url: imageUrl,
      short_description: shortDesc.trim() || null,
      price: Number(price),
      stock: Number(stock),
      is_active: isActive,
      prescription_required: rxRequired,
    };
    setBusy(true);
    try {
      if (props.mode === "new") {
        await pharmacyApi.createMedicine(payload);
      } else {
        await pharmacyApi.updateMedicine(props.id, payload);
      }
      router.replace("/medicines");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally { setBusy(false); }
  };

  const onDelete = async () => {
    if (props.mode !== "edit") return;
    setBusy(true);
    try {
      await pharmacyApi.deleteMedicine(props.id);
      router.replace("/medicines");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  };

  return (
    <div className="px-4 pt-3 pb-6">
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-2xl border border-rose-300/60 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <p className="flex-1">{error}</p>
          <button onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      {/* Image */}
      <div className="mb-3">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Image *</p>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="relative grid h-44 w-full place-items-center overflow-hidden rounded-2xl border border-dashed border-slate-300 bg-slate-50 dark:border-white/15 dark:bg-white/[0.03]"
        >
          {imageUrl ? (
            <Image src={resolveMediaUrl(imageUrl)} alt="" fill sizes="480px" className="object-cover" />
          ) : (
            <div className="flex flex-col items-center gap-1 text-slate-400">
              {uploading
                ? <Loader2 size={22} className="animate-spin" />
                : <ImagePlus size={22} />}
              <span className="text-xs">Tap to upload</span>
            </div>
          )}
        </button>
        <input
          ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }}
        />
      </div>

      {/* Name */}
      <Field label="Name *">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="যেমন: Napa Extra 500mg" />
      </Field>

      {/* Short description */}
      <Field label="Short description (optional)">
        <textarea value={shortDesc} onChange={(e) => setShortDesc(e.target.value)} rows={2} className={inputCls} placeholder="MediAI auto-generate করতে পারে" />
      </Field>

      {/* Price + stock */}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Price (৳) *">
          <input
            inputMode="numeric"
            value={price}
            onChange={(e) => setPrice(e.target.value === "" ? "" : Number(e.target.value))}
            className={inputCls}
          />
        </Field>
        <Field label="Stock *">
          <input
            inputMode="numeric"
            value={stock}
            onChange={(e) => setStock(e.target.value === "" ? "" : Number(e.target.value))}
            className={inputCls}
          />
        </Field>
      </div>

      {/* Toggles */}
      <Toggle label="Active (visible to customers)" value={isActive} onChange={setIsActive} />
      <Toggle label="Prescription required" value={rxRequired} onChange={setRxRequired} />

      {/* MediAI hint */}
      {loaded && (
        <div className="mb-3 flex gap-2 rounded-2xl border border-brand-200/70 bg-brand-50/60 p-3 text-[11px] dark:border-brand-500/30 dark:bg-brand-500/10">
          <Sparkles size={14} className="mt-0.5 shrink-0 text-brand-500" />
          <div>
            <p className="font-semibold">Categories: {loaded.categories.join(", ") || loaded.category}</p>
            <p className="opacity-70">MediAI assigned. Save করলে আবার auto-update হবে।</p>
          </div>
        </div>
      )}

      <button
        disabled={busy}
        onClick={onSave}
        className="tap mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-brand-500 py-3 text-sm font-semibold text-white shadow-md disabled:opacity-60"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        Save medicine
      </button>

      {props.mode === "edit" && (
        <button
          onClick={() => setConfirmDelete(true)}
          className="tap mt-3 flex w-full items-center justify-center gap-1.5 rounded-full border border-rose-300 py-2.5 text-xs font-semibold text-rose-600 dark:border-rose-500/40 dark:text-rose-300"
        >
          <Trash2 size={12} /> Delete medicine
        </button>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-3" onClick={() => setConfirmDelete(false)}>
          <div className="w-full max-w-[420px] rounded-3xl bg-white p-4 dark:bg-[#0b1018]" onClick={(e) => e.stopPropagation()}>
            <p className="text-base font-semibold">Delete &quot;{name}&quot;?</p>
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              এই action undo করা যাবে না।
            </p>
            <div className="mt-3 flex gap-2">
              <button onClick={() => setConfirmDelete(false)} className="tap flex-1 rounded-full border border-slate-200 py-2.5 text-sm dark:border-white/10">Cancel</button>
              <button onClick={onDelete} className="tap flex-1 rounded-full bg-rose-500 py-2.5 text-sm font-semibold text-white">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-slate-200 bg-white p-2.5 text-sm outline-none focus:border-brand-400 dark:border-white/10 dark:bg-white/5";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-3 block">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      {children}
    </label>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="mb-2 flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white p-3 text-left dark:border-white/10 dark:bg-white/[0.04]"
    >
      <span className="text-sm">{label}</span>
      <span className={[
        "relative h-6 w-10 rounded-full transition",
        value ? "bg-brand-500" : "bg-slate-300 dark:bg-white/15",
      ].join(" ")}>
        <span className={[
          "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition",
          value ? "left-[calc(100%-22px)]" : "left-0.5",
        ].join(" ")} />
      </span>
    </button>
  );
}
