"use client";

/**
 * Route-segment error boundary. Catches any error thrown while rendering a page
 * (client or server component) below the root layout and shows a friendly,
 * recoverable card instead of Next.js's bare white
 * "Application error: a client-side exception has occurred" screen.
 *
 * A failed lazy chunk fetch after a fresh deploy (ChunkLoadError) is recovered
 * automatically with one hard reload, which pulls the new build's chunk names.
 */
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the real error to the console for debugging.
    // eslint-disable-next-line no-console
    console.error(error);
    const isChunkError =
      error?.name === "ChunkLoadError" ||
      /Loading chunk [\d]+ failed|ChunkLoadError|Failed to fetch dynamically imported module/i.test(
        error?.message || "",
      );
    if (isChunkError && typeof window !== "undefined") {
      // Old build's chunk is gone (site was redeployed while this tab was open).
      // A single hard reload fetches the current build. Guard against loops.
      const key = "medidoor_chunk_reloaded_at";
      const last = Number(window.sessionStorage.getItem(key) || 0);
      if (Date.now() - last > 10000) {
        window.sessionStorage.setItem(key, String(Date.now()));
        window.location.reload();
      }
    }
  }, [error]);

  return (
    <main className="grid min-h-screen place-items-center bg-gradient-to-br from-brand-50 via-white to-brand-100 px-6 dark:from-[#070b12] dark:via-[#0b1018] dark:to-[#091622]">
      <div className="w-full max-w-md rounded-3xl border border-black/5 bg-white/85 p-8 text-center shadow-xl backdrop-blur dark:border-white/10 dark:bg-white/5">
        <h1 className="text-xl font-bold">কিছু একটা সমস্যা হয়েছে</h1>
        <p className="mt-2 text-sm opacity-75">
          পেজটি লোড করতে গিয়ে একটি সমস্যা হয়েছে। আবার চেষ্টা করুন — সাধারণত এতেই ঠিক হয়ে যায়।
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            onClick={() => reset()}
            className="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-brand-500 to-brand-600 px-5 py-2 text-sm font-semibold text-white shadow-md shadow-brand-500/30 hover:brightness-110"
          >
            আবার চেষ্টা করুন
          </button>
          <button
            onClick={() => {
              if (typeof window !== "undefined") window.location.href = "/";
            }}
            className="inline-flex items-center justify-center rounded-full border border-black/10 bg-white/70 px-5 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
          >
            হোমে ফিরুন
          </button>
        </div>
      </div>
    </main>
  );
}
