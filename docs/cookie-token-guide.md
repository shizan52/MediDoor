# MediDoor — Cookie, Token ও Auth ব্যবহার গাইড (আসল architecture)

> **Rebuilt 2026-07-16.** আগের গাইডে যা লেখা ছিল তার অনেকটাই আমাদের কোডের সাথে
> মিলত না (CSRF token, password reset, AsyncStorage/Keychain, 15-min access
> token — এগুলোর কোনোটাই MediDoor-এ নেই)। এই version টা backend + website +
> ৩টা mobile app-এর **আসল** কোড পড়ে লেখা, যাতে guide দেখে debug করা যায়।
> Source of truth: `backend/app/api/routes/auth.py`, `backend/app/core/security.py`,
> `backend/app/core/config.py`, প্রতিটা client-এর `src/lib/api.ts`।

---

## 1. এক নজরে: আমাদের মডেল

MediDoor-এ **password নেই** — login মানেই **Google OAuth**। Login সফল হলে
backend দুটো **JWT** দেয়:

| Token | মেয়াদ | কোথায় সেট হয় | কাজ |
|---|---|---|---|
| **Access token** | **৬০ মিনিট** (`ACCESS_TOKEN_EXPIRE_MINUTES = 60`) | client storage | প্রতিটা API call-এর `Authorization: Bearer <access>` header |
| **Refresh token** | **৩০ দিন** (`REFRESH_TOKEN_EXPIRE_DAYS = 30`) | client storage | Access token মেয়াদ শেষ হলে `POST /api/auth/refresh` দিয়ে নতুন pair আনা |
| **File token** (signed URL) | **১০ মিনিট** (default `ttl_seconds=600`) | URL-এর `sig=` অংশে | Private ফাইল (prescription/NID/license) `<img>` ট্যাগে দেখানো — `/api/files/grant` থেকে মেলে, client ৪ মিনিট cache করে |

JWT payload: `sub` (account id), `role`, `type` (`access`/`refresh`), `iat`, `exp` —
HS256, `SECRET_KEY` দিয়ে সই করা। Server-side কোনো session table নেই — সম্পূর্ণ
**stateless**।

**Cookie মাত্র একটাই আছে**: api origin-এর signed **`session` cookie**, শুধু
Google OAuth round-trip-এর সময় state বহন করে (নিচে §4)। এর বাইরে MediDoor
কোনো cookie ব্যবহার করে না — session cookie দিয়ে API auth হয় **না**।

---

## 2. Client-side storage (website + ৩টা app একই নিয়ম)

আমাদের mobile app গুলো (customer/pharmacy/rider) হলো **TWA** — অর্থাৎ ভেতরে
আসলে Next.js **web app** চলে (`customer.medidoor.com.bd` ইত্যাদি)। তাই
AsyncStorage/Keychain নয় — **সব client-এ browser storage**:

| Key | কী থাকে |
|---|---|
| `medidoor_access` | Access JWT |
| `medidoor_refresh` | Refresh JWT |
| `medidoor_role` | `customer` / `pharmacy` / `rider` |

লেখা হয় **দুই জায়গায়** (`writeBoth`): `sessionStorage` (এই tab-এর নিজের কপি) +
`localStorage` (নতুন tab-এ hand-off)। পড়ার সময় আগে sessionStorage, না পেলে
localStorage থেকে নিয়ে sessionStorage-এ promote (`readEither`)। **কেন:** এক
browser-এ দুই tab-এ দুই role খুললে (dev/testing) একটার token অন্যটারটা
overwrite করে দিত — tab-নিজস্ব sessionStorage সেটা আটকায়।

**Storage গুলো origin-প্রতি আলাদা** — তাই website-এ login করলে customer app-এ
আপনা-আপনি login হয় না (এবং উল্টোটাও)। এটা bug না, design — একই Gmail দিয়ে
দুই জায়গাতেই আলাদা করে login করা যায়, account/data একটাই।

---

## 3. API call ও auto-refresh (সব client-এর `api()` helper)

1. প্রতিটা call-এ header: `Authorization: Bearer <access>`।
2. Response **401** হলে (এবং path টা `/api/auth/refresh|logout` না হলে) —
   **single-flight** refresh: একসাথে ১০টা call fail করলেও `/api/auth/refresh`
   মাত্র **একবার** ডাকা হয় (`refreshInflight` promise ভাগাভাগি)।
3. Refresh সফল → নতুন access+refresh save → আগের call **একবার** retry।
4. Refresh ব্যর্থ (৩০ দিন পার / token নষ্ট) → `session.clear()` → UI
   logged-out অবস্থায়, user আবার Google login করবে।

Backend-এর `/api/auth/refresh` **stateless**: বৈধ refresh token দিলেই নতুন pair
দেয়; পুরনো refresh token টা blacklist হয় **না** (মেয়াদ পর্যন্ত বৈধ থাকে)।
তাই একই account-এ **একাধিক device একসাথে login থাকতে পারে — কেউ কাউকে
logout করে দেয় না।** `POST /api/auth/logout` server-এ no-op; আসল logout =
client-এ token মুছে ফেলা।

---

## 4. Login flow (Google OAuth) — আর এখানকার একমাত্র cookie

```
Client                    Backend (api origin)                 Google
  │ GET /api/auth/google/login?role=<r>&app=<a>
  │────────────────────────►│ session cookie-তে state লেখে,
  │                         │ state = "<random>.<app>.<role>"
  │                         │──────── redirect ──────────────►│ consent
  │                         │◄─ GET /api/auth/google/callback ─┤ (state echo)
  │                         │ state যাচাই → Account খোঁজে/বানায়
  │◄─ redirect: {app_origin}/auth/callback#access=…&refresh=…&role=…&registered=0|1
  │ hash থেকে token পড়ে storage-এ save → route
```

- `app` allow-list: `website | mobile-customer | mobile-pharmacy | mobile-rider`
  (`APP_TARGETS`) — callback শেষে token **সেই app-এর নিজের origin**-এ ফেরে।
- **`session` cookie** (signed, api origin): শুধু OAuth state + oauth_role/app
  বহনের জন্য। Production (HTTPS)-এ `SameSite=None; Secure` (Google-এর লম্বা
  redirect chain-এ যাতে না হারায়), local http dev-এ `Lax`।
- **CSRF নিয়ে সত্যিটা:** আমাদের API-তে আলাদা CSRF token **লাগে না** — auth
  যায় `Authorization` header-এ, যেটা অন্য site-এর form/img কখনো পাঠাতে পারে
  না (classic CSRF শুধু cookie-auth-এ কামড়ায়)। আর login flow-টার CSRF রক্ষা
  করে OAuth-এর **`state`** parameter নিজেই। কাজেই "সব form-এ CSRF token"
  জাতীয় requirement এই codebase-এ প্রযোজ্য নয়।
- Token গুলো URL-এর **`#` fragment**-এ ফেরে (query নয়) — fragment server
  log/Referer-এ যায় না।

### One Gmail = One Role (আজীবন)
Registered account ভিন্ন role-এ ঢুকতে চাইলে backend
`/login?error=role_mismatch&have=<আসল>&want=<চাওয়া>` — token ইস্যুই হয় না।

### Role-gate প্রতিটা client-এ
- Customer app: `role !== "customer"` হলে token **save না করেই** `msg=customer-only` বাউন্স।
- Pharmacy/rider app: একই নিয়ম (`msg=wrong-role`)।
- Website: role অনুযায়ী route — customer → `/`, pharmacy → `/pharmacy`, rider → `/rider`।

---

## 5. ২০২৬-০৭-১৬-এর fix: "app-এ কাজ করলে website-এ error" ✅

**সমস্যা যা ছিল:**
1. Login-এ **যে কোনো error** (`role_mismatch`, `oauth_error:mismatching_state`,
   `email_not_verified`…) হলে backend সবসময় **website**-এর `/login`-এ পাঠাত —
   login টা mobile app থেকে শুরু হলেও। ফলে app-এর user হঠাৎ website-এ
   error banner দেখত।
2. চারটা client-ই api origin-এর **একটাই session cookie** শেয়ার করে। এক app-এ
   login শুরু করে অন্যটায় শুরু করলে আগেরটার OAuth state মুছে যায় (authlib
   নিজেই পুরনো state clear করে) → আগের flow টা শেষ করলে
   `mismatching_state` — আর সেই error-ও website-এ যেত। Session-এ রাখা
   `oauth_app` মানটাও পরের flow overwrite করত — মানে সফল login-এর token-ও
   **ভুল app-এ** চলে যেতে পারত।

**Fix (এখনকার আচরণ):**
- `app` + `role` এখন OAuth **state-এর ভিতরে** encode হয়
  (`<random>.<app>.<role>`) — Google state হুবহু ফেরত দেয়, তাই অন্য app-এর
  login শুরু হলেও এই flow-এর app/role আর হারায় না।
- **সব error redirect এখন সেই app-এর নিজের `/login`-এ ফেরে** যেটা থেকে
  login শুরু হয়েছিল; website শুধু website-এর error দেখায়।
- ৩টা mobile app-এর login page-এ `?error=` banner যোগ হয়েছে (role_mismatch
  বাংলা ব্যাখ্যাসহ, `oauth_error:*` হলে "আবার চেষ্টা করুন — এবার হয়ে যাবে")।
- জেনে রাখা ভালো: দুই app-এ **একসাথে** দুটো login মাঝপথে থাকলে আগেরটা এখনো
  fail করবে (shared cookie-তে একটাই state থাকতে পারে) — কিন্তু এখন সেটা
  নিজের app-এই friendly message সহ ফিরবে, আর সাথে সাথে retry করলেই হবে।

---

## 6. Feature-অনুযায়ী টেবিল (আসলটা)

| Feature | কী দিয়ে auth হয় | Website | Mobile app (TWA) | নোট |
|---|---|---|---|---|
| Login | Google OAuth → JWT pair | ✅ | ✅ | Password নেই; app টা `app=` param পাঠায় |
| Dashboard/সব পাতা | Bearer access token | ✅ | ✅ | 401 → auto-refresh → retry |
| Prescription upload | Bearer + private file store | ✅ | ✅ | Sensitive `kind` হলে `/api/files/raw/...` + ১০-মিনিটের signed URL |
| Order tracking (live) | Bearer (polling) | ✅ | ✅ | `/api/conversations/{id}/track` |
| Pharmacy management | Bearer (role=pharmacy) | ✅ | ✅ | Owner হলে storefront location-gate exempt |
| AI quota | Bearer; server-side DB-তে count | ✅ | ✅ | `ai_usage` টেবিল — client-এ শুধু দেখায় |
| Rider offers/earnings | Bearer (role=rider) | ✅ | ✅ | Location `POST /api/rider/me/ping` |
| CSRF token | **নেই — দরকার নেই** | — | — | Header-auth; OAuth `state`-ই login-এর রক্ষা |
| Remember me | **Refresh token-ই (৩০ দিন)** | ✅ | ✅ | Credentials কোথাও store হয় না |
| Analytics cookie | **এখনো নেই** | — | — | GA/Firebase যোগ করলে এই guide আপডেট করতে হবে |
| Logout | Client-side clear | ✅ | ✅ | ৩টা key-ই দুই storage থেকে মুছতে হবে |
| Password reset | **নেই** (password-ই নেই) | — | — | Google account recovery-ই যথেষ্ট |
| Admin desktop | `X-MediDoor-Desktop-Secret` header + allow-listed gmail | — | — | `admin.py` টুল |
| Dev/test login | `POST /api/auth/dev-login` | dev-only | dev-only | `DEBUG=true` + `APP_ENV != production` না হলে 404 |

---

## 7. Troubleshooting

| উপসর্গ | কারণ | করণীয় |
|---|---|---|
| App-এ login করতে গিয়ে **website**-এ error | পুরনো build (fix-এর আগের) | Backend + app deploy করুন — error এখন নিজ app-এ ফেরে |
| `oauth_error:mismatching_state` | অন্য MediDoor app/tab-এ মাঝপথের login এই flow-এর state মুছেছে, বা session cookie হারিয়েছে | ওই app-এ আবার login চাপুন — fresh চেষ্টা সবসময় কাজ করে |
| `role_mismatch` | Gmail টা অন্য role-এ registered | সঠিক role-এর app/section ব্যবহার, বা আলাদা Gmail |
| App-এ login আছে, website-এ নেই | Origin-প্রতি storage আলাদা — স্বাভাবিক | Website-এও একবার Google login করুন (একই account-ই খুলবে) |
| ৩০+ দিন পরে খুলে logged-out | Refresh token মেয়াদোত্তীর্ণ | আবার Google login |
| Private ছবি (Rx/NID) ভাঙা | Signed URL-এর ১০ মিনিট পেরিয়েছে | UI নিজেই নতুন grant নেয়; manually খুললে নতুন করে grant নিন |
| Local dev-এ Google login শেষ হয় না | OAuth client শুধু live hostname-এ registered | `dev-login` bypass ব্যবহার করুন (`knowledge.md` দেখুন) |

---

## 8. নিয়ম (নতুন কোড লেখার সময়)

1. **নতুন cookie যোগ করবেন না** — auth সবসময় Bearer header; cookie-auth যোগ
   করলে তখন সত্যিই CSRF protection লাগবে।
2. Client-এ token ছোঁয়ার দরকার হলে সবসময় `src/lib/api.ts`-এর `session` /
   `api()` helper ব্যবহার করুন — নিজে `localStorage.getItem` লিখবেন না
   (sessionStorage promotion হারাবেন)।
3. Login শুরু করার URL বানাতে সবসময় নিজ app-এর `googleLoginUrl()` — যাতে
   `app=` param ঠিক থাকে এবং error/token নিজ app-এ ফেরে।
4. Token URL-এ পাঠাতে হলে `#fragment`, কখনো `?query` নয়।
5. Sensitive upload (prescription/NID/license/birth_certificate/student_id) →
   `uploadImage(blob, kind)`-এ **kind** দিন, যাতে সেটা private store-এ যায়।
6. মেয়াদ বদলাতে হলে `backend/app/core/config.py`-র
   `ACCESS_TOKEN_EXPIRE_MINUTES` / `REFRESH_TOKEN_EXPIRE_DAYS` — আর এই guide
   আপডেট করুন।
