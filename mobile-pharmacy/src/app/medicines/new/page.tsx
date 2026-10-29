"use client";

import { MedicineForm } from "@/components/medicine-form";
import { MobileHeader } from "@/components/mobile-header";

export default function NewMedicinePage() {
  return (
    <>
      <MobileHeader title="New medicine" subtitle="MediAI will pick categories" back />
      <MedicineForm mode="new" />
    </>
  );
}
