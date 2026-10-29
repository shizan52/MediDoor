# MediDoor Rider — Android TWA shell

এই folder-টা হলো **Trusted Web Activity (TWA)** Android project — একটা পাতলা,
signed shell যেটা খুললেই `https://rider.medidoor.com.bd` full-screen-এ চলে।

## App কখনো "update" করা লাগে না কেন

App-এর ভেতরে কোনো UI/logic নেই — সবকিছু server-এ (mobile-rider Next.js
app)। তাই:

- **Content update** = `python deploy_mobile.py rider` (repo root থেকে) —
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
& "$T\gradle\bin\gradle.bat" -p mobile-rider\android assembleRelease
# output: mobile-rider\android\app\build\outputs\apk\release\app-release.apk
```

Play-Store bundle লাগলে `assembleRelease`-এর জায়গায় `bundleRelease`;
output `app\build\outputs\bundle\release\app-release.aab`।

## Signing

- Keystore: `keystore/medidoor-rider.keystore`
  (alias `medidoor-rider`; password `gradle.properties`-এ)।
- **এই keystore হারালে Play-Store-এ একই listing-এ আর update দেওয়া যাবে না**,
  আর assetlinks.json-ও এই certificate-এর SHA-256-এ বাঁধা। Backup রাখুন।
- SHA-256: `E9:4D:49:7B:B7:EC:A8:60:6A:C0:C5:96:F9:46:05:8F:B5:C3:48:10:08:B8:0A:E4:70:8B:D7:91:B2:B3:15:F8`
- Full-screen (browser bar ছাড়া) চলার শর্ত: site-এ
  `/.well-known/assetlinks.json` serve হওয়া
  (`mobile-rider/public/.well-known/assetlinks.json` — deploy-এর সাথেই যায়)।

## Icon

তিনটা MediDoor app একই ফোনে থাকে, তাই launcher tile-এর রং দিয়ে আলাদা করা:
**customer = navy-on-white**, **pharmacy = white-on-green (`#06ad65`)**,
**rider = white-on-navy (`#0e2245`)**। Mark একই — brand consistent থাকে।

Splash কিন্তু তিনটাতেই **সাদা** (navy mark on white): splash-এর রং page-এর
background-এর সাথে মেলে, তাই app খোলার সময় রঙিন ঝলক দেখা যায় না।

## Test install — `.apk` বনাম `.aab`

| File | কাজ | ফোনে সরাসরি install |
| --- | --- | --- |
| `medidoor-rider.apk` (`release/apk/`) | **ফোনে টেস্ট** — file-টা ফোনে নিয়ে tap → install | ✅ হ্যাঁ |
| `app-release.aab` | **Play Store upload** | ❌ না — Play Store-only format |

APK install করতে: ফোনে file copy → tap → "Install unknown apps" allow
(Chrome/Files-কে permission) → Install।

⚠️ Rider app-এ live map/navigation লাগে — server-এর `.env.production`-এ
`NEXT_PUBLIC_BARIKOI_KEY` সেট থাকতে হবে (`deploy_mobile.py rider` প্রথমবার এটা
seed করে দেয়)।

## Play Store upload — App Signing ⚠️ (full-screen ভাঙার সবচেয়ে কমন কারণ)

Play Console-এ নতুন app বানালে Google **Play App Signing** বাধ্যতামূলক —
Google নিজের key দিয়ে apk re-sign করে ফোনে পাঠায়। ফলে ফোনে-installed
app-এর certificate আর আমাদের keystore-এর certificate **আলাদা** হয়ে যায়,
আর assetlinks.json তখন মেলে না → app browser-bar সহ খুলবে (full-screen
হারাবে)। ঠিক করতে:

1. `.aab` upload-এর পরে Play Console → **Setup → App signing** খুলুন।
2. **"App signing key certificate"**-এর `SHA-256` fingerprint copy করুন।
3. সেটা `mobile-rider/public/.well-known/assetlinks.json`-এর
   `sha256_cert_fingerprints` array-তে **যোগ** করুন (আগেরটা রেখে) —
   দুটো fingerprint পাশাপাশি থাকলে টেস্ট-apk আর Play-version দুটোই
   full-screen চলবে।
4. `python deploy_mobile.py rider` চালিয়ে server-এ নতুন assetlinks deploy করুন।

আরও নোট: sideload-করা টেস্ট apk (আমাদের key) আর Play-থেকে-নামানো app
(Google-এর key) একে-অন্যের উপর install হয় না — Play version টেস্ট করার
আগে পুরনো apk uninstall করুন।
