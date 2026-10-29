"use client";

import { useParams } from "next/navigation";
import { RiderAppShell } from "@/components/rider-app/app-shell";
import { RiderChatThreadScreen } from "@/components/rider-app/chat-thread-screen";

export default function Page() {
  const params = useParams<{ id: string }>();
  return (
    <RiderAppShell>
      <RiderChatThreadScreen id={params.id} />
    </RiderAppShell>
  );
}
