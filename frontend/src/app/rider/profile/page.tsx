import { ResponsiveView } from "@/components/responsive-view";
import { RiderMyProfilePage } from "@/components/rider-my-profile";
import { RiderAppShell } from "@/components/rider-app/app-shell";
import { RiderProfileScreen } from "@/components/rider-app/profile-screen";

export default function RiderMyProfile() {
  return (
    <ResponsiveView
      desktop={<RiderMyProfilePage />}
      mobile={
        <RiderAppShell>
          <RiderProfileScreen />
        </RiderAppShell>
      }
    />
  );
}
