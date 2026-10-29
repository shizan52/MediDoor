"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BottomNav } from "@/components/bottom-nav";

const HIDE_NAV_ROUTES: Array<RegExp> = [
  /^\/login(\/|$)/,
  /^\/auth\//,
  /^\/chats\/[^/]+(\/|$)/,
  /^\/active\/[^/]+(\/|$)/,
  // Full-bleed WhatsApp-style admin thread (fixed header/composer, see
  // messages/page.tsx) — the bottom nav would sit on top of its composer.
  /^\/messages(\/|$)/,
];

export function MobileShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const showNav = !HIDE_NAV_ROUTES.some((r) => r.test(pathname));

  const [vw, setVw] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setVw(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return (
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
  );
}
