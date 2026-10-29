"use client";

import { PharmacyAppShell } from "@/components/pharmacy-app/app-shell";
import { MedicineForm } from "@/components/pharmacy-app/medicine-form";
import { MobileHeader } from "@/components/pharmacy-app/mobile-header";

export default function NewMedicinePage() {
  return (
    <PharmacyAppShell>
      <MobileHeader title="New medicine" subtitle="MediAI will pick categories" back />
      <MedicineForm mode="new" />
    </PharmacyAppShell>
  );
}
