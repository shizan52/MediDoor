"use client";

import { useParams } from "next/navigation";
import { PharmacyAppShell } from "@/components/pharmacy-app/app-shell";
import { MedicineForm } from "@/components/pharmacy-app/medicine-form";
import { MobileHeader } from "@/components/pharmacy-app/mobile-header";

export default function EditMedicinePage() {
  const params = useParams<{ id: string }>();
  return (
    <PharmacyAppShell>
      <MobileHeader title="Edit medicine" back />
      <MedicineForm mode="edit" id={params.id} />
    </PharmacyAppShell>
  );
}
