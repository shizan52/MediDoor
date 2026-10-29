"use client";

/**
 * MobileOrderComposer — bottom-sheet variant of the website's
 * OrderComposer, tailored for a 480-wide column.
 *
 * UX:
 *  - Taps the brand pill in the chat composer to open.
 *  - Slides up from the bottom, fills ~92dvh.
 *  - Top: search bar + chip list of catalog items (tap to add).
 *  - Middle: live basket with qty +/- and per-row total.
 *  - Optional custom item form (name + price + qty).
 *  - Bottom: subtotal, delivery, total, optional note + Rx upload,
 *    then "Send order request" CTA.
 *
 * Submits the same `OrderPayload` shape the backend already understands,
 * so the pharmacy side renders the itemised table without any backend
 * changes.
 */
import { useEffect, useMemo, useState } from "react";
import {
  X,
  Search,
  Plus,
  Minus,
  Trash2,
  Send,
  Package,
  ImagePlus,
  Loader2,
  ScrollText,
} from "lucide-react";
import { fetchPharmacy, userLocation, type StorefrontMedicine } from "@/lib/storefront";
import {
  formatBDT,
  type OrderLineItem,
  type OrderPayload,
} from "@/lib/conversations";
import { resolveMediaUrl, uploadImage } from "@/lib/api";

type Props = {
  pharmacyId: string;
  defaultDeliveryFee?: number;
  onClose: () => void;
  onSubmit: (
    payload: OrderPayload,
    body: string,
    attachmentUrl: string | null,
  ) => void;
};

export function MobileOrderComposer({
  pharmacyId,
  defaultDeliveryFee,
  onClose,
  onSubmit,
}: Props) {
  const [catalog, setCatalog] = useState<StorefrontMedicine[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<OrderLineItem[]>([]);
  const [deliveryFee, setDeliveryFee] = useState<number>(defaultDeliveryFee ?? 0);
  const [note, setNote] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customPrice, setCustomPrice] = useState<number>(0);
  const [customQty, setCustomQty] = useState<number>(1);
  const [rxUrl, setRxUrl] = useState<string | null>(null);
  const [uploadingRx, setUploadingRx] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lock background scroll while sheet is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // The storefront endpoint enforces the 5 km connect gate, so the
    // catalog fetch must carry the customer's browsing location — the
    // same one the rest of the app uses.
    const loc = userLocation.load();
    if (!loc) {
      setCatalog([]);
      setCatalogError(
        "Location পাওয়া যায়নি — Home এ ফিরে location দিন, তারপর আবার চেষ্টা করুন।",
      );
      setLoading(false);
      return;
    }
    setCatalogError(null);
    fetchPharmacy(pharmacyId, { lat: loc.lat, lng: loc.lng })
      .then((d) => {
        if (cancelled) return;
        if (defaultDeliveryFee == null) {
          setDeliveryFee(Number(d.pharmacy.delivery_fee || 0));
        }
        const all: StorefrontMedicine[] = [];
        const seen = new Set<string>();
        for (const c of d.categories) {
          for (const it of c.items) {
            if (seen.has(it.id)) continue;
            seen.add(it.id);
            all.push(it);
          }
        }
        setCatalog(all);
      })
      .catch((e) => {
        if (cancelled) return;
        setCatalog([]);
        setCatalogError(
          e instanceof Error ? e.message : "Catalog লোড করা যায়নি — আবার চেষ্টা করুন।",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pharmacyId, defaultDeliveryFee]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalog.slice(0, 30);
    return catalog
      .filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.category.toLowerCase().includes(q),
      )
      .slice(0, 30);
  }, [catalog, search]);

  const subtotal = useMemo(
    () => items.reduce((s, it) => s + it.unit_price * it.qty, 0),
    [items],
  );
  const total = Math.max(0, subtotal + Number(deliveryFee || 0));
  const needsRx = items.some((it) => it.prescription_required);

  function add(m: StorefrontMedicine) {
    setItems((prev) => {
      const i = prev.findIndex((p) => p.medicine_id === m.id);
      if (i >= 0) {
        const c = [...prev];
        c[i] = { ...c[i], qty: c[i].qty + 1 };
        return c;
      }
      return [
        ...prev,
        {
          medicine_id: m.id,
          name: m.name,
          qty: 1,
          unit_price: Number(m.price || 0),
          image_url: m.image_url ?? null,
          prescription_required: !!m.prescription_required,
        },
      ];
    });
  }

  function bump(idx: number, delta: number) {
    setItems((prev) => {
      const c = [...prev];
      const next = Math.max(0, c[idx].qty + delta);
      if (next === 0) return c.filter((_, i) => i !== idx);
      c[idx] = { ...c[idx], qty: next };
      return c;
    });
  }

  function remove(idx: number) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }

  function addCustom() {
    const name = customName.trim();
    if (!name) {
      setError("Item name দিন।");
      return;
    }
    const qty = Math.max(1, Math.floor(Number(customQty) || 1));
    const price = Math.max(0, Number(customPrice) || 0);
    setItems((prev) => [
      ...prev,
      { medicine_id: null, name, qty, unit_price: price, image_url: null },
    ]);
    setCustomName("");
    setCustomPrice(0);
    setCustomQty(1);
    setShowCustom(false);
    setError(null);
  }

  async function handleRx(file: File) {
    setUploadingRx(true);
    try {
      const url = await uploadImage(file);
      setRxUrl(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploadingRx(false);
    }
  }

  async function submit() {
    if (!items.length) {
      setError("কমপক্ষে একটি item add করুন।");
      return;
    }
    if (needsRx && !rxUrl) {
      setError("Prescription লাগবে — image upload করুন।");
      return;
    }
    // Delivery point = the customer's live location (the same one the app
    // browses with). The backend enforces the 5 km connect radius on every
    // chat order, so an order without coordinates would be rejected anyway.
    const loc = userLocation.load();
    if (!loc || !loc.ts) {
      setError(
        "Delivery location পাওয়া যায়নি — Home এ ফিরে location দিন। " +
        "MediDoor-এ আপনার ৫ km-এর মধ্যেই delivery হয়।",
      );
      return;
    }
    setSubmitting(true);
    const payload: OrderPayload = {
      items,
      subtotal,
      delivery_fee: deliveryFee,
      total,
      note: note.trim() || null,
      delivery_address: loc.label || null,
      delivery_lat: loc.lat,
      delivery_lng: loc.lng,
    };
    // Compact human-readable summary so the message looks good even
    // before the EventCard renders the rich payload.
    const lines = items.map(
      (it) => `• ${it.name} ×${it.qty} — ${formatBDT(it.unit_price * it.qty)}`,
    );
    const body = [
      "📦 *অর্ডার request*",
      ...lines,
      `*ঔষধ:* ${formatBDT(subtotal)}` +
        (deliveryFee ? ` · *ডেলিভারি:* ${formatBDT(deliveryFee)}` : "") +
        ` · *মোট:* ${formatBDT(total)}`,
      note.trim() ? `_নোট:_ ${note.trim()}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    onSubmit(payload, body, rxUrl);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      {/* Sheet */}
      <div
        className="relative z-10 mx-auto flex w-full max-w-[480px] flex-col rounded-t-3xl bg-white text-slate-900 shadow-2xl dark:bg-[#0b1220] dark:text-slate-100"
        style={{
          maxHeight: "92dvh",
          paddingBottom: "calc(var(--safe-bottom) + 12px)",
        }}
      >
        {/* Drag handle + title */}
        <div className="flex items-center gap-2 border-b border-slate-200/70 px-3 py-3 dark:border-white/10">
          <div className="mx-auto h-1 w-10 rounded-full bg-slate-300 dark:bg-white/15" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="tap absolute right-3 grid h-9 w-9 place-items-center rounded-full text-slate-500 hover:bg-slate-100 dark:hover:bg-white/5"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex items-center gap-2 px-4 pb-2 pt-1">
          <Package size={16} className="text-brand-500" />
          <h2 className="text-sm font-bold">অর্ডার request তৈরি করুন</h2>
        </div>

        {/* Search + catalog */}
        <div className="px-4">
          <label className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-white/[0.04]">
            <Search size={14} className="text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ওষুধ খুঁজুন…"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-slate-400"
            />
          </label>
        </div>
        <div className="mt-2 max-h-[28dvh] overflow-y-auto px-4">
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 size={16} className="animate-spin text-brand-500" />
            </div>
          ) : catalogError ? (
            <p className="py-6 text-center text-[12px] text-rose-500">
              {catalogError}
            </p>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-slate-500">
              কোনও medicine পাওয়া যায়নি।
            </p>
          ) : (
            <ul className="divide-y divide-slate-200/70 dark:divide-white/10">
              {filtered.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => add(m)}
                    className="tap flex w-full items-center gap-2 py-2 text-left"
                  >
                    <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-white/5">
                      {m.image_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={resolveMediaUrl(m.image_url) || ""}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-semibold">
                        {m.name}
                        {m.prescription_required && (
                          <span className="ml-1 rounded bg-rose-500/10 px-1 text-[9px] font-bold text-rose-500">
                            Rx
                          </span>
                        )}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {formatBDT(m.price)} · {m.category}
                      </p>
                    </div>
                    <Plus size={14} className="text-brand-500" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Custom-item toggle */}
        <div className="px-4 pt-2">
          {!showCustom ? (
            <button
              type="button"
              onClick={() => setShowCustom(true)}
              className="tap text-[11px] font-semibold text-brand-600 dark:text-brand-300"
            >
              + Custom item add করুন (catalog-এ নেই)
            </button>
          ) : (
            <div className="rounded-xl border border-slate-200 p-2 dark:border-white/10">
              <div className="flex gap-1">
                <input
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="নাম"
                  className="min-w-0 flex-1 rounded border border-slate-200 bg-transparent px-2 py-1 text-[12px] outline-none dark:border-white/10"
                />
                <input
                  type="number"
                  value={customPrice || ""}
                  onChange={(e) => setCustomPrice(Number(e.target.value))}
                  placeholder="৳"
                  className="w-16 rounded border border-slate-200 bg-transparent px-2 py-1 text-[12px] outline-none dark:border-white/10"
                />
                <input
                  type="number"
                  value={customQty || ""}
                  onChange={(e) => setCustomQty(Number(e.target.value))}
                  placeholder="Qty"
                  className="w-14 rounded border border-slate-200 bg-transparent px-2 py-1 text-[12px] outline-none dark:border-white/10"
                />
              </div>
              <div className="mt-1.5 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowCustom(false)}
                  className="tap rounded-full border border-slate-200 px-3 py-1 text-[11px] dark:border-white/10"
                >
                  বাতিল
                </button>
                <button
                  type="button"
                  onClick={addCustom}
                  className="tap rounded-full bg-brand-500 px-3 py-1 text-[11px] font-semibold text-white"
                >
                  Add করুন
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Basket */}
        <div className="mt-2 flex-1 overflow-y-auto border-t border-slate-200/70 px-4 pt-2 dark:border-white/10">
          {items.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-slate-500">
              Basket খালি — উপর থেকে item tap করুন।
            </p>
          ) : (
            <ul className="space-y-1.5">
              {items.map((it, idx) => (
                <li
                  key={`${it.medicine_id ?? "custom"}-${idx}`}
                  className="flex items-center gap-2 rounded-xl bg-slate-50 px-2 py-1.5 dark:bg-white/[0.04]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-semibold">
                      {it.name}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      {formatBDT(it.unit_price)} × {it.qty} ={" "}
                      <span className="font-semibold text-brand-600 dark:text-brand-400">
                        {formatBDT(it.unit_price * it.qty)}
                      </span>
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => bump(idx, -1)}
                    aria-label="Decrease"
                    className="tap grid h-7 w-7 place-items-center rounded-full bg-white text-slate-600 dark:bg-white/10 dark:text-slate-200"
                  >
                    <Minus size={12} />
                  </button>
                  <span className="w-5 text-center text-[12px] font-bold tabular-nums">
                    {it.qty}
                  </span>
                  <button
                    type="button"
                    onClick={() => bump(idx, 1)}
                    aria-label="Increase"
                    className="tap grid h-7 w-7 place-items-center rounded-full bg-white text-slate-600 dark:bg-white/10 dark:text-slate-200"
                  >
                    <Plus size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(idx)}
                    aria-label="Remove"
                    className="tap grid h-7 w-7 place-items-center rounded-full text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Note */}
          {items.length > 0 && (
            <div className="mt-3">
              <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-white/[0.04]">
                <ScrollText
                  size={13}
                  className="mt-0.5 shrink-0 text-slate-400"
                />
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="ফার্মেসিকে কোনো note? (optional)"
                  rows={2}
                  className="min-w-0 flex-1 resize-none bg-transparent text-[12px] outline-none placeholder:text-slate-400"
                />
              </label>
            </div>
          )}

          {/* Rx upload — only when at least one item is Rx */}
          {needsRx && (
            <div className="mt-2 rounded-xl border border-rose-200/70 bg-rose-50/50 p-2 dark:border-rose-500/30 dark:bg-rose-500/10">
              <p className="text-[11px] font-semibold text-rose-700 dark:text-rose-300">
                Prescription লাগবে
              </p>
              {rxUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={resolveMediaUrl(rxUrl) || ""}
                  alt="Rx"
                  className="mt-1 h-24 rounded-lg object-cover"
                />
              ) : (
                <label className="tap mt-1 inline-flex items-center gap-1 rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-rose-700 dark:bg-white/10 dark:text-rose-200">
                  {uploadingRx ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <ImagePlus size={12} />
                  )}{" "}
                  Prescription ছবি দিন
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleRx(f);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>
              )}
            </div>
          )}
        </div>

        {/* Footer totals + CTA */}
        <div className="border-t border-slate-200/70 bg-white px-4 py-2 dark:border-white/10 dark:bg-[#0b1220]">
          {error && (
            <p className="mb-1 text-[11px] text-rose-500">{error}</p>
          )}
          <div className="flex items-end justify-between">
            <div className="text-[10px] text-slate-500">
              ঔষধ {formatBDT(subtotal)}
              {deliveryFee > 0 ? ` · ডেলিভারি ${formatBDT(deliveryFee)}` : ""}
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wider text-slate-400">
                মোট
              </p>
              <p className="text-base font-extrabold text-brand-600 dark:text-brand-400">
                {formatBDT(total)}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={submitting || items.length === 0}
            onClick={submit}
            className="tap mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-brand-500 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Send size={14} />
            )}
            অর্ডার request পাঠান
          </button>
        </div>
      </div>
    </div>
  );
}
