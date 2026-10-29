import { InfoPage } from "@/components/info-page";

export const metadata = { title: "প্রেস — MediDoor" };

export default function Page() {
  return (
    <InfoPage
      cmsSlug="press"
      title="প্রেস"
      subtitle="সংবাদমাধ্যমের জন্য তথ্য ও যোগাযোগ।"
      sections={[
        { heading: "মিডিয়া অনুসন্ধান", body: [
          "সাংবাদিক বা মিডিয়া প্রতিনিধি হলে আমাদের লিখুন: press@medidoor.com.bd — আমরা দ্রুত সাড়া দেওয়ার চেষ্টা করি।",
        ]},
        { heading: "ব্র্যান্ড অ্যাসেট", body: [
          "MediDoor লোগো ও ব্র্যান্ড ব্যবহারের নির্দেশনা প্রয়োজন হলে আমাদের সাথে যোগাযোগ করুন।",
        ]},
      ]}
    />
  );
}
