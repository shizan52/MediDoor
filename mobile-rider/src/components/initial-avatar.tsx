"use client";

import Image from "next/image";

const PALETTE = [
  ["from-emerald-400", "to-teal-500"],
  ["from-sky-400", "to-indigo-500"],
  ["from-amber-400", "to-orange-500"],
  ["from-fuchsia-400", "to-pink-500"],
  ["from-rose-400", "to-red-500"],
  ["from-lime-400", "to-emerald-500"],
  ["from-cyan-400", "to-blue-500"],
  ["from-violet-400", "to-purple-500"],
];

function pickGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const [a, b] = PALETTE[Math.abs(h) % PALETTE.length];
  return `${a} ${b}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function InitialAvatar({
  name, src, size = 48, className = "",
}: { name: string; src?: string | null; size?: number; className?: string }) {
  const px = `${size}px`;
  if (src) {
    return (
      <div
        className={`relative shrink-0 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10 ${className}`}
        style={{ width: px, height: px }}
      >
        <Image src={src} alt={name} fill sizes={px} className="object-cover" />
      </div>
    );
  }
  const grad = pickGradient(name || "?");
  const fontSize = Math.max(11, Math.round(size * 0.42));
  return (
    <div
      className={`grid shrink-0 place-items-center rounded-full bg-gradient-to-br text-white font-semibold ${grad} ${className}`}
      style={{ width: px, height: px, fontSize: `${fontSize}px` }}
      aria-label={name}
    >
      {initials(name)}
    </div>
  );
}
