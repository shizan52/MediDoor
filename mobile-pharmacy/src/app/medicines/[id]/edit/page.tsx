"use client";

import { useParams } from "next/navigation";
import { MedicineForm } from "@/components/medicine-form";
import { MobileHeader } from "@/components/mobile-header";

export default function EditMedicinePage() {
  const params = useParams<{ id: string }>();
  return (
    <>
      <MobileHeader title="Edit medicine" back />
      <MedicineForm mode="edit" id={params.id} />
    </>
  );
}
