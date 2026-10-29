import { RiderAppShell } from "@/components/rider-app/app-shell";
import { RiderNotificationsScreen } from "@/components/rider-app/notifications-screen";

export default function Page() {
  return (
    <RiderAppShell>
      <RiderNotificationsScreen />
    </RiderAppShell>
  );
}
