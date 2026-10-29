"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return <div className="h-9 w-9 rounded-full" aria-hidden />;

  const isDark = (theme === "system" ? resolvedTheme : theme) === "dark";
  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={[
        "tap grid h-9 w-9 place-items-center rounded-full text-slate-700",
        "hover:bg-slate-100 active:bg-slate-200 dark:text-slate-200 dark:hover:bg-white/5",
        className,
      ].join(" ")}
    >
      {isDark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
