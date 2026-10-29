"use client";

/**
 * Viewport-based UI switcher for the pharmacy / rider sections.
 *
 * Big screens (≥1024px — laptop/desktop) get the full desktop dashboard;
 * anything smaller gets the app-parity mobile view (the 1:1 port of the
 * mobile-pharmacy / mobile-rider PWA inside the phone shell).
 *
 * We render null until the first client-side measurement so the server
 * markup never mismatches, then live-switch on window resize via
 * matchMedia — dragging a window across the breakpoint swaps the UI
 * without a reload. Only ONE branch is mounted at a time, so the two
 * UIs never double-poll the API.
 */
import { useEffect, useState, type ReactNode } from "react";

const DESKTOP_QUERY = "(min-width: 1024px)";

export function useIsDesktop(): boolean | null {
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isDesktop;
}

export function ResponsiveView({ desktop, mobile }: { desktop: ReactNode; mobile: ReactNode }) {
  const isDesktop = useIsDesktop();
  if (isDesktop === null) return null;
  return <>{isDesktop ? desktop : mobile}</>;
}
