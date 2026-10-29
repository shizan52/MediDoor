"use client";

/**
 * Pharmacy-side in-chat order composer. Bottom-sheet with the same
 * itemised shape as the customer composer, but used for two pharmacy
 * actions:
 *
 *   - mode="quote"  : pharmacy issues a price quote (preset_key=pharmacy_quote)
 *   - mode="modify" : pharmacy modifies the customer's request items
 *                     (e.g. partial-fulfillment) before quoting.
 *
 * Mirrors the website's `OrderComposer` mode="quote"|"modify" branch in
 * `frontend/src/components/order-composer.tsx` so the resulting payload
 * is byte-for-byte compatible with what the pharmacy_quote bubble on
 * the customer side already expects.
 */
import { useEffect, useMemo, useState } from "react";
import {
  X, Search, Plus, Minus, Trash2, Send, Package, Loader2, ScrollText,
} from "lucide-react";
import { fetchPharmacy, type StorefrontMedicine } from "@/lib/storefront";
import {
  formatBDT, type OrderLineItem, type OrderPayload,
} from "@/lib/conversations";
import { resolveMediaUrl } from "@/lib/api";

type Props = {
  pharmacyId: string;
  mode: "quote" | "modify";
  defaultDeliveryFee?: number;
  initialItems?: OrderLineItem[];
  initialNote?: string;
  onClose: () => void;
  onSubmit: (payload: OrderPayload, body: string) => void;
};

export function PharmacyOrderComposer({
  pharmacyId,
  mode,
  defaultDeliveryFee,
  initialItems,
  initialNote,
  onClose,
  onSubmit,
}: Props) {
  const [catalog, setCatalog] = useState<StorefrontMedicine[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<OrderLineItem[]>(initialItems ?? []);
  const [deliveryFee, setDeliveryFee] = useState<number>(defaultDeliveryFee ?? 0);
  const [note, setNote] = useState(initialNote ?? "");
  const [showCustom, setShowCustom] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customPrice, setCustomPrice] = useState<number>(0);
  const [customQty, setCustomQty] = useState<number>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchPharmacy(pharmacyId)
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
      .catch(() => setCatalog([]))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [pharmacyId, defaultDeliveryFee]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalog.slice(0, 30);
    return catalog
      .filter((m) => m.name.toLowerCase().includes(q) || m.category.toLowerCase().includes(q))
      .slice(0, 30);
  }, [catalog, search]);

  const subtotal = useMemo(
    () => items.reduce((s, it) => s + it.unit_price * it.qty, 0),
    [items],
  );
  const total = Math.max(0, subtotal + Number(deliveryFee || 0));

  function add(m: StorefrontMedicine) {
    setItems((prev) => {
      const i = prev.findIndex((p) => p.medicine_id === m.id);
      if (i >= 0) {
        const c = [...prev]; c[i] = { ...c[i], qty: c[i].qty + 1 }; return c;
      }
      return [...prev, {
        medicine_id: m.id, name: m.name, qty: 1,
        unit_price: Number(m.price || 0), image_url: m.image_url ?? null,
        prescription_required: !!m.prescription_required,
      }];
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

  function setExactQty(idx: number, value: number) {
    setItems((prev) => {
      const c = [...prev];
      const next = Math.max(0, Math.floor(Number(value) || 0));
      if (next === 0) return c.filter((_, i) => i !== idx);
      c[idx] = { ...c[idx], qty: next };
      return c;
    });
  }

  function setExactPrice(idx: number, value: number) {
    setItems((prev) => {
      const c = [...prev];
      c[idx] = { ...c[idx], unit_price: Math.max(0, Number(value) || 0) };
      return c;
    });
  }

  function remove(idx: number) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }

  function addCustom() {
    const name = customName.trim();
    if (!name) { setError("Item name দিন।"); return; }
    const qty = Math.max(1, Math.floor(Number(customQty) || 1));
    const price = Math.max(0, Number(customPrice) || 0);
    setItems((prev) => [...prev, {
      medicine_id: null, name, qty, unit_price: price, image_url: null,
    }]);
    setCustomName(""); setCustomPrice(0); setCustomQty(1);
    setShowCustom(false); setError(null);
  }

  function submit() {
    if (!items.length) { setError("কমপক্ষে একটি item দিন।"); return; }
    setSubmitting(true);
    const payload: OrderPayload = {
      items,
      subtotal,
      delivery_fee: deliveryFee,
      total,
      note: note.trim() || null,
    };
    const lines = items.map(
      (it) => `• ${it.name} ×${it.qty} — ${formatBDT(it.unit_price * it.qty)}`,
    );
    const headerLine = `🧾 *Quote পাঠালাম* — মোট ${formatBDT(total)}`;
    const body = [
      headerLine,
      ...lines,
      `*ঔষধ:* ${formatBDT(subtotal)}` +
        (deliveryFee ? ` · *ডেলিভারি:* ${formatBDT(deliveryFee)}` : "") +
        ` · *মোট:* ${formatBDT(total)}`,
      note.trim() ? `_নোট:_ ${note.trim()}` : null,
    ].filter(Boolean).join("\n");
    onSubmit(payload, body);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        className="relative z-10 mx-auto flex w-full max-w-[480px] flex-col rounded-t-3xl bg-white text-slate-900 shadow-2xl dark:bg-[#0b1220] dark:text-slate-100"
        style={{
          maxHeight: "92dvh",
          paddingBottom: "calc(var(--safe-bottom) + 12px)",
        }}
      >
        <div className="relative flex items-center gap-2 border-b border-slate-200/70 px-3 py-3 dark:border-white/10">
          <div className="mx-auto h-1 w-10 rounded-full bg-slate-300 dark:bg-white/15" />
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="tap absolute right-3 grid h-9 w-9 place-items-center rounded-full text-slate-500 hover:bg-slate-100 dark:hover:bg-white/5"
          ><X size={16} /></button>
        </div>
        <div className="flex items-center gap-2 px-4 pb-2 pt-1">
          <Package size={16} className="text-brand-500" />
          <h2 className="text-sm font-bold">
            {mode === "modify" ? "✏️ Items modify করে quote পাঠান" : "🧾 Customer-কে quote পাঠান"}
          </h2>
        </div>

        {/* Search + catalog */}
        <div className="px-4">
          <label className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-white/[0.04]">
            <Search size={14} className="text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="আপনার catalog থেকে medicine search…"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-slate-400"
            />
          </label>
        </div>
        <div className="mt-2 max-h-[24dvh] overflow-y-auto px-4">
          {loading ? (
            <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-brand-500" /></div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-slate-500">কোনও medicine পাওয়া যায়নি।</p>
          ) : (
            <ul className="divide-y divide-slate-200/70 dark:divide-white/10">
              {filtered.map((m) => (
                <li key={m.id}>
                  <button
                    type="button" onClick={() => add(m)}
                    className="tap flex w-full items-center gap-2 py-2 text-left"
                  >
                    <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-white/5">
                      {m.image_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={resolveMediaUrl(m.image_url) || ""} alt="" className="h-full w-full object-cover" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-semibold">
                        {m.name}
                        {m.prescription_required && (
                          <span className="ml-1 rounded bg-rose-500/10 px-1 text-[9px] font-bold text-rose-500">Rx</span>
                        )}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {formatBDT(m.price)} · stock {m.stock} · {m.category}
                      </p>
                    </div>
                    <Plus size={14} className="text-brand-500" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Custom item */}
        <div className="px-4 pt-2">
          {!showCustom ? (
            <button
              type="button" onClick={() => setShowCustom(true)}
              className="tap text-[11px] font-semibold text-brand-600 dark:text-brand-300"
            >+ Custom item add করুন (catalog-এ নেই)</button>
          ) : (
            <div className="rounded-xl border border-slate-200 p-2 dark:border-white/10">
              <div className="flex gap-1">
                <input
                  value={customName} onChange={(e) => setCustomName(e.target.value)}
                  placeholder="নাম"
                  className="min-w-0 flex-1 rounded border border-slate-200 bg-transparent px-2 py-1 text-[12px] outline-none dark:border-white/10"
                />
                <input
                  type="number" value={customPrice || ""} onChange={(e) => setCustomPrice(Number(e.target.value))}
                  placeholder="৳"
                  className="w-16 rounded border border-slate-200 bg-transparent px-2 py-1 text-[12px] outline-none dark:border-white/10"
                />
                <input
                  type="number" value={customQty || ""} onChange={(e) => setCustomQty(Number(e.target.value))}
                  placeholder="Qty"
                  className="w-14 rounded border border-slate-200 bg-transparent px-2 py-1 text-[12px] outline-none dark:border-white/10"
                />
              </div>
              <div className="mt-1.5 flex justify-end gap-1.5">
                <button type="button" onClick={() => setShowCustom(false)}
                  className="tap rounded-full border border-slate-200 px-3 py-1 text-[11px] dark:border-white/10">বাতিল</button>
                <button type="button" onClick={addCustom}
                  className="tap rounded-full bg-brand-500 px-3 py-1 text-[11px] font-semibold text-white">Add করুন</button>
              </div>
            </div>
          )}
        </div>

        {/* Basket — pharmacy can edit price + qty per row */}
        <div className="mt-2 flex-1 overflow-y-auto border-t border-slate-200/70 px-4 pt-2 dark:border-white/10">
          {items.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-slate-500">
              উপরের catalog থেকে item tap করুন।
            </p>
          ) : (
            <ul className="space-y-1.5">
              {items.map((it, idx) => (
                <li key={`${it.medicine_id ?? "custom"}-${idx}`}
                    className="rounded-xl bg-slate-50 px-2 py-1.5 dark:bg-white/[0.04]">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-semibold">{it.name}</p>
                      <p className="text-[10px] text-slate-500">
                        {formatBDT(it.unit_price)} × {it.qty} ={" "}
                        <span className="font-semibold text-brand-600 dark:text-brand-400">
                          {formatBDT(it.unit_price * it.qty)}
                        </span>
                      </p>
                    </div>
                    <button type="button" onClick={() => bump(idx, -1)} aria-label="Decrease"
                      className="tap grid h-7 w-7 place-items-center rounded-full bg-white text-slate-600 dark:bg-white/10 dark:text-slate-200">
                      <Minus size={12} />
                    </button>
                    <input
                      type="number" min={0} value={it.qty}
                      onChange={(e) => setExactQty(idx, Number(e.target.value))}
                      className="w-10 rounded bg-white px-1 py-0.5 text-center text-[12px] font-bold tabular-nums dark:bg-white/10"
                    />
                    <button type="button" onClick={() => bump(idx, 1)} aria-label="Increase"
                      className="tap grid h-7 w-7 place-items-center rounded-full bg-white text-slate-600 dark:bg-white/10 dark:text-slate-200">
                      <Plus size={12} />
                    </button>
                    <button type="button" onClick={() => remove(idx)} aria-label="Remove"
                      className="tap grid h-7 w-7 place-items-center rounded-full text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10">
                      <Trash2 size={12} />
                    </button>
                  </div>
                  {/* Price-edit row — pharmacy may want to override the catalog price */}
                  <div className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-500">
                    <span>প্রতি unit ৳</span>
                    <input
                      type="number" min={0} value={it.unit_price}
                      onChange={(e) => setExactPrice(idx, Number(e.target.value))}
                      className="w-20 rounded bg-white px-1 py-0.5 text-center text-[11px] tabular-nums dark:bg-white/10"
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {items.length > 0 && (
            <div className="mt-3 space-y-2">
              <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-white/[0.04]">
                <ScrollText size={13} className="mt-0.5 shrink-0 text-slate-400" />
                <textarea
                  value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="Customer-কে কোনো note? (যেমন: বিকল্প brand, ETA…)"
                  rows={2}
                  className="min-w-0 flex-1 resize-none bg-transparent text-[12px] outline-none placeholder:text-slate-400"
                />
              </label>
              <label className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] dark:border-white/10 dark:bg-white/[0.04]">
                <span className="text-slate-500">ডেলিভারি fee (৳)</span>
                <input
                  type="number" min={0} value={deliveryFee}
                  onChange={(e) => setDeliveryFee(Math.max(0, Number(e.target.value) || 0))}
                  className="w-20 rounded bg-slate-100 px-2 py-0.5 text-right text-[12px] font-semibold tabular-nums dark:bg-white/10"
                />
              </label>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-200/70 bg-white px-4 py-2 dark:border-white/10 dark:bg-[#0b1220]">
          {error && <p className="mb-1 text-[11px] text-rose-500">{error}</p>}
          <div className="flex items-end justify-between">
            <div className="text-[10px] text-slate-500">
              ঔষধ {formatBDT(subtotal)}
              {deliveryFee > 0 ? ` · ডেলিভারি ${formatBDT(deliveryFee)}` : ""}
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wider text-slate-400">মোট</p>
              <p className="text-base font-extrabold text-brand-600 dark:text-brand-400">{formatBDT(total)}</p>
            </div>
          </div>
          <button
            type="button" disabled={submitting || items.length === 0} onClick={submit}
            className="tap mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-brand-500 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {mode === "modify" ? "Modified quote পাঠান" : "Quote পাঠান"}
          </button>
        </div>
      </div>
    </div>
  );
}
