"use client";

/**
 * Rider profile (read-only). Shows account + verification + NID details
 * and a Logout button. Editing/re-uploading NID lives on the website
 * (linked via "Edit on web" button).
 */
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  BadgeCheck, Bike, Calendar, Camera, ExternalLink, IdCard, Loader2, LogOut, Mail, Phone, ShieldCheck, User,
} from "lucide-react";
import { api, session, WEBSITE_URL, type Role, resolveMediaUrl, uploadImage } from "@/lib/api";
import { MobileHeader } from "@/components/mobile-header";
import { ThemeToggle } from "@/components/theme-toggle";

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

export default function ProfilePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);

  // Upload a new profile photo and persist it via the rider self-PATCH.
  const onPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const url = await uploadImage(file);
      const updated = await api<Me>("/api/auth/me/rider", {
        method: "PATCH",
        body: JSON.stringify({ profile_photo_url: url }),
      });
      setMe(updated);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : "Upload failed");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  useEffect(() => {
    if (!session.access()) { router.replace("/login"); return; }
    api<Me>("/api/auth/me")
      .then((d) => {
        if (d.role !== "rider") { router.replace("/login?msg=wrong-role"); return; }
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
  const photo = resolveMediaUrl(p.profile_photo_url || "") || null;

  return (
    <>
      <MobileHeader title="My profile" right={<ThemeToggle />} />

      {/* `.app-scroll` already reserves `header-h + safe-top` for the fixed
          MobileHeader above — only the extra breathing room belongs here. */}
      <main className="px-4 pb-6 pt-2">
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
              <button
                type="button"
                onClick={() => photoRef.current?.click()}
                disabled={uploading}
                aria-label="Change profile photo"
                className="tap relative h-20 w-20 shrink-0 rounded-full"
              >
                <span className="relative block h-full w-full overflow-hidden rounded-full border-4 border-white bg-white shadow-md dark:border-[#0b1018]">
                  {photo ? (
                    <Image src={photo} alt="me" fill sizes="80px" className="object-cover" />
                  ) : (
                    <span className="grid h-full w-full place-items-center bg-brand-100 text-brand-700">
                      <User size={26} />
                    </span>
                  )}
                </span>
                <span className="absolute -bottom-0.5 -right-0.5 grid h-7 w-7 place-items-center rounded-full bg-brand-500 text-white shadow-md ring-2 ring-white dark:ring-[#0b1018]">
                  {uploading ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />}
                </span>
                <input
                  ref={photoRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPhoto}
                />
              </button>
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
          <a
            href={`${WEBSITE_URL}/rider/profile`}
            className="tap inline-flex items-center justify-center gap-1.5 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-xs font-semibold text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
          >
            <ExternalLink size={12} /> Edit profile / NID on website
          </a>

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
