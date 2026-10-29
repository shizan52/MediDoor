"use client";

import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Cropper, { type Area } from "react-easy-crop";
import { Camera, Check, Loader2, Trash2, X, ZoomIn, ZoomOut } from "lucide-react";
import { resolveMediaUrl, uploadImage } from "@/lib/api";

/**
 * Professional in-place avatar editor for the "My profile" screens.
 *
 * Renders the current photo (or an initial-letter fallback) with a camera
 * badge. Tapping it opens the picker → circular crop modal (drag + zoom,
 * Facebook-style) → uploads the cropped image → hands the final URL to
 * `onSave` (the caller PATCHes its own profile endpoint and updates state).
 */
export function ProfilePhotoEditor({
  photoUrl,
  displayName,
  onSave,
  className = "h-16 w-16",
  rounded = "rounded-full",
  fallbackClassName = "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-200",
  ringClassName = "ring-2 ring-brand-400/40",
  allowRemove = true,
}: {
  photoUrl?: string | null;
  displayName: string;
  onSave: (url: string | null) => Promise<void>;
  className?: string;
  rounded?: string;
  fallbackClassName?: string;
  ringClassName?: string;
  allowRemove?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [pixels, setPixels] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolved = resolveMediaUrl(photoUrl || "") || null;

  const onSelect = (file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("শুধুমাত্র image file দিন।");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError("File খুব বড় (max 8 MB)।");
      return;
    }
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      setSrc(reader.result as string);
      setCrop({ x: 0, y: 0 });
      setZoom(1);
    };
    reader.readAsDataURL(file);
  };

  const onCropComplete = useCallback((_: Area, area: Area) => {
    setPixels(area);
  }, []);

  const closeModal = () => {
    setSrc(null);
    setPixels(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const save = async () => {
    if (!src || !pixels) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await getCroppedBlob(src, pixels);
      const url = await uploadImage(blob);
      await onSave(url);
      closeModal();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const removePhoto = async () => {
    setRemoving(true);
    setError(null);
    try {
      await onSave(null);
      closeModal();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        title="প্রোফাইল ছবি পরিবর্তন করুন"
        aria-label="প্রোফাইল ছবি পরিবর্তন করুন"
        className={`group relative shrink-0 overflow-visible ${className}`}
      >
        <span className={`block h-full w-full overflow-hidden ${rounded} ${ringClassName}`}>
          {resolved ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={resolved} alt={displayName} className="h-full w-full object-cover" />
          ) : (
            <span className={`grid h-full w-full place-items-center text-xl font-bold ${fallbackClassName}`}>
              {displayName[0]?.toUpperCase() || "?"}
            </span>
          )}
          {/* hover hint */}
          <span className="absolute inset-0 hidden place-items-center rounded-[inherit] bg-black/35 text-white group-hover:grid">
            <Camera size={18} />
          </span>
        </span>
        {/* camera badge */}
        <span className="absolute -bottom-1 -right-1 grid h-6 w-6 place-items-center rounded-full bg-brand-500 text-white shadow-md ring-2 ring-white dark:ring-[#0b1018]">
          <Camera size={12} />
        </span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onSelect(f);
        }}
      />
      {error && !src && <p className="mt-1 text-[11px] text-red-500">{error}</p>}

      {/* Portal to <body>: backdrop-filter/transform ancestors (frosted cards)
          would otherwise trap + clip this fixed modal. */}
      {src && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-3xl bg-white p-5 shadow-2xl dark:bg-[#0d141d]">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">প্রোফাইল ছবি সেট করুন</h3>
              <button
                type="button"
                onClick={closeModal}
                className="rounded-full p-1.5 hover:bg-black/5 dark:hover:bg-white/10"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="relative mt-4 h-72 w-full overflow-hidden rounded-2xl bg-black">
              <Cropper
                image={src}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
                objectFit="contain"
              />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <ZoomOut className="h-4 w-4 opacity-60" />
              <input
                type="range"
                min={1}
                max={4}
                step={0.01}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="flex-1 accent-brand-500"
              />
              <ZoomIn className="h-4 w-4 opacity-60" />
            </div>
            {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              {allowRemove && resolved && (
                <button
                  type="button"
                  onClick={removePhoto}
                  disabled={busy || removing}
                  className="mr-auto inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-60 dark:text-rose-300 dark:hover:bg-rose-500/10"
                >
                  {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  ছবি সরান
                </button>
              )}
              <button
                type="button"
                onClick={closeModal}
                disabled={busy || removing}
                className="rounded-xl bg-black/5 px-4 py-2 text-sm font-medium hover:bg-black/10 dark:bg-white/10"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy || removing || !pixels}
                className="inline-flex items-center gap-1.5 rounded-xl bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-brand-500/30 transition hover:bg-brand-600 disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {busy ? "Saving…" : "Save photo"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

async function getCroppedBlob(src: string, area: Area): Promise<Blob> {
  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");

  const maxOut = 720;
  const scale = Math.min(1, maxOut / Math.max(area.width, area.height));
  canvas.width = Math.round(area.width * scale);
  canvas.height = Math.round(area.height * scale);

  ctx.save();
  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
  ctx.restore();

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Crop failed"))), "image/png", 0.92);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
