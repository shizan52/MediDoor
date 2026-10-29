"use client";

import { useParams } from "next/navigation";
import { PharmacyAppShell } from "@/components/pharmacy-app/app-shell";
import { PharmacyOrderDetailScreen } from "@/components/pharmacy-app/order-detail-screen";

export default function Page() {
  const params = useParams<{ id: string }>();
  return (
    <PharmacyAppShell>
      <PharmacyOrderDetailScreen id={params.id} />
    </PharmacyAppShell>
  );
}
