import { RiderAppShell } from "@/components/rider-app/app-shell";
import { RiderMessagesScreen } from "@/components/rider-app/messages-screen";

export default function Page() {
  return (
    <RiderAppShell>
      <RiderMessagesScreen />
    </RiderAppShell>
  );
}
