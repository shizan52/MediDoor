"use client";

import { ThemeProvider } from "next-themes";
import { LoginGate } from "@/components/login-gate";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      {children}
      <LoginGate />
    </ThemeProvider>
  );
}
