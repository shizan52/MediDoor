"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";

type Props = {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  back?: boolean;
  right?: React.ReactNode;
  transparent?: boolean;
};

export function MobileHeader({ title, subtitle, back, right, transparent }: Props) {
  const router = useRouter();
  return (
    <header
      className={[
        "fixed inset-x-0 top-0 z-40 flex items-end",
        transparent
          ? "bg-transparent"
          : "border-b border-slate-200/60 bg-white/90 backdrop-blur-md dark:border-white/10 dark:bg-[#070b12]/90",
      ].join(" ")}
      style={{
        height: "calc(var(--header-h) + var(--safe-top))",
        paddingTop: "var(--safe-top)",
        paddingLeft: "var(--safe-left)",
        paddingRight: "var(--safe-right)",
      }}
    >
      <div className="mx-auto flex h-[var(--header-h)] w-full max-w-[480px] items-center gap-2 px-3">
        {back && (
          <button
            type="button"
            onClick={() => router.back()}
            aria-label="Back"
            className="tap -ml-1 flex h-10 w-10 items-center justify-center rounded-full text-slate-700 hover:bg-slate-100 active:bg-slate-200 dark:text-slate-200 dark:hover:bg-white/5"
          >
            <ArrowLeft size={22} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          {title && (
            <div className="truncate text-base font-semibold leading-tight">{title}</div>
          )}
          {subtitle && (
            <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
              {subtitle}
            </div>
          )}
        </div>
        {right && <div className="flex shrink-0 items-center gap-1">{right}</div>}
      </div>
    </header>
  );
}
