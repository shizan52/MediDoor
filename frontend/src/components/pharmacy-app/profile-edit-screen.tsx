"use client";

/**
 * Edit pharmacy details — 1:1 port of
 * mobile-pharmacy/src/app/profile/edit/page.tsx. Name, business name,
 * owner, description, phone, address, banner image, location lat/lng,
 * delivery fees, subscription tier.
 *
 * License + DGDA verification fields are intentionally NOT editable
 * here — those flow through /api/pharmacy/me/verify-resubmit which is
 * a separate gate handled on the verification screen.
 */
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, ImagePlus, Loader2, MapPin, Save, X,
} from "lucide-react";
import { MobileHeader } from "@/components/pharmacy-app/mobile-header";
import { BannerCropModal } from "@/components/banner-crop-modal";
import { API_URL, resolveMediaUrl, session } from "@/lib/api";
import { pharmacyApi, type PharmacyMe, type PharmacyUpdate } from "@/lib/pharmacy";
import { canTrackLocationOnThisDevice, getPreciseLocation, locationErrorMessage } from "@/lib/geo";

export function PharmacyProfileEditScreen() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [me, setMe] = useState<PharmacyMe | null>(null);
  const [draft, setDraft] = useState<PharmacyUpdate>({});
  const [bannerUrl, setBannerUrl] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [bannerSavedFlash, setBannerSavedFlash] = useState(false);

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    if (session.role() !== "pharmacy") { router.replace("/"); return; }
    pharmacyApi.me().then((m) => {
      setMe(m);
      setBannerUrl(m.banner_photo_url || "");
    }).catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
  }, [router]);

  if (!me) {
    return (
      <>
        <MobileHeader title="Edit profile" back />
        <div className="flex items-center justify-center gap-2 py-12 text-xs text-slate-400">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </>
    );
  }

  const set = <K extends keyof PharmacyUpdate>(k: K, v: PharmacyUpdate[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const onPickBanner = (f: File) => {
    // Open crop modal; actual upload happens after the user confirms
    // the 16:6 framing inside <BannerCropModal>.
    setCropFile(f);
  };

  // Crop modal returns a freshly-uploaded URL; persist it immediately so the
  // pharmacist never has to remember a second “Save banner”. Mirrors the
  // pharmacy mobile app behaviour.
  const onBannerCropped = async (url: string) => {
    setBannerUrl(url);
    setBusy(true);
    setError(null);
    try {
      const updated = await pharmacyApi.update({ banner_photo_url: url });
      setMe(updated);
      setBannerUrl(updated.banner_photo_url || "");
      setBannerSavedFlash(true);
      window.setTimeout(() => setBannerSavedFlash(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Banner save failed");
      // Revert preview to the last persisted banner on failure.
      setBannerUrl(me?.banner_photo_url || "");
    } finally {
      setBusy(false);
    }
  };

  const onLocate = async () => {
    if (!canTrackLocationOnThisDevice()) {
      setError(locationErrorMessage());
      return;
    }
    setLocating(true);
    try {
      // Pin-point helper (watchPosition + accuracy gate) — the shop location
      // becomes the pharmacy's PERMANENT platform coordinates, so a coarse
      // IP/Wi-Fi fix here would corrupt every 5 km distance check.
      const fix = await getPreciseLocation({
        desiredAccuracyM: 20,
        bestEffortAfterMs: 12_000,
        timeoutMs: 22_000,
      });
      const lat = +fix.lat.toFixed(6);
      const lng = +fix.lng.toFixed(6);
      set("lat", lat);
      set("lng", lng);
      setError(
        fix.accuracy > 100
          ? `Location ±${Math.round(fix.accuracy)} m (Wi-Fi based) — দোকানের ভিতর থেকে আবার try করলে GPS এ pin-point হবে।`
          : null,
      );
      // Reverse-geocode → auto-fill address (Barikoi via /api/geo/reverse).
      // We only fill if the user hasn't typed a custom address yet, so we
      // never overwrite manual edits. The backend `label` is a written place
      // name ("Gorachand Das Road, Barishal") — never raw coordinates.
      try {
        const res = await fetch(`${API_URL}/api/geo/reverse?lat=${lat}&lng=${lng}`);
        if (res.ok) {
          const geo = (await res.json()) as { label?: string | null; address?: string | null };
          const addr = (geo?.label || geo?.address || "").trim();
          if (addr) {
            setDraft((current) => {
              const existing = (current.address ?? me.address ?? "").trim();
              return existing ? current : { ...current, address: addr };
            });
          }
        }
      } catch { /* silent — coords already saved */ }
    } catch (err) {
      setError(locationErrorMessage(err));
    } finally {
      setLocating(false);
    }
  };

  const onSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const u = await pharmacyApi.update(draft);
      setMe(u);
      router.replace("/pharmacy/profile");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally { setBusy(false); }
  };

  const cur = { ...me, ...draft };
  return (
    <>
      <MobileHeader title="Edit profile" back right={
        <button
          onClick={onSave}
          disabled={busy}
          className="tap rounded-full bg-brand-500 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-60"
        >
          {busy ? <Loader2 size={12} className="inline animate-spin" /> : <Save size={12} className="inline" />} Save
        </button>
      } />

      <div className="px-4 pt-3 pb-6">
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-2xl border border-rose-300/60 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <p className="flex-1">{error}</p>
            <button onClick={() => setError(null)}><X size={12} /></button>
          </div>
        )}

        {/* Banner */}
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Banner</p>
        <button
          onClick={() => fileRef.current?.click()}
          className="relative mb-3 grid h-36 w-full place-items-center overflow-hidden rounded-2xl border border-dashed border-slate-300 bg-slate-50 dark:border-white/15 dark:bg-white/[0.03]"
        >
          {bannerUrl ? (
            <Image src={resolveMediaUrl(bannerUrl)} alt="" fill sizes="480px" className="object-cover" unoptimized />
          ) : (
            <div className="flex flex-col items-center gap-1 text-slate-400">
              {cropFile ? <Loader2 size={20} className="animate-spin" /> : <ImagePlus size={20} />}
              <span className="text-xs">Tap to upload banner</span>
            </div>
          )}
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickBanner(f); e.target.value = ""; }}
        />
        <div className="mb-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="tap inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-slate-100 px-3 py-2 text-[12px] font-semibold text-slate-700 disabled:opacity-50 dark:bg-white/10 dark:text-slate-100"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />}
            {busy ? "Saving banner…" : "Change banner"}
          </button>
        </div>
        {bannerSavedFlash && (
          <div className="mb-3 rounded-2xl border border-brand-300/60 bg-brand-50 p-2.5 text-xs font-semibold text-brand-700 dark:border-brand-500/30 dark:bg-brand-950/30 dark:text-brand-200">
            ✓ Banner updated.
          </div>
        )}

        <Field label="Pharmacy name">
          <input value={cur.pharmacy_name || ""} onChange={(e) => set("pharmacy_name", e.target.value)} className={inputCls} />
        </Field>
        <Field label="Business name">
          <input value={cur.business_name || ""} onChange={(e) => set("business_name", e.target.value)} className={inputCls} />
        </Field>
        <Field label="Owner name">
          <input value={cur.owner_name || ""} onChange={(e) => set("owner_name", e.target.value)} className={inputCls} />
        </Field>
        <Field label="Phone">
          <input value={cur.phone_number || ""} onChange={(e) => set("phone_number", e.target.value)} className={inputCls} placeholder="017xxxxxxxx" />
        </Field>
        <Field label="Description">
          <textarea value={cur.description || ""} onChange={(e) => set("description", e.target.value)} rows={3} className={inputCls} />
        </Field>
        <Field label="Address">
          <textarea value={cur.address || ""} onChange={(e) => set("address", e.target.value)} rows={2} className={inputCls} />
        </Field>

        {/* Location */}
        <div className="mb-3">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Location</p>
          <button
            onClick={onLocate}
            disabled={locating}
            className="tap mb-2 inline-flex items-center gap-1.5 rounded-full bg-brand-500/10 px-3 py-1.5 text-[12px] font-semibold text-brand-700 dark:text-brand-300"
          >
            {locating ? <Loader2 size={12} className="animate-spin" /> : <MapPin size={12} />}
            Use current location
          </button>
          <p className="text-[11px] opacity-70">
            Lat: {cur.lat?.toFixed(5) ?? "—"} · Lng: {cur.lng?.toFixed(5) ?? "—"}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Delivery base ৳">
            <input
              inputMode="numeric"
              value={cur.delivery_base_fee ?? ""}
              onChange={(e) => set("delivery_base_fee", Number(e.target.value))}
              className={inputCls}
            />
          </Field>
          <Field label="Per km ৳">
            <input
              inputMode="numeric"
              value={cur.delivery_per_km_fee ?? ""}
              onChange={(e) => set("delivery_per_km_fee", Number(e.target.value))}
              className={inputCls}
            />
          </Field>
        </div>

        <Field label="Subscription tier">
          <select
            value={cur.subscription_tier || me.subscription_tier}
            onChange={(e) => set("subscription_tier", e.target.value as "A" | "B" | "C")}
            className={inputCls}
          >
            <option value="C">C — Basic</option>
            <option value="B">B — Pro</option>
            <option value="A">A — Premium</option>
          </select>
        </Field>

        <button
          onClick={onSave}
          disabled={busy}
          className="tap mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-brand-500 py-3 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save changes
        </button>
      </div>

      {cropFile && (
        <BannerCropModal
          file={cropFile}
          onClose={() => setCropFile(null)}
          onUploaded={onBannerCropped}
        />
      )}
    </>
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
