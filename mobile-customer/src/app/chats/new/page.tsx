"use client";

/**
 * `/chats/new?pharmacy_id=...` — bridges the storefront → conversation
 * navigation: get-or-create the conversation row, then redirect to
 * `/chats/<id>` so the user lands directly in the thread.
 */
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { conversationsApi } from "@/lib/conversations";
import { userLocation } from "@/lib/storefront";
import { session } from "@/lib/api";

function NewChatInner() {
  const router = useRouter();
  const params = useSearchParams();
  const pharmacy_id = params?.get("pharmacy_id");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session.access()) {
      router.replace(`/login?next=/chats/new?pharmacy_id=${encodeURIComponent(pharmacy_id || "")}`);
      return;
    }
    if (!pharmacy_id) {
      router.replace("/chats");
      return;
    }
    conversationsApi
      // Live location → backend enforces the 5 km connect radius on NEW chats.
      .start(pharmacy_id, userLocation.load())
      .then((c) => router.replace(`/chats/${c.id}`))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to open chat"));
  }, [router, pharmacy_id]);

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {error ? (
        <p className="text-sm text-rose-500">{error}</p>
      ) : (
        <>
          <Loader2 size={24} className="animate-spin text-brand-500" />
          <p className="text-xs text-slate-500">Opening chat…</p>
        </>
      )}
    </div>
  );
}

export default function NewChatPage() {
  return (
    <Suspense fallback={null}>
      <NewChatInner />
    </Suspense>
  );
}
