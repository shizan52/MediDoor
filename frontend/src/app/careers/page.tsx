import { InfoPage } from "@/components/info-page";

export const metadata = { title: "ক্যারিয়ার — MediDoor" };

export default function Page() {
  return (
    <InfoPage
      cmsSlug="careers"
      title="ক্যারিয়ার"
      subtitle="MediDoor-এর সাথে দেশের healthcare বদলে দিন।"
      sections={[
        { heading: "আমাদের সাথে কাজ করুন", body: [
          "আমরা এমন মানুষ খুঁজছি যারা technology দিয়ে মানুষের জীবন সহজ করতে চান — engineering, operations, pharmacy ও delivery নানা ক্ষেত্রে।",
        ]},
        { heading: "এই মুহূর্তে খোলা পদ", body: [
          "এই মুহূর্তে কোনো পদ খোলা নেই। ভবিষ্যতে সুযোগের জন্য আপনার CV পাঠিয়ে রাখুন: careers@medidoor.com.bd",
        ]},
      ]}
    />
  );
}
