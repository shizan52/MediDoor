"use client";

/**
 * Medicines inventory. List + search + tap-to-edit. New medicine
 * creates via /medicines/new (image-required). Active toggle + stock
 * inline. Categories assigned automatically by AI on save.
 */
import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, ChevronRight, Loader2, Pill, Plus, Search,
  ShieldAlert, Sparkles, X,
} from "lucide-react";
import { MobileHeader } from "@/components/mobile-header";
import { NotificationsBell } from "@/components/notifications-bell";
import { resolveMediaUrl, session } from "@/lib/api";
import { pharmacyApi, type PharmacyMedicine } from "@/lib/pharmacy";

export default function MedicinesPage() {
  const router = useRouter();
  const [items, setItems] = useState<PharmacyMedicine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const reload = async () => {
    try {
      const r = await pharmacyApi.listMedicines();
      setItems(r.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  };

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    if (session.role() !== "pharmacy") { router.replace("/login?msg=wrong-role"); return; }
    reload();
  }, [router]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((m) =>
      m.name.toLowerCase().includes(q) ||
      m.category.toLowerCase().includes(q),
    );
  }, [items, query]);

  return (
    <>
      <MobileHeader
        title="Medicines"
        subtitle={items ? `${items.length} total · ${items.filter(i => i.is_active).length} active` : undefined}
        right={
          <>
            <NotificationsBell />
            <Link
              href="/medicines/new"
              aria-label="Add medicine"
              className="tap grid h-9 w-9 place-items-center rounded-full bg-brand-500 text-white"
            >
              <Plus size={18} />
            </Link>
          </>
        }
      />

      <div className="px-4 pt-3">
        {items && items.length > 0 && (
          <label className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-white/[0.04]">
            <Search size={14} className="text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Medicine search…"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-slate-400"
            />
          </label>
        )}
        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-2xl border border-rose-300/60 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <p className="flex-1">{error}</p>
            <button onClick={() => setError(null)}><X size={12} /></button>
          </div>
        )}
      </div>

      <div className="px-2 pt-3">
        {!items && !error && (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        )}
        {items && items.length === 0 && (
          <div className="m-4 flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-8 text-center text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.02]">
            <Pill size={22} className="opacity-50" />
            <p>এখনও কোনো ওষুধ যোগ করা হয়নি।</p>
            <Link
              href="/medicines/new"
              className="tap inline-flex items-center gap-1 rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white"
            >
              <Plus size={14} /> Add your first medicine
            </Link>
          </div>
        )}
        {filtered?.map((m) => (
          <MedicineRow key={m.id} m={m} />
        ))}
      </div>
    </>
  );
}

function MedicineRow({ m }: { m: PharmacyMedicine }) {
  const img = m.image_url ? resolveMediaUrl(m.image_url) : "";
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = img && !imgFailed;
  const pending = m.approval_status === "pending";
  const rejected = m.approval_status === "rejected";
  return (
    <Link
      href={`/medicines/${m.id}/edit`}
      className="tap mb-2 flex items-center gap-3 rounded-2xl border border-slate-200/70 bg-white p-2.5 active:bg-slate-100 dark:border-white/10 dark:bg-white/[0.04] dark:active:bg-white/10"
    >
      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-slate-200 dark:bg-white/10">
        {showImg ? (
          <Image src={img} alt="" fill sizes="56px" className="object-cover" onError={() => setImgFailed(true)} />
        ) : (
          <div className="grid h-full w-full place-items-center text-slate-400">
            <Pill size={20} />
          </div>
        )}
        {!m.is_active && (
          <div className="absolute inset-0 grid place-items-center bg-black/55 text-[9px] font-semibold text-white">
            OFF
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <p className="truncate text-sm font-semibold">{m.name}</p>
          {pending && <Sparkles size={11} className="text-amber-500" aria-label="MediAI review pending" />}
          {rejected && <ShieldAlert size={11} className="text-rose-500" aria-label="Rejected by MediAI" />}
        </div>
        <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
          {m.category} · ৳{m.price} · stock {m.stock}
        </p>
        {m.prescription_required && (
          <span className="mt-0.5 inline-block rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] font-semibold text-amber-700 dark:text-amber-300">
            Rx required
          </span>
        )}
      </div>
      <ChevronRight size={16} className="text-slate-400" />
    </Link>
  );
}
