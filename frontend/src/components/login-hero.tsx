"use client";

import { motion, AnimatePresence, useMotionValue, useSpring, useTransform } from "framer-motion";
import {
  MapPin,
  ShieldCheck,
  Sparkles,
  Truck,
  Pill,
  Wallet,
  Store,
  ClipboardList,
  TrendingUp,
  Bike,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { API_URL, type Role } from "@/lib/api";

const ICONS: Record<string, LucideIcon> = {
  MapPin,
  ShieldCheck,
  Sparkles,
  Truck,
  Pill,
  Wallet,
  Store,
  ClipboardList,
  TrendingUp,
  Bike,
};

type Feature = { icon: string; title: string; body: string };
type Section = {
  eyebrow: string;
  title_top: string;
  title_highlight: string;
  body: string;
  stat_value: string;
  stat_label: string;
  features: Feature[];
};
type Content = Record<"default" | Role, Section>;

/**
 * Left pane of the login screen.
 * - Reads content from the backend (editable via admin.py).
 * - When the user has selected a role on the right, the content swaps
 *   to that role's pitch (animated). With no selection it shows the
 *   generic platform pitch.
 * - The whole stack lives on a CSS-3D card that tilts with gyroscope,
 *   touch drag, or cursor movement depending on device support.
 */
export function LoginHero({ activeRole }: { activeRole: Role | null }) {
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/content/login`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: Content) => {
        if (!cancelled) setContent(data);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const key: keyof Content = activeRole ?? "default";
  const section: Section | undefined = content?.[key];

  return (
    <div className="relative h-full w-full">
      <TiltCard>
        <AnimatePresence mode="wait">
          {section ? (
            <motion.div
              key={key}
              initial={{ opacity: 0, y: 20, rotateX: -6 }}
              animate={{ opacity: 1, y: 0, rotateX: 0 }}
              exit={{ opacity: 0, y: -16, rotateX: 6 }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              style={{ transformStyle: "preserve-3d" }}
              className="relative"
            >
              <RoleBadge role={activeRole} eyebrow={section.eyebrow} />

              <h2
                style={{ transform: "translateZ(40px)" }}
                className="mt-4 text-[2rem] font-extrabold leading-[1.05] tracking-tight sm:text-4xl lg:mt-5 lg:text-5xl"
              >
                {section.title_top}
                <br />
                <span className="bg-gradient-to-r from-brand-400 via-brand-500 to-brand-700 bg-clip-text text-transparent">
                  {section.title_highlight}
                </span>
              </h2>

              <p
                style={{ transform: "translateZ(20px)" }}
                className="mt-4 max-w-md text-sm leading-relaxed opacity-75 sm:text-base lg:mt-5"
              >
                {section.body}
              </p>

              <div
                style={{ transform: "translateZ(60px)" }}
                className="mt-5 inline-flex items-baseline gap-2 rounded-2xl bg-gradient-to-br from-brand-500/15 to-brand-700/10 px-3 py-1.5 ring-1 ring-brand-500/30 lg:mt-7 lg:px-4 lg:py-2"
              >
                <span className="text-2xl font-extrabold text-brand-600 dark:text-brand-300 lg:text-3xl">
                  {section.stat_value}
                </span>
                <span className="text-xs font-medium uppercase tracking-wider opacity-70">
                  {section.stat_label}
                </span>
              </div>

              <ul
                style={{ transform: "translateZ(30px)" }}
                className="mt-5 grid max-w-lg grid-cols-1 gap-2 [@media(min-width:420px)]:grid-cols-2 lg:mt-8 lg:gap-3"
              >
                {section.features.map((f, i) => {
                  const Icon = ICONS[f.icon] ?? Sparkles;
                  return (
                    <motion.li
                      key={`${key}-${f.title}-${i}`}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.08 + i * 0.06, duration: 0.35 }}
                      className="group glass flex items-start gap-2 rounded-2xl p-3 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-brand-900/10 lg:gap-3 lg:p-4"
                    >
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand-500/15 text-brand-600 transition group-hover:scale-110 dark:text-brand-300 lg:h-9 lg:w-9">
                        <Icon className="h-4 w-4 lg:h-5 lg:w-5" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold leading-tight lg:text-sm">{f.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-[11px] opacity-70 lg:text-xs">{f.body}</p>
                      </div>
                    </motion.li>
                  );
                })}
              </ul>
            </motion.div>
          ) : error ? (
            <p className="text-sm opacity-60">Could not load content: {error}</p>
          ) : (
            <SkeletonHero />
          )}
        </AnimatePresence>
      </TiltCard>
    </div>
  );
}

// ---------------------------------------------------------------------------

function RoleBadge({ role, eyebrow }: { role: Role | null; eyebrow: string }) {
  const dot =
    role === "customer"
      ? "bg-brand-500"
      : role === "pharmacy"
      ? "bg-amber-500"
      : role === "rider"
      ? "bg-sky-500"
      : "bg-brand-400";
  return (
    <div
      style={{ transform: "translateZ(50px)" }}
      className="inline-flex items-center gap-2 rounded-full bg-white/60 dark:bg-white/5 px-3 py-1 ring-1 ring-black/5 dark:ring-white/10"
    >
      <span className={`relative grid h-2 w-2 place-items-center rounded-full ${dot}`}>
        <span className={`absolute inset-0 animate-ping rounded-full ${dot} opacity-60`} />
      </span>
      <span className="text-xs font-semibold tracking-wider uppercase text-brand-700 dark:text-brand-300">
        {eyebrow}
      </span>
    </div>
  );
}

function SkeletonHero() {
  return (
    <div className="animate-pulse">
      <div className="h-6 w-40 rounded-full bg-black/5 dark:bg-white/10" />
      <div className="mt-5 h-12 w-3/4 rounded-xl bg-black/5 dark:bg-white/10" />
      <div className="mt-3 h-12 w-2/3 rounded-xl bg-black/5 dark:bg-white/10" />
      <div className="mt-6 h-16 w-full max-w-md rounded-xl bg-black/5 dark:bg-white/10" />
      <div className="mt-8 grid grid-cols-2 gap-3 max-w-lg">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 rounded-2xl bg-black/5 dark:bg-white/10" />
        ))}
      </div>
    </div>
  );
}

/**
 * Subtle 3D parallax tilt that follows the device gyroscope on phones,
 * with touch-drag and mouse-move fallbacks.
 * Wraps the whole left-pane content in a perspective container so the
 * `translateZ` offsets above produce a real depth effect.
 */
function TiltCard({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rotX = useSpring(useTransform(my, [-0.5, 0.5], [6, -6]), { stiffness: 120, damping: 18 });
  const rotY = useSpring(useTransform(mx, [-0.5, 0.5], [-8, 8]), { stiffness: 120, damping: 18 });

  useEffect(() => {
    let attached = false;
    let mounted = true;

    function onOrient(e: DeviceOrientationEvent) {
      if (!mounted) return;
      const gamma = clamp((e.gamma ?? 0) / 45, -1, 1) * 0.5;
      const beta = clamp(((e.beta ?? 0) - 30) / 45, -1, 1) * 0.5;
      mx.set(gamma);
      my.set(beta);
    }

    function attach() {
      if (attached) return;
      attached = true;
      window.addEventListener("deviceorientation", onOrient, { passive: true });
    }

    type DeviceOrientationWithPermission = typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    const orientationEvent =
      typeof window !== "undefined"
        ? (window.DeviceOrientationEvent as DeviceOrientationWithPermission | undefined)
        : undefined;
    if (!orientationEvent) return;

    if (typeof orientationEvent.requestPermission === "function") {
      const askOnce = () => {
        orientationEvent
          .requestPermission!()
          .then((result) => {
            if (result === "granted") attach();
          })
          .catch(() => {});
        ref.current?.removeEventListener("pointerdown", askOnce);
      };
      ref.current?.addEventListener("pointerdown", askOnce, { once: true });
    } else {
      attach();
    }

    return () => {
      mounted = false;
      window.removeEventListener("deviceorientation", onOrient);
    };
  }, [mx, my]);

  function setFromPointer(clientX: number, clientY: number) {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    mx.set(clamp((clientX - r.left) / r.width - 0.5, -0.5, 0.5));
    my.set(clamp((clientY - r.top) / r.height - 0.5, -0.5, 0.5));
  }

  return (
    <div
      ref={ref}
      onMouseMove={(e) => setFromPointer(e.clientX, e.clientY)}
      onTouchMove={(e) => {
        const touch = e.touches[0];
        if (touch) setFromPointer(touch.clientX, touch.clientY);
      }}
      onMouseLeave={() => {
        mx.set(0);
        my.set(0);
      }}
      onTouchEnd={() => {
        mx.set((mx.get() ?? 0) * 0.4);
        my.set((my.get() ?? 0) * 0.4);
      }}
      style={{ perspective: 1400 }}
      className="relative"
    >
      {/* Glow halo behind the card */}
      <div className="pointer-events-none absolute -inset-10 -z-10 bg-[radial-gradient(circle_at_30%_20%,rgba(6,173,101,0.18),transparent_60%)]" />
      <motion.div
        style={{ rotateX: rotX, rotateY: rotY, transformStyle: "preserve-3d" }}
        className="relative"
      >
        {children}
      </motion.div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
