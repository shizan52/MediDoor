"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  BadgeCheck,
  Boxes,
  MapPin,
  MessageCircle,
  Phone,
  Star,
  Pill,
  Search,
  Store,
} from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { MessengerDock } from "@/components/messenger-dock";
import { MobileTabBar } from "@/components/mobile-nav";
import {
  Home as HomeIcon,
  Receipt,
  ScanLine,
  User as UserIcon,
} from "lucide-react";
import {
  fetchPharmacy,
  userLocation,
  requestPharmacyChat,
  buyPrefill,
  inquiryPrefill,
  type PharmacyDetail,
  type StorefrontMedicine,
} from "@/lib/storefront";
import { resolveMediaUrl } from "@/lib/api";

export default function StorefrontPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const [data, setData] = useState<PharmacyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const loc = userLocation.load();
    fetchPharmacy(id, { lat: loc?.lat, lng: loc?.lng })
      .then((d) => {
        setData(d);
        setActiveCategory(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, [id]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-brand-50 via-white to-brand-100 dark:from-[#070b12] dark:via-[#0b1018] dark:to-[#091622]">
      <header className="sticky top-0 z-30 border-b border-black/5 dark:border-white/10 bg-white/85 dark:bg-[#0b1018]/85 backdrop-blur">
        <div className="flex w-full items-center gap-3 px-6 py-3 lg:px-10">
          <Link href="/" className="shrink-0">
            <BrandLogo className="h-12 w-auto" />
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1 rounded-full glass px-3 py-1.5 text-xs font-medium hover:scale-105 transition"
          >
            <ArrowLeft size={12} /> Back
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
          </div>
        </div>
      </header>

      <section className="w-full px-6 pt-6 pb-28 lg:px-10 sm:pb-16">
        {error && (
          <p className="mb-4 rounded-xl border border-red-300/50 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}

        {!data ? (
          <div className="h-72 animate-pulse rounded-3xl bg-black/5 dark:bg-white/5" />
        ) : (
          <>
            {/* Pharmacy banner */}
            <div className="overflow-hidden rounded-[1.75rem] border border-black/5 bg-white/80 shadow-2xl shadow-brand-900/10 backdrop-blur dark:border-white/10 dark:bg-white/5">
              <div className="relative h-44 w-full bg-gradient-to-r from-brand-300 to-brand-600 sm:h-56">
                {data.pharmacy.banner_photo_url && (
                  <Image
                    src={resolveMediaUrl(data.pharmacy.banner_photo_url)}
                    alt="banner"
                    fill
                    className="object-cover"
                    sizes="100vw"
                    unoptimized
                  />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-transparent" />
                <div className="absolute bottom-4 left-6 right-6 flex flex-wrap items-end justify-between gap-3 text-white">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="grid h-9 w-9 place-items-center rounded-2xl bg-white/15 backdrop-blur">
                        <Store size={17} />
                      </span>
                      <h1 className="text-2xl font-extrabold drop-shadow md:text-3xl">
                        {data.pharmacy.name}
                      </h1>
                      {data.pharmacy.is_verified ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/90 px-2 py-0.5 text-xs font-semibold">
                          <BadgeCheck size={12} /> Verified
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/90 px-2 py-0.5 text-xs font-semibold">
                          Pending
                        </span>
                      )}
                    </div>
                    <p className="mt-1 max-w-2xl text-sm opacity-90">{data.pharmacy.business_name}</p>
                    <button
                      type="button"
                      onClick={() =>
                        requestPharmacyChat({ pharmacy_id: data.pharmacy.id })
                      }
                      className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/95 px-4 py-1.5 text-xs font-semibold text-brand-700 shadow hover:bg-white"
                    >
                      <MessageCircle size={13} /> Chat with pharmacy
                    </button>
                  </div>
                  <div className="rounded-2xl bg-white/15 px-3 py-2 text-xs shadow-lg backdrop-blur">
                    <div className="flex items-center gap-1">
                      <Star size={12} className="fill-amber-300 text-amber-300" />
                      <span className="font-semibold">
                        {data.pharmacy.rating.toFixed(1)}
                      </span>
                      <span className="opacity-80">({data.pharmacy.rating_count})</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="grid gap-2 p-5 text-sm sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_auto]">
                {data.pharmacy.address && (
                  <Info Icon={MapPin} text={data.pharmacy.address} />
                )}
                {data.pharmacy.phone_number && (
                  <Info Icon={Phone} text={data.pharmacy.phone_number} />
                )}
                <Info
                  Icon={Pill}
                  text={`${data.total_medicines} medicines · delivery ৳${data.pharmacy.delivery_fee.toFixed(0)}`}
                />
                <button
                  type="button"
                  onClick={() => requestPharmacyChat({ pharmacy_id: data.pharmacy.id })}
                  className="inline-flex items-center gap-2 rounded-full bg-brand-500 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-600"
                >
                  <MessageCircle size={14} /> Chat with pharmacy
                </button>
              </div>
            </div>

            {/* Category tabs */}
            {data.categories.length > 0 && (
              <div className="mt-6 rounded-3xl border border-black/5 bg-white/75 p-3 shadow-xl shadow-brand-900/5 backdrop-blur dark:border-white/10 dark:bg-white/5">
                <div className="mb-3 flex items-center justify-between gap-3 px-1">
                  <div className="flex items-center gap-2 text-sm font-bold">
                    <Boxes size={16} className="text-brand-600 dark:text-brand-300" />
                    Categories
                  </div>
                  <div className="hidden items-center gap-1.5 rounded-full bg-black/5 px-3 py-1 text-[11px] font-medium opacity-70 dark:bg-white/10 sm:flex">
                    <Search size={12} /> {data.total_medicines} products
                  </div>
                </div>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  <button
                    onClick={() => setActiveCategory(null)}
                    className={`shrink-0 whitespace-nowrap rounded-full border px-4 py-2 text-xs font-bold shadow-sm transition ${
                      activeCategory === null
                        ? "border-brand-500 bg-brand-500 text-white shadow-lg shadow-brand-500/25"
                        : "border-black/10 bg-white/80 hover:border-brand-300 hover:bg-brand-50 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
                    }`}
                  >
                    All categories · {data.total_medicines}
                  </button>
                  {data.categories.map((c) => (
                  <button
                    key={c.name}
                    onClick={() => setActiveCategory(c.name)}
                    title={c.short_description ?? undefined}
                    className={`shrink-0 whitespace-nowrap rounded-full border px-4 py-2 text-xs font-bold shadow-sm transition ${
                      activeCategory === c.name
                        ? "border-brand-500 bg-brand-500 text-white shadow-lg shadow-brand-500/25"
                        : "border-black/10 bg-white/80 hover:border-brand-300 hover:bg-brand-50 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
                    }`}
                  >
                    {c.name} · {c.items.length}
                  </button>
                  ))}
                </div>
              </div>
            )}

            {/* Active category description */}
            {(() => {
              const ac = data.categories.find((c) => c.name === activeCategory);
              return ac?.short_description ? (
                <p className="mt-3 rounded-2xl border border-brand-500/15 bg-brand-500/10 px-4 py-2 text-xs font-medium text-brand-800 dark:text-brand-200">{ac.short_description}</p>
              ) : null;
            })()}

            {/* Active category items */}
            <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
              {(activeCategory === null
                ? Array.from(new Map(data.categories.flatMap((c) => c.items).map((m) => [m.id, m])).values())
                : data.categories.find((c) => c.name === activeCategory)?.items ?? []
              ).map((m) => (
                <StoreCard key={m.id} m={m} />
              ))}
            </div>
          </>
        )}
      </section>

      <MessengerDock />

      {/* App-parity bottom nav (self-hidden ≥sm). */}
      <MobileTabBar
        tabs={[
          { key: "home", label: "হোম", icon: <HomeIcon size={20} />, onClick: () => router.push("/") },
          { key: "chats", label: "চ্যাট", icon: <MessageCircle size={20} />, onClick: () => router.push("/customer/chats") },
          { key: "rx", label: "Rx স্ক্যান", icon: <ScanLine size={20} />, onClick: () => router.push("/") },
          { key: "orders", label: "অর্ডার", icon: <Receipt size={20} />, onClick: () => router.push("/customer/orders") },
          { key: "profile", label: "প্রোফাইল", icon: <UserIcon size={20} />, onClick: () => router.push("/customer/profile") },
        ]}
      />
    </main>
  );
}

function Info({
  Icon,
  text,
}: {
  Icon: React.ComponentType<{ size?: number | string; className?: string }>;
  text: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-black/5 bg-white/70 px-3 py-2 shadow-sm dark:border-white/10 dark:bg-white/5">
      <Icon size={14} className="shrink-0 text-brand-600 dark:text-brand-300" />
      <span className="line-clamp-1">{text}</span>
    </div>
  );
}

function StoreCard({ m }: { m: StorefrontMedicine }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => requestPharmacyChat({ pharmacy_id: m.pharmacy.id })}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          requestPharmacyChat({ pharmacy_id: m.pharmacy.id });
        }
      }}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-black/5 bg-white/90 shadow-md shadow-slate-900/5 transition duration-200 hover:-translate-y-1 hover:border-brand-500/30 hover:shadow-2xl hover:shadow-brand-500/15 dark:border-white/10 dark:bg-white/5"
    >
      <div className="relative aspect-square w-full overflow-hidden bg-gradient-to-br from-brand-50 to-slate-100 dark:from-white/10 dark:to-white/5">
        {m.image_url ? (
          <Image
            src={resolveMediaUrl(m.image_url)}
            alt={m.name}
            fill
            className="object-cover transition duration-300 group-hover:scale-105"
            sizes="(max-width:640px) 50vw, 25vw"
            unoptimized
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-brand-500">
            <Pill size={32} />
          </div>
        )}
        {m.prescription_required && (
          <span
            className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-rose-600/95 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow"
            title="এই ঔষধ order করতে prescription upload করতে হবে"
          >
            📋 Rx
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-3">
        <p className="line-clamp-1 text-sm font-semibold">{m.name}</p>
        {m.short_description && (
          <p className="mt-0.5 line-clamp-2 text-xs opacity-70">{m.short_description}</p>
        )}
        <div className="mt-auto flex items-center justify-between gap-2 pt-3">
          <p className="text-base font-bold">৳ {m.price.toFixed(0)}</p>
          <div className="flex items-center gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                requestPharmacyChat({
                  pharmacy_id: m.pharmacy.id,
                  prefill: inquiryPrefill(m.name),
                });
              }}
              className="inline-flex items-center justify-center rounded-full border border-brand-500/40 bg-brand-500/10 p-1.5 text-brand-700 hover:bg-brand-500/20 transition dark:text-brand-300"
              aria-label="Message pharmacy about this medicine"
              title="Message pharmacy"
            >
              <MessageCircle size={13} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                requestPharmacyChat({
                  pharmacy_id: m.pharmacy.id,
                  prefill: buyPrefill(m.name, m.price),
                });
              }}
              className="rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 transition"
            >
              Buy
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
