import { InfoPage } from "@/components/info-page";

export const metadata = { title: "শর্তাবলি — MediDoor" };

export default function Page() {
  return (
    <InfoPage
      cmsSlug="terms"
      title="শর্তাবলি (Terms of Service)"
      updated="২০২৬"
      subtitle="MediDoor ব্যবহারের শর্তাবলি। সেবা ব্যবহার করলে আপনি এই শর্তগুলো মেনে নিচ্ছেন।"
      sections={[
        { heading: "১. সেবার পরিধি", body: [
          "MediDoor একটি প্ল্যাটফর্ম যা গ্রাহক, verified pharmacy ও rider-কে যুক্ত করে। MediDoor নিজে ঔষধ বিক্রি করে না; pharmacy বিক্রেতা এবং পণ্যের জন্য দায়ী।",
        ]},
        { heading: "২. অ্যাকাউন্ট", body: [
          "একটি Gmail-এ একটি অ্যাকাউন্ট ও একটি role থাকে। সঠিক তথ্য দেওয়া এবং অ্যাকাউন্টের নিরাপত্তা রক্ষা করা আপনার দায়িত্ব।",
        ]},
        { heading: "৩. Prescription ঔষধ", body: [
          "যেসব ঔষধে prescription প্রয়োজন, সেগুলোর জন্য বৈধ prescription আপলোড বাধ্যতামূলক। ভুয়া prescription দিলে অ্যাকাউন্ট বন্ধ করা হতে পারে।",
        ]},
        { heading: "৪. দায়বদ্ধতা", body: [
          "MediDoor যথাসাধ্য সঠিক সেবা দিতে চেষ্টা করে, তবে pharmacy/rider-এর কার্যক্রমজনিত ক্ষতির জন্য আইনের সীমার মধ্যে দায় সীমিত।",
        ]},
        { heading: "৫. পরিবর্তন", body: [
          "এই শর্তাবলি সময়ে সময়ে হালনাগাদ হতে পারে। গুরুত্বপূর্ণ পরিবর্তন আমরা জানাব। প্রশ্ন থাকলে: support@medidoor.com.bd",
        ]},
        { heading: "দ্রষ্টব্য", body: [
          "এটি একটি প্রাথমিক খসড়া। চূড়ান্ত প্রকাশের আগে আইনজীবীর পরামর্শ নিয়ে যাচাই করার পরামর্শ দেওয়া হলো।",
        ]},
      ]}
    />
  );
}
