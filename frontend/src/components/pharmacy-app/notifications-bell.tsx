"use client";

/**
 * Reusable header bell — 1:1 port of mobile-pharmacy's notifications-bell.
 * Links to /pharmacy/profile?tab=inbox and shows the unread notification
 * count. Mounted in every screen's MobileHeader so the pharmacy never
 * misses a MediAI prompt.
 *
 * Polls /api/pharmacy/me/notifications every 60s. The bell silently
 * fails (just shows 0 unread) if the request errors so we don't break
 * the whole header.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { pharmacyApi } from "@/lib/pharmacy";

export function NotificationsBell() {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const load = () =>
      Promise.all([
        pharmacyApi.listNotifications().catch(() => ({ unread: 0 })),
        pharmacyApi.adminThreadUnread().catch(() => ({ unread: 0 })),
      ])
        .then(([n, admin]) => setUnread(Number(n.unread || 0) + Number(admin.unread || 0)))
        .catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  return (
    <Link
      href="/pharmacy/profile?tab=inbox"
      aria-label="Notifications"
      className="tap relative flex h-10 w-10 items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-white/5"
    >
      <Bell size={18} />
      {unread > 0 && (
        <span className="absolute right-1 top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-brand-500 px-1 text-[9px] font-bold text-white">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </Link>
  );
}
