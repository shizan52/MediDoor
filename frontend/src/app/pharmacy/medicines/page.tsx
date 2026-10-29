import { PharmacyAppShell } from "@/components/pharmacy-app/app-shell";
import { PharmacyMedicinesScreen } from "@/components/pharmacy-app/medicines-screen";

export default function Page() {
  return (
    <PharmacyAppShell>
      <PharmacyMedicinesScreen />
    </PharmacyAppShell>
  );
}
