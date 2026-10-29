"use client";

import { useEffect, useState } from "react";
import { secureFileUrl, isProtectedFileUrl } from "@/lib/api";

/**
 * Renders an <img> for a stored file URL, transparently resolving protected
 * `/api/files/raw/...` URLs into a short-lived signed URL (N4). Public URLs
 * render immediately. Falls back to a placeholder if a grant is denied.
 */
export function SecureImage({
  src,
  alt = "",
  className,
  onClick,
  title,
}: {
  src: string | null | undefined;
  alt?: string;
  className?: string;
  onClick?: () => void;
  title?: string;
}) {
  const [resolved, setResolved] = useState<string>(() =>
    isProtectedFileUrl(src) ? "" : src || "",
  );
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDenied(false);
    if (!src) {
      setResolved("");
      return;
    }
    if (!isProtectedFileUrl(src)) {
      setResolved(src);
      return;
    }
    setResolved("");
    secureFileUrl(src)
      .then((u) => {
        if (!cancelled) setResolved(u);
      })
      .catch(() => {
        if (!cancelled) setDenied(true);
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (denied) {
    return (
      <div
        className={className}
        title="এই file দেখার অনুমতি নেই"
        style={{ display: "grid", placeItems: "center", background: "rgba(0,0,0,0.05)", fontSize: 11, opacity: 0.6 }}
      >
        🔒
      </div>
    );
  }
  if (!resolved) {
    return <div className={className} style={{ background: "rgba(0,0,0,0.06)" }} aria-busy="true" />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={resolved} alt={alt} className={className} onClick={onClick} title={title} />;
}
