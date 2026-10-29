import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { Providers } from "@/components/providers";
import { MobileShell } from "@/components/mobile-shell";

export const metadata: Metadata = {
  title: "medidoor rider",
  description:
    "Deliver medicine across Dhaka with MediDoor — offers, live chats & earnings in one mobile app.",
  manifest: "/manifest.webmanifest",
  applicationName: "medidoor rider",
  appleWebApp: {
    capable: true,
    title: "medidoor rider",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  // This origin is the Android app's PRIVATE content server, not a public
  // website — keep it out of every search engine.
  robots: { index: false, follow: false },
};

/**
 * App-only gate. rider.medidoor.com.bd exists ONLY to feed the Android
 * TWA — humans typing the URL into a normal browser get bounced to the real
 * website. Inside the TWA (and an installed PWA) the page always runs in
 * `display-mode: standalone`, and TWA navigations carry an
 * `android-app://bd.com.medidoor.rider` referrer — a normal browser tab
 * has neither, so it redirects before anything renders. Localhost/dev and
 * every other hostname are untouched.
 */
const APP_ONLY_GATE = `(function () {
  try {
    if (location.hostname !== "rider.medidoor.com.bd") return;
    var KEY = "md_app_ok";
    // Signals that prove we are inside the Android app, strongest first:
    //  1. ?app=1  — the TWA's launch_url carries it (we control the apk).
    //  2. standalone display-mode — true in a TWA / installed PWA.
    //  3. android-app:// referrer — set by Chrome on the TWA's first load.
    //  4. sticky flag — so in-app SPA navigations (which have none of the
    //     above) keep working for the rest of the session.
    var isApp =
      /[?&]app=1(?:&|$)/.test(location.search) ||
      (window.matchMedia && matchMedia("(display-mode: standalone)").matches) ||
      document.referrer.indexOf("android-app://bd.com.medidoor.rider") === 0 ||
      sessionStorage.getItem(KEY) === "1" ||
      localStorage.getItem(KEY) === "1";
    if (isApp) {
      // Remember on BOTH storages: the app must never be bounced later, even
      // after a cold start where the referrer/param is absent.
      sessionStorage.setItem(KEY, "1");
      localStorage.setItem(KEY, "1");
      return;
    }
    location.replace("https://medidoor.com.bd/");
  } catch (e) { /* never block the app on a gate error */ }
})();`;

// `viewport-fit=cover` is what lets `env(safe-area-inset-*)` actually
// resolve to non-zero values on iOS — without it the page renders inside
// the safe-area letterbox and the notch appears as black bars.
export const viewport: Viewport = {
  // NOTE: `themeColor` is deliberately NOT set here.
  //
  // The Android system bars must follow the IN-APP theme toggle, not the OS
  // preference, so `SystemBarColor` (providers.tsx) owns the theme-color meta
  // tag at runtime. If Next also emits one, it becomes a React-managed DOM
  // node — and touching/removing it made React crash on the next client-side
  // navigation ("Cannot read properties of null (reading 'removeChild')" →
  // full "Application error" screen). Leaving it out keeps that tag entirely
  // ours, so React never tries to reconcile a node we mutated.
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bn" suppressHydrationWarning>
      <body>
        <Script id="app-only-gate" strategy="beforeInteractive">
          {APP_ONLY_GATE}
        </Script>
        <Providers>
          <MobileShell>{children}</MobileShell>
        </Providers>
      </body>
    </html>
  );
}
