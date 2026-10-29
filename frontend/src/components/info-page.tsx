import type { CSSProperties } from "react";
import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import { SiteFooter } from "@/components/site-footer";
import { API_URL } from "@/lib/api";

export type InfoSection = { heading?: string; body: string[] };

type Block = {
  type: "heading" | "text" | "image" | "divider";
  text?: string;
  color?: string;
  font?: string;
  size?: number;
  align?: "left" | "center" | "right";
  bold?: boolean;
  url?: string;
  width?: number;
  caption?: string;
};

type Doc = {
  slug: string;
  title?: string;
  subtitle?: string;
  updated?: string;
  visible?: boolean;
  blocks?: Block[];
};

/**
 * Fetch the admin-managed CMS document for this page, if one exists. Every
 * informational route passes a stable `cmsSlug`; when the admin console edits
 * that page (title / subtitle / rich blocks) it instantly overrides the
 * built-in fallback below — no code change or redeploy needed. A missing /
 * hidden document simply falls back to the hardcoded content, so pages never
 * 404 or go blank.
 */
async function fetchDoc(slug?: string): Promise<Doc | null> {
  if (!slug) return null;
  try {
    const res = await fetch(
      `${API_URL}/api/content/documents/${encodeURIComponent(slug)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const doc = (await res.json()) as Doc;
    if (!doc || doc.visible === false) return null;
    return doc;
  } catch {
    return null;
  }
}

function renderBlock(b: Block, i: number) {
  const style = {
    color: b.color || undefined,
    fontFamily: b.font || undefined,
    fontSize: b.size ? `${b.size}px` : undefined,
    textAlign: b.align || undefined,
    fontWeight: b.bold ? 700 : undefined,
  } as CSSProperties;

  if (b.type === "heading") {
    return (
      <h2 key={i} style={style} className="mt-7 text-xl font-semibold text-brand-700 dark:text-brand-300">
        {b.text}
      </h2>
    );
  }
  if (b.type === "text") {
    return (
      <p key={i} style={style} className="mt-3 whitespace-pre-wrap text-sm leading-relaxed opacity-90 md:text-base">
        {b.text}
      </p>
    );
  }
  if (b.type === "image" && b.url) {
    return (
      <div key={i} className="my-6" style={{ textAlign: b.align || "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={b.url}
          alt={b.caption || ""}
          style={{ width: `${b.width || 100}%`, borderRadius: 12, display: "inline-block" }}
        />
        {b.caption && <div className="mt-1 text-xs opacity-60">{b.caption}</div>}
      </div>
    );
  }
  if (b.type === "divider") {
    return <hr key={i} className="my-7 border-black/10 dark:border-white/10" />;
  }
  return null;
}

/**
 * Shared shell for the static info / legal pages (about, contact, support,
 * help, terms, privacy, cookies …). Keeps the brand header + footer and a
 * readable article column. When `cmsSlug` is given, the admin-managed document
 * for that slug overrides the built-in `title` / `subtitle` / `sections`.
 */
export async function InfoPage({
  title,
  subtitle,
  updated,
  sections,
  cmsSlug,
}: {
  title: string;
  subtitle?: string;
  updated?: string;
  sections: InfoSection[];
  /** Stable CMS slug — admin edits to this document override the fallback. */
  cmsSlug?: string;
}) {
  const doc = await fetchDoc(cmsSlug);

  // Merge CMS over the built-in defaults so a partial admin edit (e.g. only a
  // new subtitle) never blanks out the rest of the page.
  const effTitle = doc?.title?.trim() || title;
  const effSubtitle =
    doc && typeof doc.subtitle === "string" && doc.subtitle.trim()
      ? doc.subtitle
      : subtitle;
  const effUpdated = doc?.updated?.trim() || updated;
  const cmsBlocks = doc?.blocks?.filter((b) => b && b.type) ?? [];
  const useBlocks = cmsBlocks.length > 0;

  return (
    <main className="min-h-screen bg-gradient-to-br from-brand-50 via-white to-brand-100 dark:from-[#070b12] dark:via-[#0b1018] dark:to-[#091622]">
      <header className="flex items-center justify-between px-6 py-5 lg:px-10">
        <Link href="/" aria-label="MediDoor home">
          <BrandLogo className="h-12 w-auto" />
        </Link>
        <Link
          href="/"
          className="text-sm opacity-70 transition hover:opacity-100"
        >
          ← হোমে ফিরুন
        </Link>
      </header>

      <article className="mx-auto max-w-3xl px-6 pb-16 pt-6">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{effTitle}</h1>
        {effSubtitle && (
          <p className="mt-3 text-base opacity-80 md:text-lg">{effSubtitle}</p>
        )}
        {effUpdated && (
          <p className="mt-2 text-xs opacity-60">সর্বশেষ হালনাগাদ: {effUpdated}</p>
        )}

        {useBlocks ? (
          <div className="mt-6">{cmsBlocks.map(renderBlock)}</div>
        ) : (
          <div className="mt-8 space-y-8">
            {sections.map((s, i) => (
              <section key={i}>
                {s.heading && (
                  <h2 className="text-xl font-semibold text-brand-700 dark:text-brand-300">
                    {s.heading}
                  </h2>
                )}
                {s.body.map((p, j) => (
                  <p key={j} className="mt-2 text-sm leading-relaxed opacity-90 md:text-base">
                    {p}
                  </p>
                ))}
              </section>
            ))}
          </div>
        )}
      </article>

      <SiteFooter />
    </main>
  );
}
