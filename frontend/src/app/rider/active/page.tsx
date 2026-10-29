import { RiderAppShell } from "@/components/rider-app/app-shell";
import { RiderActiveScreen } from "@/components/rider-app/active-screen";

export default function Page() {
  return (
    <RiderAppShell>
      <RiderActiveScreen />
    </RiderAppShell>
  );
}
