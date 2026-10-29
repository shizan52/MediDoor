"use client";

import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Cropper, { Area } from "react-easy-crop";
import { Camera, Image as ImageIcon, X, ZoomIn, ZoomOut, Check } from "lucide-react";
import { uploadImage, API_URL, isProtectedFileUrl, type SensitiveKind } from "@/lib/api";
import { SecureImage } from "@/components/secure-image";

type Shape = "circle" | "rect";

type Props = {
  label: string;
  value?: string | null;
  onChange: (url: string | null) => void;
  shape?: Shape;
  aspect?: number;
  required?: boolean;
  /** Sensitive doc kind (nid / license / ...) → stored privately. */
  kind?: SensitiveKind;
};

/**
 * Facebook-style photo picker + cropper.
 * - Click to choose a file
 * - Drag image, scale with slider/buttons
 * - Save => uploads cropped result to backend, sets URL via onChange
 */
export function PhotoUploadCrop({
  label,
  value,
  onChange,
  shape = "circle",
  aspect = 1,
  required,
  kind,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [pixels, setPixels] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local preview of the just-uploaded blob — works even before the account
  // exists (registration) and for private docs that need an authorised grant.
  const [localPreview, setLocalPreview] = useState<string | null>(null);

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

  const cancel = () => {
    setSrc(null);
    setPixels(null);
    if (fileRef.current) fileRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
  };

  const save = async () => {
    if (!src || !pixels) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await getCroppedBlob(src, pixels, shape === "circle");
      const url = await uploadImage(blob, kind);
      // Keep a local preview so the user immediately sees what they uploaded,
      // without needing a grant (important for pre-auth registration docs).
      try {
        setLocalPreview(URL.createObjectURL(blob));
      } catch {
        /* ignore */
      }
      onChange(url);
      cancel();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const previewUrl = value
    ? value.startsWith("http")
      ? value
      : `${API_URL}${value}`
    : null;
  const previewIsProtected = isProtectedFileUrl(previewUrl);

  // ---- preview state (no cropper open) ----
  if (!src) {
    return (
      <div>
        <p className="mb-1 text-xs font-medium opacity-70">
          {label}
          {required && <span className="text-red-500"> *</span>}
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={[
              "group relative grid place-items-center overflow-hidden",
              shape === "circle" ? "h-20 w-20 rounded-full" : "h-20 w-32 rounded-xl",
              "border border-dashed border-black/15 dark:border-white/15",
              "bg-white/60 dark:bg-white/5 hover:bg-brand-50 dark:hover:bg-white/10 transition",
            ].join(" ")}
          >
            {localPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={localPreview} alt={label} className="h-full w-full object-cover" />
            ) : previewUrl && previewIsProtected ? (
              <SecureImage src={previewUrl} alt={label} className="h-full w-full object-cover" />
            ) : previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt={label}
                className="h-full w-full object-cover"
              />
            ) : (
              <Camera className="h-6 w-6 opacity-50 group-hover:opacity-80" />
            )}
          </button>
          <div className="flex-1">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => cameraRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 transition"
              >
                <Camera className="h-3.5 w-3.5" />
                Camera
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-black/5 dark:bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-black/10 dark:hover:bg-white/20 transition"
              >
                <ImageIcon className="h-3.5 w-3.5" />
                Gallery
              </button>
              {previewUrl && (
                <button
                  type="button"
                  onClick={() => onChange(null)}
                  className="rounded-lg bg-black/5 dark:bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-black/10 dark:hover:bg-white/20 transition"
                >
                  Remove
                </button>
              )}
            </div>
            <p className="mt-1 text-[11px] opacity-60">
              Camera দিয়ে তুলুন বা Gallery থেকে নিন। JPG / PNG, max 8 MB।
            </p>
            {error && (
              <p className="mt-1 text-[11px] text-red-500">{error}</p>
            )}
          </div>
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
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onSelect(f);
            }}
          />
        </div>
      </div>
    );
  }

  // ---- cropper modal ----
  // Portal to <body>: backdrop-filter/transform ancestors (frosted cards)
  // would otherwise trap + clip this fixed modal.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-3xl bg-white dark:bg-[#0d141d] p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">Crop {label.toLowerCase()}</h3>
          <button
            type="button"
            onClick={cancel}
            className="rounded-full p-1.5 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="relative mt-4 h-72 w-full overflow-hidden rounded-2xl bg-black">
          <Cropper
            image={src}
            crop={crop}
            zoom={zoom}
            aspect={aspect}
            cropShape={shape === "circle" ? "round" : "rect"}
            showGrid={shape === "rect"}
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
        {error && (
          <p className="mt-2 text-xs text-red-500">{error}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            className="rounded-xl bg-black/5 dark:bg-white/10 px-4 py-2 text-sm font-medium hover:bg-black/10"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-brand-500/30 transition hover:bg-brand-600 disabled:opacity-60"
          >
            <Check className="h-4 w-4" />
            {busy ? "Uploading…" : "Save photo"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ----- helpers --------------------------------------------------------------

async function getCroppedBlob(
  src: string,
  area: Area,
  circular: boolean
): Promise<Blob> {
  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");

  // Cap output to keep upload size small.
  const maxOut = 720;
  const scale = Math.min(1, maxOut / Math.max(area.width, area.height));
  canvas.width = Math.round(area.width * scale);
  canvas.height = Math.round(area.height * scale);

  if (circular) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(
      canvas.width / 2,
      canvas.height / 2,
      Math.min(canvas.width, canvas.height) / 2,
      0,
      Math.PI * 2
    );
    ctx.closePath();
    ctx.clip();
  }

  ctx.drawImage(
    img,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    canvas.width,
    canvas.height
  );

  if (circular) ctx.restore();

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Crop failed"))),
      circular ? "image/png" : "image/jpeg",
      0.92
    );
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
