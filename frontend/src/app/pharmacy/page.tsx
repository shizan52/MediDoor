import { ResponsiveView } from "@/components/responsive-view";
import { PharmacyProfilePage } from "@/components/pharmacy-profile";
import { PharmacyAppShell } from "@/components/pharmacy-app/app-shell";
import { PharmacyHomeScreen } from "@/components/pharmacy-app/home-screen";

/**
 * Big screens → full desktop pharmacy dashboard; small screens → the
 * app-parity mobile home inside the phone shell.
 */
export default function PharmacyHome() {
  return (
    <ResponsiveView
      desktop={<PharmacyProfilePage />}
      mobile={
        <PharmacyAppShell>
          <PharmacyHomeScreen />
        </PharmacyAppShell>
      }
    />
  );
}
