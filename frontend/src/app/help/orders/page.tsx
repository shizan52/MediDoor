import { InfoPage } from "@/components/info-page";

export const metadata = { title: "Order সহায়তা — MediDoor" };

export default function Page() {
  return (
    <InfoPage
      cmsSlug="help-orders"
      title="Order সহায়তা"
      subtitle="অর্ডার দেওয়া, ট্র্যাক করা ও পাওয়া নিয়ে সাহায্য।"
      sections={[
        { heading: "কীভাবে অর্ডার করবেন", body: [
          "১) হোম পেজে আপনার লোকেশন দিন। ২) ঔষধ বা উপসর্গ লিখে খুঁজুন। ৩) pharmacy বেছে নিয়ে cart-এ যোগ করুন। ৪) login করে অর্ডার নিশ্চিত করুন।",
        ]},
        { heading: "অর্ডার ট্র্যাকিং", body: [
          "অর্ডার confirm হলে pharmacy প্রস্তুতি শুরু করে এবং rider যুক্ত হলে আপনি map-এ live tracking দেখতে পারবেন। প্রতিটি ধাপে notification পাবেন।",
        ]},
        { heading: "Prescription লাগে এমন ঔষধ", body: [
          "কিছু ঔষধে prescription বাধ্যতামূলক। অর্ডারের আগে স্পষ্ট prescription ছবি আপলোড করুন, নাহলে অর্ডার নেওয়া হবে না।",
        ]},
        { heading: "আরও সাহায্য", body: [
          "সমস্যা থাকলে লিখুন: support@medidoor.com.bd",
        ]},
      ]}
    />
  );
}
