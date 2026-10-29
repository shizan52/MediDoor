"use client";

/**
 * Mobile banner-cropper modal.
 *
 * Touch-friendly drag/zoom 16:6 crop UI (matches website's
 * `frontend/src/components/banner-crop-modal.tsx`). Tuned for phone:
 *   - fills the viewport edge-to-edge (no centred dialog)
 *   - bigger 36px close + zoom slider with brand accent
 *   - safe-area insets respected on top + bottom
 *   - JPEG output up to 1600px wide, ~92% quality
 *
 * Caller flow:
 *   1. user picks an <input type="file"> image
 *   2. mount <BannerCropModal file={...} onUploaded={(url) => …} />
 *   3. user drags/pinches, taps Save → uploads via `uploadImage` and
 *      hands the resulting URL back to the parent (which calls
 *      `pharmacyApi.update({ banner_photo_url })`).
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Cropper, { type Area } from "react-easy-crop";
import { Check, Loader2, X } from "lucide-react";
import { uploadImage } from "@/lib/api";

export function BannerCropModal({
  file,
  onClose,
  onUploaded,
}: {
  file: File;
  onClose: () => void;
  onUploaded: (url: string) => void | Promise<void>;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [areaPx, setAreaPx] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const onCropComplete = useCallback((_: Area, areaPixels: Area) => {
    setAreaPx(areaPixels);
  }, []);

  const save = async () => {
    if (!src || !areaPx) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await getCroppedBlob(src, areaPx, 1600);
      const url = await uploadImage(
        new File([blob], "banner.jpg", { type: "image/jpeg" }),
      );
      await onUploaded(url);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  // Portal to <body>: backdrop-filter/transform ancestors would otherwise
  // trap + clip this fixed modal (same fix as the website's crop modal).
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-black/85 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3 text-white">
        <div>
          <p className="text-sm font-semibold">Crop banner</p>
          <p className="text-[11px] opacity-70">16:6 aspect — drag/pinch to adjust</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="tap grid h-9 w-9 place-items-center rounded-full bg-white/10 hover:bg-white/20"
        >
          <X size={18} />
        </button>
      </div>

      {/* Crop area */}
      <div className="relative flex-1 bg-black">
        {src && (
          <Cropper
            image={src}
            crop={crop}
            zoom={zoom}
            aspect={16 / 6}
            cropShape="rect"
            showGrid
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
          />
        )}
      </div>

      {/* Footer controls */}
      <div className="space-y-3 bg-white px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 text-slate-900 dark:bg-[#0e1622] dark:text-slate-100">
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider opacity-60">Zoom</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="flex-1 accent-brand-500"
          />
        </div>

        {error && (
          <p className="rounded-xl border border-rose-300/60 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="tap flex-1 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold dark:border-white/10"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !areaPx}
            aria-label="Use cropped banner"
            className="tap flex-1 inline-flex items-center justify-center gap-1.5 rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white shadow hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {busy ? "Uploading…" : "Use banner"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ---------------- helpers ---------------- */

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

async function getCroppedBlob(
  src: string,
  area: Area,
  maxOut: number,
): Promise<Blob> {
  const img = await loadImage(src);
  const scale = Math.min(1, maxOut / area.width);
  const outW = Math.round(area.width * scale);
  const outH = Math.round(area.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, outW, outH);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      0.92,
    );
  });
}
