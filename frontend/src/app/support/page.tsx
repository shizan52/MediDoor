import { InfoPage } from "@/components/info-page";

export const metadata = { title: "Partner support — MediDoor" };

export default function Page() {
  return (
    <InfoPage
      cmsSlug="support"
      title="Partner support"
      subtitle="ফার্মেসি ও রাইডার পার্টনারদের জন্য সহায়তা।"
      sections={[
        { heading: "ফার্মেসি পার্টনার", body: [
          "অ্যাকাউন্ট verification, product আপলোড বা অর্ডার সংক্রান্ত যেকোনো সমস্যায় dashboard-এর “Admin support” thread ব্যবহার করুন, অথবা লিখুন: partners@medidoor.com.bd",
        ]},
        { heading: "রাইডার পার্টনার", body: [
          "Verification, delivery বা earnings সংক্রান্ত সহায়তার জন্য app-এর support thread ব্যবহার করুন, অথবা লিখুন: riders@medidoor.com.bd",
        ]},
      ]}
    />
  );
}
