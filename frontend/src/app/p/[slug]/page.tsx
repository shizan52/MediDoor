import type { CSSProperties } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BrandLogo } from "@/components/brand-logo";
import { SiteFooter } from "@/components/site-footer";
import { API_URL } from "@/lib/api";

export const dynamic = "force-dynamic";

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
  title: string;
  subtitle?: string;
  updated?: string;
  visible?: boolean;
  blocks?: Block[];
};

async function getDoc(slug: string): Promise<Doc | null> {
  try {
    const res = await fetch(`${API_URL}/api/content/documents/${encodeURIComponent(slug)}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as Doc;
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
      <h2 key={i} style={style} className="mt-7 font-semibold">
        {b.text}
      </h2>
    );
  }
  if (b.type === "text") {
    return (
      <p key={i} style={style} className="mt-3 whitespace-pre-wrap leading-relaxed opacity-90">
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

export default async function DocumentPage({ params }: { params: { slug: string } }) {
  const doc = await getDoc(params.slug);
  if (!doc || doc.visible === false) notFound();

  return (
    <main className="min-h-screen bg-gradient-to-br from-brand-50 via-white to-brand-100 dark:from-[#070b12] dark:via-[#0b1018] dark:to-[#091622]">
      <header className="flex items-center justify-between px-6 py-5 lg:px-10">
        <Link href="/" aria-label="MediDoor home">
          <BrandLogo className="h-12 w-auto" />
        </Link>
        <Link href="/" className="text-sm opacity-70 transition hover:opacity-100">
          ← হোমে ফিরুন
        </Link>
      </header>

      <article className="mx-auto max-w-3xl px-6 pb-16 pt-6">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{doc.title}</h1>
        {doc.subtitle && <p className="mt-3 text-base opacity-80 md:text-lg">{doc.subtitle}</p>}
        {doc.updated && (
          <p className="mt-2 text-xs opacity-60">সর্বশেষ হালনাগাদ: {doc.updated}</p>
        )}
        <div className="mt-6">{(doc.blocks || []).map(renderBlock)}</div>
      </article>

      <SiteFooter />
    </main>
  );
}
