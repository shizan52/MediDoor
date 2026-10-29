"use client";

import { useParams } from "next/navigation";
import { PharmacyAppShell } from "@/components/pharmacy-app/app-shell";
import { PharmacyChatThreadScreen } from "@/components/pharmacy-app/chat-thread-screen";

export default function Page() {
  const params = useParams<{ id: string }>();
  return (
    <PharmacyAppShell>
      <PharmacyChatThreadScreen id={params.id} />
    </PharmacyAppShell>
  );
}
