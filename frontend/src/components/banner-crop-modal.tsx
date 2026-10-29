"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Cropper, { type Area } from "react-easy-crop";
import { X, Check } from "lucide-react";
import { uploadImage } from "@/lib/api";

/**
 * Banner cropper modal.
 *
 * Forces a wide 16:6 (≈2.67:1) aspect that matches the storefront banner
 * area, so pharmacies cannot upload a portrait/square banner that breaks
 * the layout. Outputs JPEG up to 1600px wide for high-DPI displays.
 */
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

  async function save() {
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
  }

  // Portal to <body>: ancestors with backdrop-filter / transform (e.g. the
  // dashboard's frosted Card) turn into containing blocks for position:fixed,
  // which used to trap + clip this modal inside the banner card.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white dark:bg-[#0b1018] shadow-2xl">
        <div className="flex items-center justify-between border-b border-black/5 dark:border-white/10 px-4 py-3">
          <div>
            <p className="text-sm font-semibold">Crop banner</p>
            <p className="text-[11px] opacity-60">16:6 aspect — drag/zoom to adjust</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="relative h-[320px] w-full bg-black">
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

        <div className="flex items-center gap-3 px-4 py-3">
          <span className="text-[11px] opacity-60">Zoom</span>
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
          <div className="border-t border-red-300/50 bg-red-50 dark:bg-red-950/30 px-4 py-2 text-xs text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !areaPx}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            <Check size={14} /> {busy ? "Uploading…" : "Save banner"}
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
  ctx.drawImage(
    img,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    outW,
    outH,
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      0.92,
    );
  });
}
