"use client";

/**
 * Mobile login hero — port of `frontend/src/components/login-hero.tsx`.
 *
 * Differences from the desktop version:
 *  - Reads the same admin-editable `/api/content/login` JSON, so the same
 *    role-aware sections (`default` / `customer`) render here.
 *  - The 3D tilt uses **device gyroscope** (`DeviceOrientationEvent`) when
 *    available so the card feels alive in the user's hand. On iOS we
 *    request permission lazily on first interaction. Touch drag and
 *    pointer hover are kept as fallbacks for desktop preview / Android
 *    browsers without sensor access.
 *  - Card sizing is tuned for the 480 px mobile column. The features grid
 *    drops to a single column on the smallest phones.
 *  - Copy + colors mirror the website so users moving between the two
 *    apps see the same brand DNA — including dark-mode glass surfaces.
 */
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
import { API_URL } from "@/lib/api";

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
type Content = Record<"default" | "customer" | "pharmacy" | "rider", Section>;

export function MobileLoginHero({ activeRole = "customer" as const }: { activeRole?: "default" | "customer" }) {
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/content/login`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: Content) => !cancelled && setContent(data))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const section: Section | undefined = content?.[activeRole] ?? content?.default;

  return (
    <div className="relative w-full">
      <TiltCard>
        <AnimatePresence mode="wait">
          {section ? (
            <motion.div
              key={activeRole}
              initial={{ opacity: 0, y: 16, rotateX: -4 }}
              animate={{ opacity: 1, y: 0, rotateX: 0 }}
              exit={{ opacity: 0, y: -12, rotateX: 4 }}
              transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
              style={{ transformStyle: "preserve-3d" }}
              className="relative"
            >
              {/* Eyebrow pill — mirrors the website's RoleBadge */}
              <div
                style={{ transform: "translateZ(46px)" }}
                className="inline-flex items-center gap-2 rounded-full bg-white/70 px-2.5 py-1 ring-1 ring-black/5 backdrop-blur dark:bg-white/10 dark:ring-white/10"
              >
                <span className="relative grid h-1.5 w-1.5 place-items-center rounded-full bg-brand-500">
                  <span className="absolute inset-0 animate-ping rounded-full bg-brand-500 opacity-60" />
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-brand-700 dark:text-brand-300">
                  {section.eyebrow}
                </span>
              </div>

              {/* Headline */}
              <h2
                style={{ transform: "translateZ(34px)" }}
                className="mt-3 text-[28px] font-extrabold leading-[1.05] tracking-tight"
              >
                {section.title_top}
                <br />
                <span className="bg-gradient-to-r from-brand-400 via-brand-500 to-brand-700 bg-clip-text text-transparent">
                  {section.title_highlight}
                </span>
              </h2>

              {/* Body copy */}
              <p
                style={{ transform: "translateZ(18px)" }}
                className="mt-3 max-w-[34ch] text-[12.5px] leading-relaxed opacity-75"
              >
                {section.body}
              </p>

              {/* Stat pill */}
              <div
                style={{ transform: "translateZ(54px)" }}
                className="mt-4 inline-flex items-baseline gap-2 rounded-2xl bg-gradient-to-br from-brand-500/15 to-brand-700/10 px-3 py-1.5 ring-1 ring-brand-500/30"
              >
                <span className="text-2xl font-extrabold text-brand-600 dark:text-brand-300">
                  {section.stat_value}
                </span>
                <span className="text-[10px] font-medium uppercase tracking-wider opacity-70">
                  {section.stat_label}
                </span>
              </div>

              {/* Feature grid (2 cols on real phones, 1 col on tiny screens) */}
              <ul
                style={{ transform: "translateZ(28px)" }}
                className="mt-5 grid grid-cols-1 gap-2 [@media(min-width:340px)]:grid-cols-2"
              >
                {section.features.slice(0, 4).map((f, i) => {
                  const Icon = ICONS[f.icon] ?? Sparkles;
                  return (
                    <motion.li
                      key={`${activeRole}-${f.title}-${i}`}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.06 + i * 0.05, duration: 0.32 }}
                      className="glass flex items-start gap-2 rounded-2xl p-2.5"
                    >
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-500/15 text-brand-600 dark:text-brand-300">
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[11.5px] font-semibold leading-tight">{f.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-[10.5px] opacity-70">{f.body}</p>
                      </div>
                    </motion.li>
                  );
                })}
              </ul>
            </motion.div>
          ) : error ? (
            <p className="text-xs opacity-60">Could not load content: {error}</p>
          ) : (
            <SkeletonHero />
          )}
        </AnimatePresence>
      </TiltCard>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SkeletonHero() {
  return (
    <div className="animate-pulse">
      <div className="h-5 w-32 rounded-full bg-black/5 dark:bg-white/10" />
      <div className="mt-3 h-9 w-3/4 rounded-xl bg-black/5 dark:bg-white/10" />
      <div className="mt-2 h-9 w-2/3 rounded-xl bg-black/5 dark:bg-white/10" />
      <div className="mt-4 h-12 w-full max-w-[260px] rounded-xl bg-black/5 dark:bg-white/10" />
      <div className="mt-5 grid grid-cols-2 gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-14 rounded-2xl bg-black/5 dark:bg-white/10" />
        ))}
      </div>
    </div>
  );
}

/**
 * Subtle 3D parallax tilt that follows the device gyroscope on phones,
 * with touch-drag and mouse-move fallbacks so the effect also works in
 * VS Code's Simple Browser preview and on Android browsers that don't
 * expose `DeviceOrientationEvent`.
 *
 * iOS Safari requires `requestPermission()` to be called from inside a
 * user gesture — we attach a one-time `pointerdown` listener on the
 * card itself and call it from there. After permission is granted the
 * tilt becomes "free" (no touch needed).
 */
function TiltCard({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const mx = useMotionValue(0); // -0.5 .. +0.5
  const my = useMotionValue(0);

  // Springy rotation. Numbers tuned smaller than the desktop hero so the
  // card never tilts so far it clips the rounded corners on a phone.
  const rotX = useSpring(useTransform(my, [-0.5, 0.5], [5, -5]), {
    stiffness: 120,
    damping: 16,
  });
  const rotY = useSpring(useTransform(mx, [-0.5, 0.5], [-7, 7]), {
    stiffness: 120,
    damping: 16,
  });

  // Gyroscope wiring ---------------------------------------------------------
  useEffect(() => {
    let attached = false;
    let mounted = true;

    function onOrient(e: DeviceOrientationEvent) {
      if (!mounted) return;
      // gamma = left/right tilt (-90..+90), beta = front/back (-180..+180).
      // Map to -0.5..+0.5 with a soft cap so extreme angles don't break.
      const g = clamp((e.gamma ?? 0) / 45, -1, 1) * 0.5;
      const b = clamp(((e.beta ?? 0) - 30) / 45, -1, 1) * 0.5;
      mx.set(g);
      my.set(b);
    }

    function attach() {
      if (attached) return;
      attached = true;
      window.addEventListener("deviceorientation", onOrient, { passive: true });
    }

    type DOEPerm = typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    const DOE = (typeof window !== "undefined" ? (window.DeviceOrientationEvent as DOEPerm) : null);
    if (!DOE) return;

    if (typeof DOE.requestPermission === "function") {
      // iOS 13+ — wait for a user gesture before asking.
      const askOnce = () => {
        DOE.requestPermission!()
          .then((r) => r === "granted" && attach())
          .catch(() => { /* user denied — fall back to touch/mouse */ });
        ref.current?.removeEventListener("pointerdown", askOnce);
      };
      ref.current?.addEventListener("pointerdown", askOnce, { once: true });
    } else {
      // Android / desktop — attach immediately.
      attach();
    }

    return () => {
      mounted = false;
      window.removeEventListener("deviceorientation", onOrient);
    };
  }, [mx, my]);

  // Touch / mouse fallback (also lets the user "pin" a tilt by pointing). ----
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
        const t = e.touches[0];
        if (t) setFromPointer(t.clientX, t.clientY);
      }}
      onMouseLeave={() => {
        mx.set(0);
        my.set(0);
      }}
      onTouchEnd={() => {
        // Don't snap back if gyroscope is driving — the orientation handler
        // will overwrite on the next tick. Snapping anyway feels jittery,
        // so we just decay to half toward zero and let the spring resolve.
        mx.set((mx.get() ?? 0) * 0.4);
        my.set((my.get() ?? 0) * 0.4);
      }}
      style={{ perspective: 1200 }}
      className="relative"
    >
      {/* Glow halo behind the card — same recipe as the website hero */}
      <div className="pointer-events-none absolute -inset-6 -z-10 bg-[radial-gradient(circle_at_30%_20%,rgba(6,173,101,0.18),transparent_60%)]" />
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
