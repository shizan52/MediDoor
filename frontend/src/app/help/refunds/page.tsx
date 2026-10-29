import { InfoPage } from "@/components/info-page";

export const metadata = { title: "Refund সহায়তা — MediDoor" };

export default function Page() {
  return (
    <InfoPage
      cmsSlug="help-refunds"
      title="Refund সহায়তা"
      subtitle="রিফান্ড ও বাতিল সংক্রান্ত তথ্য।"
      sections={[
        { heading: "অর্ডার বাতিল", body: [
          "pharmacy confirm করার আগ পর্যন্ত আপনি অর্ডার বাতিল করতে পারেন। confirm হওয়ার পর বাতিল করতে চাইলে chat-এ pharmacy-র সাথে কথা বলুন।",
        ]},
        { heading: "ভুল বা ত্রুটিপূর্ণ পণ্য", body: [
          "পণ্যে কোনো সমস্যা (ভুল ঔষধ, মেয়াদ, প্যাকেজিং) থাকলে delivery-র সময়েই rider-কে জানান এবং আমাদের support-এ লিখুন।",
        ]},
        { heading: "রিফান্ড প্রক্রিয়া", body: [
          "অনুমোদিত রিফান্ড আপনার পেমেন্ট মাধ্যমে ফেরত দেওয়া হবে। (অনলাইন পেমেন্ট শীঘ্রই যুক্ত হচ্ছে।) প্রশ্ন থাকলে: support@medidoor.com.bd",
        ]},
      ]}
    />
  );
}
