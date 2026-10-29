import { ResponsiveView } from "@/components/responsive-view";
import { PharmacyMyProfilePage } from "@/components/pharmacy-my-profile";
import { PharmacyAppShell } from "@/components/pharmacy-app/app-shell";
import { PharmacyProfileScreen } from "@/components/pharmacy-app/profile-screen";

export default function PharmacyMyProfile() {
  return (
    <ResponsiveView
      desktop={<PharmacyMyProfilePage />}
      mobile={
        <PharmacyAppShell>
          <PharmacyProfileScreen />
        </PharmacyAppShell>
      }
    />
  );
}
