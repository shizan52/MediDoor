import { PharmacyAppShell } from "@/components/pharmacy-app/app-shell";
import { PharmacyChatsScreen } from "@/components/pharmacy-app/chats-screen";

export default function Page() {
  return (
    <PharmacyAppShell>
      <PharmacyChatsScreen />
    </PharmacyAppShell>
  );
}
