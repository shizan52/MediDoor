import { redirect } from "next/navigation";

/**
 * Legacy route. The old "Shop settings" mega-page was replaced by the
 * app-parity /pharmacy/profile/edit screen (mirrors mobile-pharmacy's
 * /profile/edit); hours + license + map now live on /pharmacy/profile.
 */
export default function Page() {
  redirect("/pharmacy/profile/edit");
}
