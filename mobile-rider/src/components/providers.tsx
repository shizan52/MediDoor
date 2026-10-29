"use client";

import { useEffect, useRef } from "react";
import { ThemeProvider, useTheme } from "next-themes";

/**
 * Colours the Android status bar + navigation bar to match the page instead
 * of leaving them brand-green. In a TWA, Chrome mirrors the live
 * `<meta name="theme-color">` value onto BOTH system bars, so keeping that
 * meta tag in sync with the active theme is what makes the app look native
 * (dark app = dark bars, light app = light bars) rather than showing green
 * slabs above and below the content.
 *
 * These must match the `body` backgrounds in globals.css.
 */
const BAR_COLOR = { light: "#f6f7fb", dark: "#03060a" } as const;

function SystemBarColor() {
  const { resolvedTheme } = useTheme();

  // Our own tag, created once and never handed to React. NEVER remove or
  // mutate a theme-color tag that Next rendered: React still owns that node,
  // and it crashes the whole app on the next client-side navigation with
  // "Cannot read properties of null (reading 'removeChild')". Next no longer
  // emits one (see `viewport` in layout.tsx), so this is the only one.
  const metaRef = useRef<HTMLMetaElement | null>(null);

  useEffect(() => {
    const color = BAR_COLOR[resolvedTheme === "dark" ? "dark" : "light"];
    let meta = metaRef.current;
    if (!meta || !meta.isConnected) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
      metaRef.current = meta;
    }
    meta.content = color;
  }, [resolvedTheme]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
    >
      <SystemBarColor />
      {children}
    </ThemeProvider>
  );
}
