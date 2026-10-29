import { ResponsiveView } from "@/components/responsive-view";
import { RiderProfilePage } from "@/components/rider-profile";
import { RiderAppShell } from "@/components/rider-app/app-shell";
import { RiderHomeScreen } from "@/components/rider-app/home-screen";

/**
 * Big screens → full desktop rider dashboard; small screens → the
 * app-parity mobile home inside the phone shell.
 */
export default function RiderHome() {
  return (
    <ResponsiveView
      desktop={<RiderProfilePage />}
      mobile={
        <RiderAppShell>
          <RiderHomeScreen />
        </RiderAppShell>
      }
    />
  );
}
