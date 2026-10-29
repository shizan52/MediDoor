import type { Metadata } from "next";
import { Inter, Hind_Siliguri } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

// The whole product is Bengali-first. `Inter` covers Latin/numerals; the OS
// fallback for Bengali renders inconsistently and — with the compact UI line
// heights — makes Bengali vowel marks overlap the next line ("text on top of
// text"). Bundling `Hind Siliguri` (a clean Bengali UI face) fixes that
// everywhere, on every device, and gives an app-like professional look.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const bengali = Hind_Siliguri({
  subsets: ["bengali"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-bengali",
  display: "swap",
});

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// Default favicon = MediDoor brand logo (shipped in /public/brand). The admin
// can override this per-brand from the admin console (Site → Favicon).
const DEFAULT_FAVICON = "/brand/logo-outside-bg.png";

/**
 * Resolve the admin-configured favicon on the SERVER so it is baked into the
 * initial <head> that React owns and renders.
 *
 * This replaces the old client-side `FaviconManager`, which mutated <head>
 * imperatively — it removed the React-managed `<link rel="icon">` nodes and
 * appended its own. Removing DOM nodes that React still tracks left React with
 * a detached fiber whose parent was null, so the very next client-side
 * navigation crashed with `Cannot read properties of null (reading
 * 'removeChild')` ("Application error: a client-side exception has occurred"),
 * and only a full reload recovered. Fetching here keeps the favicon fully
 * inside React's render, so navigations never touch a detached node.
 *
 * The fetch is cached (revalidate) and falls back to the brand default on any
 * error, so a slow or unreachable content API never blocks or breaks rendering.
 */
async function resolveFavicon(): Promise<string> {
  try {
    const res = await fetch(`${API_URL}/api/content/site`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return DEFAULT_FAVICON;
    const site = (await res.json()) as { favicon?: { image_url?: string } };
    const url = site?.favicon?.image_url?.trim();
    if (!url) return DEFAULT_FAVICON;
    if (/^(https?:|data:)/.test(url)) return url;
    return url.startsWith("/") ? `${API_URL}${url}` : `${API_URL}/${url}`;
  } catch {
    return DEFAULT_FAVICON;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const favicon = await resolveFavicon();
  return {
    title: "MediDoor — Medicine at your doorstep",
    description: "Order medicine from nearby pharmacies, delivered fast.",
    icons: {
      icon: favicon,
      shortcut: favicon,
      apple: favicon,
    },
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bn" className={`${inter.variable} ${bengali.variable}`} suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
