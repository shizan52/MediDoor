import { InfoPage } from "@/components/info-page";

export const metadata = { title: "আমাদের সম্পর্কে — MediDoor" };

export default function Page() {
  return (
    <InfoPage
      cmsSlug="about"
      title="আমাদের সম্পর্কে"
      subtitle="MediDoor — Bangladesh-এর verified pharmacy network, আপনার দরজায় ঔষধ।"
      sections={[
        { heading: "আমরা কী করি", body: [
          "MediDoor আপনাকে আপনার আশেপাশের DGDA-verified pharmacy-র সাথে যুক্ত করে — কয়েক মুহূর্তে অর্ডার, real-time tracking এবং trusted rider-এর মাধ্যমে দ্রুত হোম ডেলিভারি।",
        ]},
        { heading: "আমাদের লক্ষ্য", body: [
          "নিরাপদ, সঠিক ও সাশ্রয়ী ঔষধ যেন দেশের প্রতিটি ঘরে সহজে পৌঁছায় — এটাই আমাদের লক্ষ্য। প্রতিটি pharmacy আমরা DGDA registry-র সাথে যাচাই করি, যাতে আপনি নিশ্চিন্তে অর্ডার করতে পারেন।",
        ]},
        { heading: "যোগাযোগ", body: [
          "যেকোনো প্রশ্নে আমাদের লিখুন: support@medidoor.com.bd",
        ]},
      ]}
    />
  );
}
