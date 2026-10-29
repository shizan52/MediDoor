import { PharmacyAppShell } from "@/components/pharmacy-app/app-shell";
import { PharmacyProfileEditScreen } from "@/components/pharmacy-app/profile-edit-screen";

export default function Page() {
  return (
    <PharmacyAppShell>
      <PharmacyProfileEditScreen />
    </PharmacyAppShell>
  );
}
