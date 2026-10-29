"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { fetchSiteContent, type SiteContent } from "@/lib/site";

export function SiteFooter() {
  const [site, setSite] = useState<SiteContent | null>(null);

  useEffect(() => {
    fetchSiteContent()
      .then(setSite)
      .catch(() => setSite(null));
  }, []);

  const footer = site?.footer ?? {};
  const cols = footer.columns ?? [];
  const socials = footer.socials ?? [];

  return (
    <footer className="relative mt-16 border-t border-black/5 dark:border-white/10 bg-gradient-to-br from-[#0b1220] via-[#0a1a14] to-[#06140e] text-white/85">
      <div className="relative grid gap-10 px-6 py-14 md:grid-cols-[1.4fr_repeat(4,1fr)] lg:px-12">
        <div>
          <BrandLogo className="h-12 w-auto" />
          <p className="mt-4 max-w-sm text-sm opacity-80">
            {footer.about || "MediDoor — দরজায় ঔষধ।"}
          </p>
          {socials.length > 0 && (
            <ul className="mt-5 flex flex-wrap gap-2">
              {socials.map((s) => (
                <li key={s.label}>
                  <a
                    href={s.href}
                    className="inline-flex items-center rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        {cols.map((col) => (
          <div key={col.title}>
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-white/60">
              {col.title}
            </p>
            <ul className="space-y-2 text-sm">
              {col.links.map((l) => (
                <li key={l.label}>
                  <Link href={l.href} className="opacity-80 hover:text-brand-300 hover:opacity-100">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="relative border-t border-white/5 px-6 py-4 text-xs opacity-70 lg:px-12">
        {footer.copyright || "© MediDoor"}
      </div>
    </footer>
  );
}
