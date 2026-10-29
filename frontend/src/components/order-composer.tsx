"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Search,
  Plus,
  Minus,
  Trash2,
  ShoppingBasket,
  Package,
  Send,
  GripVertical,
  Inbox,
} from "lucide-react";
import { fetchPharmacy, userLocation, type StorefrontMedicine } from "@/lib/storefront";
import {
  formatBDT,
  type OrderLineItem,
  type OrderPayload,
} from "@/lib/conversations";
import { uploadImage, resolveMediaUrl } from "@/lib/api";
import { getPreciseLocation, locationErrorMessage } from "@/lib/geo";

/**
 * Order composer modal.
 *
 * UX: left-side catalog (search + click OR drag), right-side basket
 * (per-row qty +/− with manual entry, delete, live total). Shared by
 * customer "Order request" (mode="request") and pharmacy "Send quote"
 * (mode="quote").
 */
export function OrderComposer({
  pharmacyId,
  mode,
  defaultDeliveryFee,
  initialItems,
  initialNote,
  onSubmit,
  onClose,
}: {
  pharmacyId: string;
  mode: "request" | "quote";
  defaultDeliveryFee?: number;
  initialItems?: OrderLineItem[];
  initialNote?: string;
  onSubmit: (payload: OrderPayload, body: string, attachmentUrl?: string | null) => void;
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<StorefrontMedicine[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [pharmacyName, setPharmacyName] = useState("Pharmacy");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<OrderLineItem[]>(initialItems ?? []);
  const [customName, setCustomName] = useState("");
  const [customPrice, setCustomPrice] = useState<number>(0);
  const [customQty, setCustomQty] = useState<number>(1);
  const [deliveryFee, setDeliveryFee] = useState<number>(defaultDeliveryFee ?? 0);
  const [note, setNote] = useState(initialNote ?? "");
  const [error, setError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryCoords, setDeliveryCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [prescriptionUrl, setPrescriptionUrl] = useState<string | null>(null);
  const [uploadingRx, setUploadingRx] = useState(false);

  const rxItems = useMemo(
    () => items.filter((it) => it.prescription_required),
    [items],
  );
  const needsPrescription = rxItems.length > 0;

  useEffect(() => {
    setMounted(true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // The storefront endpoint enforces the 5 km connect gate for customers,
    // so the catalog fetch must carry the customer's location. Pharmacies
    // quoting from their own catalog are exempted server-side (auth token).
    const stored = mode === "request" ? userLocation.load() : null;
    const lat = mode === "request" ? (deliveryCoords?.lat ?? stored?.lat ?? null) : null;
    const lng = mode === "request" ? (deliveryCoords?.lng ?? stored?.lng ?? null) : null;
    if (mode === "request" && (lat == null || lng == null)) {
      setCatalog([]);
      setCatalogError(
        "Location পাওয়া যায়নি — নিচের \"📍 আমার লোকেশন\" button চাপুন, catalog নিজে থেকেই চলে আসবে।",
      );
      setLoading(false);
      return;
    }
    setCatalogError(null);
    fetchPharmacy(pharmacyId, { lat, lng })
      .then((d) => {
        if (cancelled) return;
        setPharmacyName(d.pharmacy.name);
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
  }, [pharmacyId, defaultDeliveryFee, mode, deliveryCoords]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalog.slice(0, 50);
    return catalog
      .filter(
        (m) => m.name.toLowerCase().includes(q) || m.category.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [catalog, search]);

  const subtotal = useMemo(
    () => items.reduce((s, it) => s + it.unit_price * it.qty, 0),
    [items],
  );
  const total = useMemo(
    () => Math.max(0, subtotal + Number(deliveryFee || 0)),
    [subtotal, deliveryFee],
  );

  function addCatalogItem(m: StorefrontMedicine) {
    setItems((prev) => {
      const idx = prev.findIndex((p) => p.medicine_id === m.id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], qty: copy[idx].qty + 1 };
        return copy;
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

  function changeQty(idx: number, delta: number) {
    setItems((prev) => {
      const copy = [...prev];
      const next = Math.max(0, copy[idx].qty + delta);
      if (next === 0) return copy.filter((_, i) => i !== idx);
      copy[idx] = { ...copy[idx], qty: next };
      return copy;
    });
  }

  function setExactQty(idx: number, value: number) {
    setItems((prev) => {
      const copy = [...prev];
      const next = Math.max(0, Math.floor(Number(value) || 0));
      if (next === 0) return copy.filter((_, i) => i !== idx);
      copy[idx] = { ...copy[idx], qty: next };
      return copy;
    });
  }

  function removeItem(idx: number) {
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
    setError(null);
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setError(locationErrorMessage());
      return;
    }
    setLocating(true);
    getPreciseLocation({ desiredAccuracyM: 25, bestEffortAfterMs: 12_000, timeoutMs: 22_000 })
      .then((fix) => {
        setDeliveryCoords({ lat: fix.lat, lng: fix.lng });
        setError(
          fix.accuracy > 100
            ? `Location ±${Math.round(fix.accuracy)} m (Wi-Fi based) — outdoor-এ গিয়ে আবার try করলে GPS এ pin-point হবে।`
            : null,
        );
      })
      .catch((err) => setError(locationErrorMessage(err)))
      .finally(() => setLocating(false));
  }

  function submit() {
    if (items.length === 0) {
      setError("কমপক্ষে ১টি item add করুন।");
      return;
    }
    if (mode === "request" && !deliveryAddress.trim()) {
      setError("Delivery address দিন — rider এখানেই পৌঁছাবে।");
      return;
    }
    if (mode === "request" && !deliveryCoords) {
      setError(
        "Delivery location দিন (📍 বোতাম) — location ছাড়া order পাঠানো যাবে না; " +
        "MediDoor-এ আপনার ৫ km-এর মধ্যেই delivery হয়।",
      );
      return;
    }
    if (mode === "request" && needsPrescription && !prescriptionUrl) {
      setError(
        `এই order-এ prescription আবশ্যক (${rxItems.map((x) => x.name).slice(0, 3).join(", ")})। নিচের "Prescription upload" থেকে ছবি দিন।`,
      );
      return;
    }
    const payload: OrderPayload = {
      items,
      subtotal: round2(subtotal),
      delivery_fee: round2(Number(deliveryFee || 0)),
      total: round2(total),
      note: note.trim() || null,
      delivery_address: deliveryAddress.trim() || null,
      delivery_lat: deliveryCoords?.lat ?? null,
      delivery_lng: deliveryCoords?.lng ?? null,
    };
    const summary = items
      .map(
        (it) =>
          `• ${it.name}${it.prescription_required ? " 📋" : ""} ×${it.qty} — ${formatBDT(it.unit_price * it.qty)}`,
      )
      .join("\n");
    const headerLine =
      mode === "request"
        ? `📦 অর্ডার request পাঠালাম — মোট ${formatBDT(payload.total)}`
        : `🧾 Quote পাঠালাম — মোট ${formatBDT(payload.total)}`;
    const rxLine =
      needsPrescription && prescriptionUrl
        ? `\n📋 Prescription সংযুক্ত করা হয়েছে।`
        : "";
    const body = `${headerLine}\n${summary}${rxLine}${note.trim() ? `\nনোট: ${note.trim()}` : ""}`;
    onSubmit(payload, body, prescriptionUrl);
  }

  async function onPickPrescription(file: File) {
    setUploadingRx(true);
    try {
      const url = await uploadImage(file);
      setPrescriptionUrl(url);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Prescription upload failed");
    } finally {
      setUploadingRx(false);
    }
  }

  function handleDragStart(e: React.DragEvent<HTMLLIElement>, m: StorefrontMedicine) {
    e.dataTransfer.setData("application/x-medidoor-medicine", m.id);
    e.dataTransfer.effectAllowed = "copy";
  }
  function handleDropOnBasket(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDropActive(false);
    const id = e.dataTransfer.getData("application/x-medidoor-medicine");
    if (!id) return;
    const m = catalog.find((x) => x.id === id);
    if (m) addCatalogItem(m);
  }
  function handleDragOverBasket(e: React.DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.types.includes("application/x-medidoor-medicine")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropActive(true);
    }
  }

  if (!mounted) return null;

  const overlay = (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[60] grid place-items-center p-3 sm:p-6 bg-black/70 backdrop-blur-md overflow-y-auto"
        onClick={onClose}
      >
        <motion.div
          initial={{ y: 40, opacity: 0, scale: 0.92, rotateX: -8 }}
          animate={{ y: 0, opacity: 1, scale: 1, rotateX: 0 }}
          exit={{ y: 40, opacity: 0, scale: 0.92, rotateX: -8 }}
          transition={{ type: "spring", stiffness: 260, damping: 26 }}
          onClick={(e) => e.stopPropagation()}
          style={{
            transformStyle: "preserve-3d",
            perspective: "1200px",
            boxShadow:
              "0 60px 120px -20px rgba(6, 173, 101, 0.35), 0 30px 60px -25px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255,255,255,0.05) inset",
          }}
          className="relative flex w-[min(1100px,96vw)] h-[min(780px,92vh)] flex-col overflow-hidden rounded-3xl bg-white dark:bg-[#0b1018] border border-black/10 dark:border-white/10 text-slate-900 dark:text-slate-100 ring-1 ring-brand-500/20"
        >
          {/* header */}
          <div className="flex items-center gap-3 border-b border-black/5 dark:border-white/10 bg-gradient-to-r from-brand-500/15 to-emerald-500/10 px-4 py-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand-500 text-white shadow-md shadow-brand-500/30">
              {mode === "request" ? <ShoppingBasket size={18} /> : <Package size={18} />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">
                {mode === "request" ? "📦 অর্ডার request তৈরি করুন" : "🧾 Customer-কে quote পাঠান"}
              </p>
              <p className="truncate text-[11px] text-slate-600 dark:text-slate-300">
                {pharmacyName} · বাঁ দিকের medicine click করুন <b>অথবা</b> ডান basket-এ drag করুন
              </p>
            </div>
            <button
              onClick={onClose}
              className="grid h-9 w-9 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          {/* body */}
          <div className="grid min-h-0 flex-1 overflow-hidden grid-rows-[minmax(0,1fr)_minmax(0,1fr)] md:grid-rows-1 md:grid-cols-[1fr_1.05fr]">
            {/* LEFT — catalog */}
            <div className="flex min-h-0 flex-col overflow-hidden border-b md:border-b-0 md:border-r border-black/5 dark:border-white/10 bg-slate-50 dark:bg-white/[0.02]">
              <div className="flex items-center justify-between gap-2 px-3 pt-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Step 1 · ওষুধ বাছুন
                </p>
                <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-700 dark:text-brand-300">
                  {filtered.length} item
                </span>
              </div>
              <div className="m-3 mt-2 flex items-center gap-2 rounded-xl bg-white dark:bg-white/5 px-3 py-2 ring-1 ring-black/5 dark:ring-white/10">
                <Search size={14} className="text-slate-500" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="ওষুধের নাম বা category..."
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {loading && (
                  <p className="px-2 py-3 text-[12px] text-slate-500">Loading catalog…</p>
                )}
                {!loading && catalogError && (
                  <div className="m-2 rounded-xl border border-rose-300/60 bg-rose-50/70 p-3 text-center text-[12px] text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
                    {catalogError}
                  </div>
                )}
                {!loading && !catalogError && filtered.length === 0 && (
                  <div className="m-2 rounded-xl border border-dashed border-slate-300 dark:border-white/10 p-3 text-center text-[12px] text-slate-500 dark:text-slate-400">
                    কোনো medicine নেই। নিচের Custom item box দিয়ে নিজেই দিন।
                  </div>
                )}
                <ul className="space-y-1">
                  {filtered.map((m) => (
                    <li
                      key={m.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, m)}
                      className="group flex cursor-grab items-center gap-2 rounded-xl bg-white dark:bg-white/5 px-2 py-2 ring-1 ring-transparent hover:ring-brand-400/40 hover:bg-brand-50 dark:hover:bg-brand-500/10 transition active:cursor-grabbing"
                      onClick={() => addCatalogItem(m)}
                    >
                      <GripVertical
                        size={14}
                        className="shrink-0 text-slate-300 group-hover:text-brand-500"
                      />
                      <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-100 dark:bg-white/10">
                        {m.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={resolveMediaUrl(m.image_url)}
                            alt={m.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <Package size={14} className="text-slate-400" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-semibold text-slate-900 dark:text-white">
                          {m.name}
                        </p>
                        <p className="truncate text-[10px] text-slate-500 dark:text-slate-400">
                          {m.category} · Stock {m.stock}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-0.5">
                        <p className="text-[12px] font-bold text-brand-700 dark:text-brand-300">
                          {formatBDT(m.price)}
                        </p>
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-brand-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-brand-700 dark:text-brand-300">
                          <Plus size={9} /> Add
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
              {/* custom-item entry (pinned at bottom of left column) */}
              <div className="shrink-0 border-t border-black/5 dark:border-white/10 bg-amber-50 dark:bg-amber-950/20 px-3 py-2.5">
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                  ✏️ Custom item (catalog-এ নেই?)
                </p>
                <div className="grid grid-cols-[1fr_50px_70px_auto] items-center gap-1.5">
                  <input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="Item নাম"
                    className="min-w-0 rounded-lg bg-white dark:bg-white/10 border border-amber-200 dark:border-amber-800/40 px-2 py-1.5 text-[12px] outline-none focus:ring-2 focus:ring-amber-400/50"
                  />
                  <input
                    type="number"
                    min={1}
                    value={customQty}
                    onChange={(e) => setCustomQty(Number(e.target.value))}
                    className="rounded-lg bg-white dark:bg-white/10 border border-amber-200 dark:border-amber-800/40 px-1.5 py-1.5 text-center text-[12px] outline-none"
                    title="Quantity"
                  />
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={customPrice}
                    onChange={(e) => setCustomPrice(Number(e.target.value))}
                    placeholder="৳ দাম"
                    className="rounded-lg bg-white dark:bg-white/10 border border-amber-200 dark:border-amber-800/40 px-1.5 py-1.5 text-right text-[12px] outline-none"
                  />
                  <button
                    type="button"
                    onClick={addCustom}
                    className="rounded-lg bg-amber-500 px-2.5 py-1.5 text-[11px] font-bold text-white shadow-sm hover:bg-amber-600"
                  >
                    + Add
                  </button>
                </div>
              </div>
            </div>

            {/* RIGHT — basket */}
            <div
              onDragOver={handleDragOverBasket}
              onDragLeave={() => setDropActive(false)}
              onDrop={handleDropOnBasket}
              className={`flex min-h-0 flex-col overflow-hidden transition ${
                dropActive
                  ? "bg-brand-50 dark:bg-brand-950/30 ring-2 ring-inset ring-brand-500"
                  : "bg-white dark:bg-white/[0.02]"
              }`}
            >
              <div className="flex items-center justify-between px-3 pt-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Step 2 · Item list ({items.length})
                </p>
                {items.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setItems([])}
                    className="text-[10px] font-medium text-rose-500 hover:underline"
                  >
                    সব clear
                  </button>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                {items.length === 0 && (
                  <div
                    className={`grid h-full place-items-center rounded-2xl border-2 border-dashed p-6 text-center transition ${
                      dropActive
                        ? "border-brand-500 bg-brand-100/40 dark:bg-brand-900/20"
                        : "border-slate-300 dark:border-white/15"
                    }`}
                  >
                    <div>
                      <Inbox size={36} className="mx-auto mb-2 text-slate-400" />
                      <p className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">
                        এখানে item drop করুন
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                        বাঁ দিক থেকে medicine drag করে আনুন
                        <br />
                        অথবা medicine-এ click করলেই auto add হবে
                      </p>
                    </div>
                  </div>
                )}
                <ul className="space-y-2">
                  {items.map((it, idx) => (
                    <li
                      key={`${it.medicine_id ?? "custom"}-${idx}`}
                      className="flex items-center gap-2 rounded-xl border border-black/10 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-2 py-2"
                    >
                      <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-white dark:bg-white/10">
                        {it.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={resolveMediaUrl(it.image_url)}
                            alt={it.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <Package size={14} className="text-slate-400" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-bold text-slate-900 dark:text-white">
                          {it.name}
                        </p>
                        <p className="text-[10px] text-slate-500 dark:text-slate-300">
                          {formatBDT(it.unit_price)} × {it.qty} ={" "}
                          <span className="font-bold text-emerald-700 dark:text-emerald-300">
                            {formatBDT(it.unit_price * it.qty)}
                          </span>
                        </p>
                      </div>
                      <div className="flex items-center gap-0.5 rounded-full bg-white dark:bg-white/10 ring-1 ring-black/10 dark:ring-white/10">
                        <button
                          type="button"
                          onClick={() => changeQty(idx, -1)}
                          className="grid h-7 w-7 place-items-center rounded-full hover:bg-rose-500/20 text-rose-600 dark:text-rose-300"
                          aria-label="Decrease"
                        >
                          <Minus size={12} />
                        </button>
                        <input
                          type="number"
                          min={0}
                          value={it.qty}
                          onChange={(e) => setExactQty(idx, Number(e.target.value))}
                          className="w-9 bg-transparent text-center text-[12px] font-bold outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => changeQty(idx, +1)}
                          className="grid h-7 w-7 place-items-center rounded-full hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
                          aria-label="Increase"
                        >
                          <Plus size={12} />
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeItem(idx)}
                        className="grid h-7 w-7 place-items-center rounded-full text-rose-500 hover:bg-rose-500/15"
                        aria-label="Remove"
                      >
                        <Trash2 size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              {/* totals + note (pinned to bottom of right column) */}
              <div className="shrink-0 border-t border-black/10 dark:border-white/10 bg-slate-50 dark:bg-white/[0.03] px-3 py-3">
                {mode === "request" && (
                  <div className="mb-2 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                        📍 Delivery address <span className="text-rose-500">*</span>
                      </label>
                      <button
                        type="button"
                        onClick={useMyLocation}
                        disabled={locating}
                        className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-700 hover:bg-brand-500/20 dark:text-brand-300 disabled:opacity-50"
                      >
                        {locating ? "লোকেশন নিচ্ছে…" : deliveryCoords ? "✓ Location captured" : "📍 আমার লোকেশন"}
                      </button>
                    </div>
                    <textarea
                      rows={2}
                      value={deliveryAddress}
                      onChange={(e) => setDeliveryAddress(e.target.value)}
                      placeholder="বাসা, রাস্তা, এলাকা, landmark…"
                      className="w-full rounded-lg bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 px-2 py-1.5 text-[12px] outline-none focus:ring-2 focus:ring-brand-500/40 placeholder:text-slate-400"
                    />
                  </div>
                )}
                <div className="mb-2">
                  <textarea
                    rows={2}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={
                      mode === "request"
                        ? "📝 Pharmacy-কে কোনো বিশেষ instruction (optional)…"
                        : "📝 Customer-কে কোনো extra note (optional)…"
                    }
                    className="w-full rounded-lg bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 px-2 py-1.5 text-[12px] outline-none focus:ring-2 focus:ring-brand-500/40 placeholder:text-slate-400"
                  />
                </div>
                {mode === "request" && needsPrescription && (
                  <div className="mb-2 rounded-xl border border-rose-300/50 bg-rose-50/70 p-2.5 text-[12px] dark:border-rose-400/30 dark:bg-rose-500/10">
                    <p className="font-bold text-rose-700 dark:text-rose-300">
                      📋 এই order-এ prescription আবশ্যক
                    </p>
                    <p className="mt-0.5 text-[11px] text-rose-700/90 dark:text-rose-200/90">
                      নিচের item গুলোর জন্য prescription upload করতে হবে:{" "}
                      <b>{rxItems.map((x) => x.name).join(", ")}</b>
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <label className="cursor-pointer rounded-full bg-rose-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-rose-700">
                        <input
                          type="file"
                          accept="image/*,.pdf"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) onPickPrescription(f);
                          }}
                        />
                        {uploadingRx
                          ? "Uploading…"
                          : prescriptionUrl
                            ? "📋 Prescription বদলান"
                            : "📋 Prescription upload"}
                      </label>
                      {prescriptionUrl && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-600/90 px-2 py-0.5 text-[10px] font-bold text-white">
                          ✓ সংযুক্ত
                        </span>
                      )}
                    </div>
                  </div>
                )}
                <div className="space-y-1 rounded-xl bg-white dark:bg-white/5 p-2.5 ring-1 ring-black/5 dark:ring-white/10 text-[12px]">
                  <div className="flex items-center justify-between text-slate-700 dark:text-slate-200">
                    <span>ঔষধ ({items.length} item)</span>
                    <b className="tabular-nums">{formatBDT(subtotal)}</b>
                  </div>
                  <div className="flex items-center justify-between text-slate-700 dark:text-slate-200">
                    <span>ডেলিভারি fee</span>
                    <input
                      type="number"
                      min={0}
                      step="1"
                      value={deliveryFee}
                      onChange={(e) => setDeliveryFee(Number(e.target.value))}
                      className="w-20 rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-white/10 px-1.5 py-0.5 text-right text-[12px] tabular-nums outline-none"
                    />
                  </div>
                  <div className="flex items-center justify-between border-t border-black/10 dark:border-white/15 pt-1.5 text-[15px]">
                    <span className="font-extrabold text-slate-900 dark:text-white">মোট</span>
                    <b className="tabular-nums text-emerald-700 dark:text-emerald-300">
                      {formatBDT(total)}
                    </b>
                  </div>
                </div>
                {error && (
                  <p className="mt-2 text-[11px] font-semibold text-rose-600 dark:text-rose-400">
                    {error}
                  </p>
                )}
                <button
                  type="button"
                  onClick={submit}
                  disabled={items.length === 0}
                  className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-brand-500 to-emerald-500 px-4 py-2.5 text-[13px] font-bold text-white shadow-lg shadow-brand-500/30 transition hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100"
                >
                  <Send size={14} />
                  {mode === "request"
                    ? `অর্ডার request পাঠান · ${formatBDT(total)}`
                    : `Quote পাঠান · ${formatBDT(total)}`}
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );

  return createPortal(overlay, document.body);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
