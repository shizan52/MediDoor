"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { LoginCard } from "@/components/login-card";
import { LoginHero } from "@/components/login-hero";
import { MediAIChat } from "@/components/medi-ai-chat";
import type { Role } from "@/lib/api";

export function LoginScreen() {
  const params = useSearchParams();
  const error = params.get("error");
  const msg = params.get("msg");
  // Backend bounces a role-mismatch sign-in back here with ?error=role_mismatch
  // &have=<real role>&want=<role the user clicked>.
  const haveParam = params.get("have");
  const wantParam = params.get("want");
  // Pre-select the role from the URL (?role=customer|pharmacy|rider) so a link
  // like /login?role=customer lands with Customer already chosen instead of
  // forcing the user to pick again. On a role-mismatch bounce we instead
  // pre-select the user's REAL (registered) role so they can retry in one tap.
  const roleParam = params.get("role");
  const isRole = (v: string | null): v is Role =>
    v === "customer" || v === "pharmacy" || v === "rider";
  const initialRole: Role | null =
    error === "role_mismatch" && isRole(haveParam)
      ? haveParam
      : isRole(roleParam)
      ? roleParam
      : null;
  const [role, setRole] = useState<Role | null>(initialRole);

  // Stash ?next= so the OAuth callback (which strips query) can still find it.
  if (typeof window !== "undefined") {
    const next = params.get("next");
    if (next && next.startsWith("/")) {
      try { window.sessionStorage.setItem("medidoor_post_login_next", next); } catch { /* ignore */ }
    }
  }

  const roleLabel = (r: string | null) =>
    r === "customer" ? "Customer" : r === "pharmacy" ? "Pharmacy" : r === "rider" ? "Rider" : "";

  const friendlyMsg =
    error === "role_mismatch"
      ? `এই Gmail-টি ইতিমধ্যে ${roleLabel(haveParam)} হিসেবে registered। ${
          roleLabel(wantParam) || "অন্য role"
        } হিসেবে ঢোকা যাবে না — একটি Gmail-এ একটাই role থাকে। নিচে ${roleLabel(
          haveParam,
        )} নির্বাচন করে আবার চেষ্টা করুন, অথবা ${
          roleLabel(wantParam) || "নতুন role"
        }-এর জন্য আলাদা Gmail ব্যবহার করুন।`
      : msg === "customer-only"
      ? "এই কাজের জন্য একটি customer account লাগবে। একটি আলাদা Gmail দিয়ে customer হিসেবে sign-in করুন।"
      : null;

  return (
    <main className="relative min-h-screen overflow-hidden bg-gradient-to-br from-brand-50 via-white to-brand-100 dark:from-[#070b12] dark:via-[#0b1018] dark:to-[#091622]">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-brand-300/40 blur-3xl animate-blob" />
        <div className="absolute top-1/3 -right-40 h-[28rem] w-[28rem] rounded-full bg-brand-500/30 blur-3xl animate-blob [animation-delay:-4s]" />
        <div className="absolute bottom-0 left-1/3 h-80 w-80 rounded-full bg-brand-200/40 blur-3xl animate-blob [animation-delay:-8s]" />
      </div>

      <header className="relative z-20 flex items-center justify-between px-6 py-5 lg:px-10">
        <BrandLogo className="h-16 w-auto md:h-20" />
        <ThemeToggle />
      </header>

      <section className="relative z-10 grid min-h-[calc(100vh-7rem)] grid-cols-1 items-center gap-6 px-4 pb-12 sm:px-6 lg:grid-cols-[1.15fr_1fr] lg:gap-10 lg:px-12">
        <div className="relative mx-auto w-full max-w-xl lg:max-w-none">
          <LoginHero activeRole={role} />
        </div>
        <div className="flex items-center justify-center">
          <LoginCard
            initialError={error === "role_mismatch" ? null : error}
            initialNotice={friendlyMsg}
            role={role}
            onRoleChange={setRole}
          />
        </div>
      </section>

      <MediAIChat />
    </main>
  );
}
