"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Home, MessageCircle, ClipboardList, Pill, User, type LucideIcon } from "lucide-react";
import { conversationsApi } from "@/lib/conversations";
import { session } from "@/lib/api";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  match: RegExp;
  badge?: "chats";
};

const NAV_ITEMS: NavItem[] = [
  { href: "/pharmacy",           label: "Home",      icon: Home,          match: /^\/pharmacy$/ },
  { href: "/pharmacy/orders",    label: "Orders",    icon: ClipboardList, match: /^\/pharmacy\/orders(\/|$)/ },
  { href: "/pharmacy/chats",     label: "Chats",     icon: MessageCircle, match: /^\/pharmacy\/chats(\/|$)/, badge: "chats" },
  { href: "/pharmacy/medicines", label: "Medicines", icon: Pill,          match: /^\/pharmacy\/medicines(\/|$)/ },
  { href: "/pharmacy/profile",   label: "Profile",   icon: User,          match: /^\/pharmacy\/profile(\/|$)/ },
];

function useUnreadChatCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!session.access()) return;
    let cancelled = false;
    const tick = () =>
      conversationsApi
        .list()
        .then((items) => {
          if (cancelled) return;
          setN(items.reduce((acc, c) => acc + (c.unread_count ?? 0), 0));
        })
        .catch(() => {});
    tick();
    const t = setInterval(tick, 20_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  return n;
}

/**
 * Fixed bottom navigation — 1:1 port of mobile-pharmacy's BottomNav with
 * routes remapped under /pharmacy. Same shape + safe-area handling.
 */
export function BottomNav() {
  const pathname = usePathname() ?? "/pharmacy";
  const unreadChats = useUnreadChatCount();
  return (
    <nav
      role="navigation"
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-slate-200/70 bg-white/90 backdrop-blur-md dark:border-white/10 dark:bg-[#0b1018]/90"
      style={{
        height: "var(--bottom-nav-total)",
        paddingBottom: "var(--safe-bottom)",
        paddingLeft: "var(--safe-left)",
        paddingRight: "var(--safe-right)",
      }}
    >
      <div className="mx-auto grid h-[var(--bottom-nav-h)] max-w-[480px] grid-cols-5 px-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.match.test(pathname);
          const badgeCount = item.badge === "chats" ? unreadChats : 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              aria-current={active ? "page" : undefined}
              className="tap relative flex min-h-[44px] flex-col items-center justify-center gap-0.5 text-[10px] font-medium"
            >
              <span className="relative">
                <Icon
                  size={22}
                  strokeWidth={active ? 2.4 : 1.8}
                  className={active ? "text-brand-500" : "text-slate-500 dark:text-slate-400"}
                />
                {badgeCount > 0 && (
                  <span className="absolute -right-2 -top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-rose-500 px-1 text-[9px] font-bold leading-none text-white shadow ring-2 ring-white dark:ring-[#0b1018]">
                    {badgeCount > 99 ? "99+" : badgeCount}
                  </span>
                )}
              </span>
              <span className={active ? "text-brand-600 dark:text-brand-400" : "text-slate-500 dark:text-slate-400"}>
                {item.label}
              </span>
              {active && (
                <span className="absolute top-0 h-0.5 w-8 rounded-b-full bg-brand-500" />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
