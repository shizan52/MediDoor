import { redirect } from "next/navigation";

// Customers don't have a separate dashboard — the public landing page
// (`/`) IS their home. Anyone who navigates here gets bounced.
export default function CustomerHome() {
  redirect("/");
}
