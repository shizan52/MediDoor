"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BottomNav } from "@/components/pharmacy-app/bottom-nav";

/**
 * The single visual frame for every /pharmacy screen — 1:1 port of
 * mobile-pharmacy's MobileShell.
 *
 * Layout:
 *   [.app-frame]             ← body stand-in (fixed, fills the browser
 *                              viewport; the mobile app pins <body> itself,
 *                              which a multi-purpose website can't do).
 *     [.app-viewport]        ← clamps width on tablets to 480 px, full
 *                              bleed on phones.
 *        [.app-scroll]       ← the only scrolling element. Padded for the
 *                              fixed top header (handled per-screen) and
 *                              the bottom nav (built-in).
 *     <BottomNav />          ← fixed, sits above the iOS home indicator.
 *
 * Routes that should be edge-to-edge (full-screen chat, order detail,
 * medicine create/edit, profile edit) opt out of the bottom nav by
 * listing themselves in `HIDE_NAV_ROUTES`.
 */
const HIDE_NAV_ROUTES: Array<RegExp> = [
  /^\/pharmacy\/chats\/[^/]+(\/|$)/,        // open conversation = immersive
  /^\/pharmacy\/orders\/[^/]+(\/|$)/,       // order detail = immersive
  /^\/pharmacy\/medicines\/(new|[^/]+\/edit)(\/|$)/, // medicine create/edit
  /^\/pharmacy\/profile\/edit(\/|$)/,       // profile edit form
];

export function PharmacyAppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/pharmacy";
  const showNav = !HIDE_NAV_ROUTES.some((r) => r.test(pathname));

  // Track viewport size purely for a tiny dev hint in the corner — helps
  // when manually checking different camera-cutout sizes during preview.
  const [vw, setVw] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setVw(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return (
    <div className="app-frame">
      <div className="app-viewport">
        <div className="app-scroll" id="app-scroll">
          {children}
          {/* Spacer so the last card never sits flush against the bottom nav */}
          <div aria-hidden style={{ height: showNav ? 24 : 0 }} />
        </div>
        {showNav && <BottomNav />}
        {process.env.NODE_ENV !== "production" && vw != null && (
          <div className="pointer-events-none fixed left-2 top-[calc(var(--safe-top)+4px)] z-[60] rounded-full bg-black/40 px-2 py-0.5 text-[10px] font-mono text-white/90 backdrop-blur">
            {vw}px
          </div>
        )}
      </div>
    </div>
  );
}
