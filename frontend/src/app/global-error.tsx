"use client";

/**
 * Last-resort error boundary that catches errors thrown in the ROOT layout
 * itself (where the normal `error.tsx` boundary can't help). It must render its
 * own <html>/<body>, and it can't rely on globals.css being present, so styles
 * are inline. Kept intentionally tiny.
 */
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          background: "linear-gradient(135deg,#ecfdf5,#ffffff,#d1fae5)",
          color: "#0f172a",
        }}
      >
        <div style={{ maxWidth: 420, padding: 32, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
            কিছু একটা সমস্যা হয়েছে
          </h1>
          <p style={{ marginTop: 8, fontSize: 14, opacity: 0.75 }}>
            আবার চেষ্টা করুন — সাধারণত এতেই ঠিক হয়ে যায়।
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: 24,
              padding: "8px 20px",
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
              color: "#fff",
              background: "linear-gradient(90deg,#10b981,#059669)",
            }}
          >
            আবার চেষ্টা করুন
          </button>
        </div>
      </body>
    </html>
  );
}
