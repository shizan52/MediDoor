import { InfoPage } from "@/components/info-page";

export const metadata = { title: "Cookie নীতি — MediDoor" };

export default function Page() {
  return (
    <InfoPage
      cmsSlug="cookies"
      title="Cookie নীতি"
      updated="২০২৬"
      subtitle="আমরা কীভাবে cookie ও অনুরূপ প্রযুক্তি ব্যবহার করি।"
      sections={[
        { heading: "প্রয়োজনীয় cookie", body: [
          "login session ও নিরাপত্তা ধরে রাখার জন্য কিছু cookie অপরিহার্য; এগুলো ছাড়া সেবা ঠিকভাবে কাজ করে না।",
        ]},
        { heading: "পছন্দ ও পরিসংখ্যান", body: [
          "আপনার অভিজ্ঞতা উন্নত করতে এবং সেবা কেমন চলছে তা বুঝতে আমরা সীমিত পরিসংখ্যান ব্যবহার করতে পারি।",
        ]},
        { heading: "নিয়ন্ত্রণ", body: [
          "আপনি browser সেটিংস থেকে cookie নিয়ন্ত্রণ বা মুছে ফেলতে পারেন। প্রশ্ন থাকলে: privacy@medidoor.com.bd",
        ]},
      ]}
    />
  );
}
