import { InfoPage } from "@/components/info-page";

export const metadata = { title: "যোগাযোগ — MediDoor" };

export default function Page() {
  return (
    <InfoPage
      cmsSlug="contact"
      title="যোগাযোগ"
      subtitle="আমরা সাহায্য করতে এখানে আছি।"
      sections={[
        { heading: "সাধারণ সহায়তা", body: [
          "ইমেইল: support@medidoor.com.bd",
          "আমরা সাধারণত ২৪ ঘণ্টার মধ্যে সাড়া দিই।",
        ]},
        { heading: "পার্টনারশিপ", body: [
          "ফার্মেসি বা রাইডার হিসেবে যুক্ত হতে: partners@medidoor.com.bd",
        ]},
      ]}
    />
  );
}
