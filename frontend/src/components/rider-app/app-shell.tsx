"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BottomNav } from "@/components/rider-app/bottom-nav";

/**
 * The single visual frame for every /rider screen — 1:1 port of
 * mobile-rider's MobileShell (same .app-frame/.app-viewport/.app-scroll
 * CSS the pharmacy app shell uses; see globals.css).
 *
 * Routes that should be edge-to-edge (full-screen chat) opt out of the
 * bottom nav via `HIDE_NAV_ROUTES`.
 */
const HIDE_NAV_ROUTES: Array<RegExp> = [
  /^\/rider\/chats\/[^/]+(\/|$)/,
  /^\/rider\/active\/[^/]+(\/|$)/,
];

export function RiderAppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/rider";
  const showNav = !HIDE_NAV_ROUTES.some((r) => r.test(pathname));

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
