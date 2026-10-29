"use client";

/**
 * Mobile-only navigation helpers (web mobile screens < 640px).
 *
 *  - `HeaderMenu`  — collapses secondary top-bar actions (theme, logout,
 *    profile…) into a single ☰ / avatar dropdown so the toolbar isn't
 *    crammed on a phone (problem G2). Hidden at ≥ sm; the original inline
 *    buttons stay visible on desktop.
 *  - `MobileTabBar` — a fixed bottom tab bar (problem G3) that turns one
 *    endless dashboard scroll into a familiar app-style navigation. Hidden
 *    at ≥ sm.
 *
 * Both are pure presentation — callers wire up their own actions/anchors.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { MoreVertical, Moon, Sun } from "lucide-react";

/* --------------------------------------------------------------------- */
/* Header overflow menu (G2)                                             */
/* --------------------------------------------------------------------- */

export function HeaderMenu({
  children,
  avatarUrl,
  className = "",
}: {
  children: ReactNode;
  /** Optional avatar image for the trigger; falls back to a ☰ icon. */
  avatarUrl?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="আরও অপশন"
        aria-expanded={open}
        className="grid h-10 w-10 place-items-center overflow-hidden rounded-full border border-black/10 bg-white/80 text-slate-700 shadow-sm transition hover:bg-white dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
      >
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt="menu" className="h-full w-full object-cover" />
        ) : (
          <MoreVertical size={18} />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full z-50 mt-2 flex w-52 flex-col gap-1 rounded-2xl border border-black/10 bg-white p-1.5 shadow-2xl dark:border-white/10 dark:bg-[#0f1722]"
            onClick={() => setOpen(false)}
          >
            {children}
          </div>
        </>
      )}
    </div>
  );
}

/** A single row inside `HeaderMenu`. */
export function HeaderMenuItem({
  icon,
  label,
  onClick,
  danger = false,
  disabled = false,
}: {
  icon?: ReactNode;
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition disabled:opacity-50 ${
        danger
          ? "text-rose-600 hover:bg-rose-500/10 dark:text-rose-300"
          : "text-slate-700 hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10"
      }`}
    >
      {icon && <span className="grid h-5 w-5 place-items-center">{icon}</span>}
      <span className="flex-1">{label}</span>
    </button>
  );
}

/** Theme toggle styled as a menu row (for use inside `HeaderMenu`). */
export function ThemeMenuItem() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  const isDark = (theme === "system" ? resolvedTheme : theme) === "dark";
  return (
    <HeaderMenuItem
      icon={isDark ? <Sun size={16} /> : <Moon size={16} />}
      label={isDark ? "Light mode" : "Dark mode"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    />
  );
}

/* --------------------------------------------------------------------- */
/* Bottom tab bar (G3)                                                   */
/* --------------------------------------------------------------------- */

export type MobileTab = {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
  badge?: number;
};

export function MobileTabBar({ tabs }: { tabs: MobileTab[] }) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-black/10 bg-white/95 backdrop-blur-xl shadow-[0_-8px_24px_-12px_rgba(15,23,42,0.25)] dark:border-white/10 dark:bg-[#0b1018]/95 sm:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={t.onClick}
          className={`relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-semibold transition ${
            t.active
              ? "text-brand-600 dark:text-brand-300"
              : "text-slate-500 dark:text-slate-400"
          }`}
        >
          <span className="relative grid place-items-center">
            {t.icon}
            {typeof t.badge === "number" && t.badge > 0 && (
              <span className="absolute -right-2 -top-1.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">
                {t.badge > 9 ? "9+" : t.badge}
              </span>
            )}
          </span>
          {t.label}
        </button>
      ))}
    </nav>
  );
}
