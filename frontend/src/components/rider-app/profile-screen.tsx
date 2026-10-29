"use client";

/**
 * Rider profile (read-only) — 1:1 port of mobile-rider/src/app/profile/page.tsx.
 * Shows account + verification + NID details and a Logout button.
 * Editing/re-uploading NID lives on the rider registration flow
 * (linked via the edit button, same as the app).
 */
import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BadgeCheck, Bike, Calendar, ExternalLink, IdCard, LogOut, Mail, Phone, ShieldCheck,
} from "lucide-react";
import { api, session, type Role, resolveMediaUrl } from "@/lib/api";
import { MobileHeader } from "@/components/rider-app/mobile-header";
import { ProfilePhotoEditor } from "@/components/profile-photo-editor";
import { ThemeToggle } from "@/components/rider-app/theme-toggle";

type RiderProfile = {
  full_name?: string;
  nick_name?: string | null;
  phone_number?: string;
  age?: number;
  nid_number?: string;
  nid_front_url?: string | null;
  nid_back_url?: string | null;
  profile_photo_url?: string | null;
  is_verified?: boolean;
};
type Me = {
  account_id: string;
  gmail: string;
  role: Role;
  is_registered: boolean;
  profile?: RiderProfile | null;
};

export function RiderProfileScreen() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    api<Me>("/api/auth/me")
      .then((d) => {
        if (d.role !== "rider") { router.replace("/"); return; }
        setMe(d);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
  }, [router]);

  const onLogout = async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    session.clear();
    router.replace("/login");
  };

  const p = me?.profile ?? {};
  const verified = !!p.is_verified;

  // Persist a new (or removed) profile photo, then refresh local state.
  const onSavePhoto = async (url: string | null) => {
    const updated = await api<Me>("/api/auth/me/rider", {
      method: "PATCH",
      body: JSON.stringify({ profile_photo_url: url }),
    });
    setMe(updated);
  };

  return (
    <>
      <MobileHeader title="My profile" right={<ThemeToggle />} />

      <main
        className="px-4 pb-6"
        style={{ paddingTop: "calc(var(--header-h) + var(--safe-top) + 8px)" }}
      >
        {error && (
          <p className="mb-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">
            {error}
          </p>
        )}

        {/* Banner + avatar */}
        <div className="overflow-hidden rounded-3xl border border-slate-200/60 bg-white shadow-sm dark:border-white/10 dark:bg-white/[0.03]">
          <div className="h-20 bg-gradient-to-r from-brand-400 to-brand-700" />
          <div className="-mt-10 px-4 pb-4">
            <div className="flex items-end gap-3">
              <ProfilePhotoEditor
                photoUrl={p.profile_photo_url}
                displayName={p.nick_name || p.full_name || "Rider"}
                onSave={onSavePhoto}
                className="h-20 w-20"
                ringClassName="border-4 border-white bg-white shadow-md dark:border-[#0b1018]"
                fallbackClassName="bg-brand-100 text-brand-700"
              />
              <div className="min-w-0 flex-1 pb-1">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-lg font-extrabold leading-tight">
                    {p.nick_name || p.full_name || "Rider"}
                  </h1>
                  {verified ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-white">
                      <BadgeCheck size={9} /> Verified
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500 px-1.5 py-0.5 text-[9px] font-bold text-white">
                      Pending
                    </span>
                  )}
                </div>
                {p.full_name && p.nick_name && p.full_name !== p.nick_name && (
                  <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">{p.full_name}</p>
                )}
                <p className="text-[11px] text-slate-500 dark:text-slate-400">MediDoor rider</p>
              </div>
            </div>

            <div className="mt-4 grid gap-2">
              <Row Icon={Mail}     label="Email" value={me?.gmail} />
              <Row Icon={Phone}    label="Phone" value={p.phone_number} />
              <Row Icon={Calendar} label="Age"   value={p.age != null ? String(p.age) : null} />
              <Row Icon={IdCard}   label="NID"   value={p.nid_number} />
              <Row Icon={Bike}     label="Role"  value="Rider" />
              <Row
                Icon={ShieldCheck}
                label="Status"
                value={verified ? "Verified rider" : "Pending verification"}
              />
            </div>

            {(p.nid_front_url || p.nid_back_url) && (
              <div className="mt-4">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">NID photos</p>
                <div className="grid grid-cols-2 gap-2">
                  {p.nid_front_url && (
                    <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-slate-100 dark:bg-white/5">
                      <Image
                        src={resolveMediaUrl(p.nid_front_url)}
                        alt="NID front"
                        fill
                        sizes="160px"
                        className="object-cover"
                        unoptimized
                      />
                    </div>
                  )}
                  {p.nid_back_url && (
                    <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-slate-100 dark:bg-white/5">
                      <Image
                        src={resolveMediaUrl(p.nid_back_url)}
                        alt="NID back"
                        fill
                        sizes="160px"
                        className="object-cover"
                        unoptimized
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="mt-4 grid gap-2">
          <Link
            href="/register/rider"
            className="tap inline-flex items-center justify-center gap-1.5 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-xs font-semibold text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
          >
            <ExternalLink size={12} /> Edit profile / NID
          </Link>

          <button
            onClick={onLogout}
            className="tap inline-flex items-center justify-center gap-1.5 rounded-2xl bg-rose-500 px-3 py-3 text-xs font-bold text-white shadow-md shadow-rose-500/20"
          >
            <LogOut size={12} /> Logout
          </button>
        </div>
      </main>
    </>
  );
}

function Row({
  Icon, label, value,
}: { Icon: React.ComponentType<{ size?: number | string }>; label: string; value?: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200/60 bg-slate-50/70 px-3 py-2 dark:border-white/10 dark:bg-white/[0.02]">
      <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
        <Icon size={12} /> {label}
      </span>
      <span className="max-w-[60%] truncate text-[12px] font-semibold">{value || "—"}</span>
    </div>
  );
}
