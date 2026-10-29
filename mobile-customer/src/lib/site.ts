import { API_URL } from "@/lib/api";

export type FooterLink = { label: string; href: string };
export type FooterColumn = { title: string; links: FooterLink[] };
export type SiteContent = {
  banner: {
    image_url?: string;
    image_url_mobile?: string;
    eyebrow?: string;
    title_top?: string;
    title_highlight?: string;
    subtitle?: string;
  };
  bot: { name?: string; tagline?: string; avatar_url?: string };
  /** MediDoor admin support contact — shown as a chat contact (parity
   *  with the website messenger dock). */
  admin_support?: { name?: string; tagline?: string; avatar_url?: string };
  footer: {
    about?: string;
    copyright?: string;
    columns?: FooterColumn[];
    socials?: FooterLink[];
  };
};

export async function fetchSiteContent(): Promise<SiteContent> {
  const res = await fetch(`${API_URL}/api/content/site`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Site content ${res.status}`);
  return res.json();
}
