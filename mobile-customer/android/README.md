# MediDoor Customer — Android TWA shell

এই folder-টা হলো **Trusted Web Activity (TWA)** Android project — একটা পাতলা,
signed shell যেটা খুললেই `https://customer.medidoor.com.bd` full-screen-এ চলে।

## App কখনো "update" করা লাগে না কেন

App-এর ভেতরে কোনো UI/logic নেই — সবকিছু server-এ (mobile-customer Next.js
app)। তাই:

- **Content update** = `python deploy_mobile.py customer` (repo root থেকে) —
  server-এ নতুন build বসে, প্রতিটা installed app পরের launch-এই নতুন version
  পায়। Play-Store release লাগে না। (YouTube/Facebook-এর মতো server-driven।)
- **Shell rebuild লাগে শুধু তখনই** যদি app-এর নাম/icon/রং/package-id বা
  signing বদলাতে হয়।

## Rebuild করার নিয়ম (এক কমান্ড)

Tooling এক জায়গায় থাকে: `%LOCALAPPDATA%\medidoor-android`
(JDK 17 + Android SDK + Gradle — প্রথমবার setup করা আছে)।

```powershell
$T = "$env:LOCALAPPDATA\medidoor-android"
$env:JAVA_HOME = "$T\jdk"; $env:ANDROID_HOME = "$T\sdk"
& "$T\gradle\bin\gradle.bat" -p mobile-customer\android bundleRelease
# output: mobile-customer\android\app\build\outputs\bundle\release\app-release.aab
```

## Signing

- Keystore: `keystore/medidoor-customer.keystore`
  (alias `medidoor-customer`; password `gradle.properties`-এ)।
- **এই keystore হারালে Play-Store-এ একই listing-এ আর update দেওয়া যাবে না**,
  আর assetlinks.json-ও এই certificate-এর SHA-256-এ বাঁধা। Backup রাখুন।
- Full-screen (browser bar ছাড়া) চলার শর্ত: site-এ
  `/.well-known/assetlinks.json` serve হওয়া
  (`mobile-customer/public/.well-known/assetlinks.json` — deploy-এর সাথেই যায়)।

## Test install — `.apk` বনাম `.aab`

Installable apk থাকে repo-র `release/apk/` folder-এ (তিনটা app-এরই):

| File | কাজ | ফোনে সরাসরি install |
| --- | --- | --- |
| `release/apk/medidoor-customer.apk` | **ফোনে টেস্ট** — file-টা ফোনে নিয়ে tap → install | ✅ হ্যাঁ |
| `app-release.aab` (`bundleRelease`) | **Play Store upload** (internal testing / production) | ❌ না — Play Store-only format |

`.aab` ফোনে খুললে কিছুই হবে না — ওটা Google Play-র publishing bundle;
Play নিজে ওটা থেকে ফোন-ভেদে apk বানিয়ে পাঠায়। দুটোই একই keystore-এ
signed, তাই apk দিয়ে টেস্ট করে পরে সেই .aab-ই Play-তে দেওয়া যায়।

APK install করতে: ফোনে file copy → tap → "Install unknown apps" allow
(Chrome/Files-কে permission) → Install।

APK rebuild: উপরের command-এ `bundleRelease`-এর জায়গায় `assembleRelease`;
output `app\build\outputs\apk\release\app-release.apk`।

⚠️ App-টা খুললে content আসবে `https://customer.medidoor.com.bd` থেকে —
সেটা live না থাকলে (প্রথমে `python deploy_mobile.py customer --provision` + DNS
CNAME) app খুলবে কিন্তু "site can't be reached" দেখাবে। Shell ঠিকই আছে;
server live হলেই content আসবে।

## Play Store upload — App Signing ⚠️ (full-screen ভাঙার সবচেয়ে কমন কারণ)

Play Console-এ নতুন app বানালে Google **Play App Signing** বাধ্যতামূলক —
Google নিজের key দিয়ে apk re-sign করে ফোনে পাঠায়। ফলে ফোনে-installed
app-এর certificate আর আমাদের keystore-এর certificate **আলাদা** হয়ে যায়,
আর assetlinks.json তখন মেলে না → app browser-bar সহ খুলবে (full-screen
হারাবে)। ঠিক করতে:

1. `.aab` upload-এর পরে Play Console → **Setup → App signing** খুলুন।
2. **"App signing key certificate"**-এর `SHA-256` fingerprint copy করুন।
3. সেটা `mobile-customer/public/.well-known/assetlinks.json`-এর
   `sha256_cert_fingerprints` array-তে **যোগ** করুন (আগেরটা রেখে) —
   দুটো fingerprint পাশাপাশি থাকলে টেস্ট-apk আর Play-version দুটোই
   full-screen চলবে।
4. `python deploy_mobile.py customer` চালিয়ে server-এ নতুন assetlinks deploy করুন।

আরও নোট: sideload-করা টেস্ট apk (আমাদের key) আর Play-থেকে-নামানো app
(Google-এর key) একে-অন্যের উপর install হয় না — Play version টেস্ট করার
আগে পুরনো apk uninstall করুন।
