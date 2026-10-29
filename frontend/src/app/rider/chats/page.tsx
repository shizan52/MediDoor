import { RiderAppShell } from "@/components/rider-app/app-shell";
import { RiderChatsScreen } from "@/components/rider-app/chats-screen";

export default function Page() {
  return (
    <RiderAppShell>
      <RiderChatsScreen />
    </RiderAppShell>
  );
}
