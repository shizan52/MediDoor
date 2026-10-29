"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Pill, ShoppingBag, MessageCircle, Star, FileText, BadgeCheck } from "lucide-react";
import { resolveMediaUrl } from "@/lib/api";
import { fmtDistance, type StorefrontMedicine } from "@/lib/storefront";

type Props = {
  item: StorefrontMedicine;
  onBuy: () => void;
  onMessage: () => void;
};

export function ProductCard({ item, onBuy, onMessage }: Props) {
  const img = resolveMediaUrl(item.image_url);
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = img && !imgFailed;
  const inStock = item.stock > 0;
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-[22px] border border-slate-200/80 bg-white shadow-sm transition active:scale-[0.99] dark:border-white/10 dark:bg-white/[0.04]">
      <div className="relative aspect-square w-full overflow-hidden bg-gradient-to-br from-slate-50 to-emerald-50/60 dark:from-white/5 dark:to-brand-500/10">
        {showImg ? (
          <Image
            src={img}
            alt={item.name}
            fill
            sizes="(max-width: 480px) 50vw, 240px"
            className="object-cover transition-transform duration-200 group-active:scale-95"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-brand-400">
            <Pill size={28} />
          </div>
        )}
        <span className="absolute right-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-bold text-slate-700 shadow-sm backdrop-blur dark:bg-slate-950/80 dark:text-slate-200">
          {item.category}
        </span>
        {item.prescription_required && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-rose-500/90 px-2 py-0.5 text-[10px] font-semibold text-white">
            <FileText size={10} /> Rx
          </span>
        )}
        {item.distance_km != null && (
          <span className="absolute bottom-2 left-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur">
            {fmtDistance(item.distance_km)}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 px-3 pb-3 pt-2.5">
        <h3 className="line-clamp-2 min-h-[34px] text-[13px] font-bold leading-snug">
          {item.name}
        </h3>
        <p className="flex items-center gap-1 truncate text-[10px] font-medium text-slate-500 dark:text-slate-400">
          {item.pharmacy.is_verified && <BadgeCheck size={11} className="shrink-0 text-brand-500" />}
          <Link
            href={`/store/${item.pharmacy.id}`}
            className="hover:text-brand-600 hover:underline dark:hover:text-brand-400"
            onClick={(e) => e.stopPropagation()}
          >
            {item.pharmacy.name}
          </Link>
        </p>
        <div className="flex items-end justify-between gap-2 pt-1">
          <span className="text-[15px] font-extrabold text-brand-600 dark:text-brand-400">
            ৳{item.price}
          </span>
          <span className="min-w-0 truncate text-[10px] font-semibold text-slate-400">
            {inStock ? `${item.stock} in stock` : "Out of stock"}
          </span>
        </div>
        <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400">
          <span>Delivery ৳{item.delivery_fee}</span>
          {item.pharmacy.rating > 0 && (
            <span className="flex items-center gap-0.5 font-semibold text-amber-500">
              <Star size={10} fill="currentColor" /> {item.pharmacy.rating.toFixed(1)}
            </span>
          )}
        </div>
        <div className="mt-2 grid grid-cols-[1fr_auto] gap-1.5">
          <button
            type="button"
            onClick={onBuy}
            disabled={!inStock}
            className="tap flex h-9 items-center justify-center gap-1 rounded-full bg-brand-500 text-[11px] font-bold text-white shadow-sm shadow-brand-500/20 hover:bg-brand-600 disabled:bg-slate-300 disabled:text-slate-500 disabled:shadow-none dark:disabled:bg-white/10 dark:disabled:text-slate-400"
          >
            <ShoppingBag size={12} /> {inStock ? "Order" : "Sold out"}
          </button>
          <button
            type="button"
            onClick={onMessage}
            aria-label="Message pharmacy"
            className="tap flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5"
          >
            <MessageCircle size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Compact skeleton matching ProductCard footprint — used while loading. */
export function ProductCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-[22px] border border-slate-200/70 bg-white dark:border-white/10 dark:bg-white/[0.04]">
      <div className="skeleton aspect-square w-full" />
      <div className="space-y-2 px-3 pb-3 pt-2.5">
        <div className="skeleton h-3 w-4/5 rounded" />
        <div className="skeleton h-2.5 w-2/3 rounded" />
        <div className="skeleton mt-2 h-9 w-full rounded-full" />
      </div>
    </div>
  );
}
