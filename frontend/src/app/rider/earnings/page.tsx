import { RiderAppShell } from "@/components/rider-app/app-shell";
import { RiderEarningsScreen } from "@/components/rider-app/earnings-screen";

export default function Page() {
  return (
    <RiderAppShell>
      <RiderEarningsScreen />
    </RiderAppShell>
  );
}
