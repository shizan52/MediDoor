import { PharmacyAppShell } from "@/components/pharmacy-app/app-shell";
import { PharmacyOrdersScreen } from "@/components/pharmacy-app/orders-screen";

export default function Page() {
  return (
    <PharmacyAppShell>
      <PharmacyOrdersScreen />
    </PharmacyAppShell>
  );
}
