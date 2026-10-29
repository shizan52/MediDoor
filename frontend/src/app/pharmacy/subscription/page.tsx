import { PharmacyAppShell } from "@/components/pharmacy-app/app-shell";
import { PharmacySubscriptionScreen } from "@/components/pharmacy-app/subscription-screen";

export default function Page() {
  return (
    <PharmacyAppShell>
      <PharmacySubscriptionScreen />
    </PharmacyAppShell>
  );
}
