# @buildgara/oauth-sdk

**Login with BuildGara — OAuth 2.0 Authorization Code + PKCE SDK**

Drop-in SDK for third-party apps that want to add **“Login with BuildGara”** (single sign-on). BuildGara acts as the identity provider (IdP); your app creates its own session from the profile’s `sub` after login.

- **Protocol:** OAuth 2.0 `authorization_code` + [PKCE (S256)](https://www.rfc-editor.org/rfc/rfc7636)
- **Flow:** Google-style popup (or redirect) → consent → callback → server-side token exchange → UserInfo → your session
- **Token lifetime:** access token **1 hour**, auth code **5 min, single-use**. **No refresh token** is issued.
- **Source of truth for identity:** UserInfo endpoint — the `id_token` is HS256-signed with a symmetric secret you can’t verify, so treat it as informational only.

> 📘 For the full protocol reference, error codes, security checklist, and troubleshooting, see the [BuildGara SSO Integration Guide](https://github.com/buildgara/buildgara-main/blob/main/docs/login-with-buildgara.md).

---

## Installation

```bash
npm install @buildgara/oauth-sdk
```

**Peer dependencies:** None required at install time. The server helper uses Express types optionally — install `express` if you use the callback handler middleware.

**Node version:** 18+ (uses native `fetch`).

---

## Quickstart (popup flow — Google-style)

### 1. Register a BuildGara Sub-App

1. Log in to BuildGara.
2. Go to **Settings → Developer Apps**.
3. Click **Register Sub-App** and fill in:
   - **App Name** — shown to users on the consent screen.
   - **Redirect URIs** — where users land after login, e.g. `https://myapp.com/callback`, `http://localhost:3000/callback`.
4. Save the credentials shown **once**:
   ```
   CLIENT ID:      bg_client_a1b2c3d4e5f6g7h8i9j0k1l
   CLIENT SECRET:  bg_sec_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

### 2. Configure environment variables

In your app’s environment (`.env` or your hosting platform):

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `BG_CLIENT_ID` | ✅ | — | Your `bg_client_...` id (browser + server) |
| `BG_CLIENT_SECRET` | ✅ (server) | — | Your `bg_sec_...` secret (server-only) |
| `BG_WEB_BASE` | ❌ | `https://buildgara.com` | BuildGara web base (authorize page) |
| `BG_API_BASE` | ❌ | `https://buildgara.com` | BuildGara API base (`/api/oauth/*`) |
| `BG_REDIRECT_URI` | ❌ (if passed to config) | — | Your callback URL (usually passed to the client config) |

> **Local development:** set `BG_WEB_BASE=http://localhost:5173` and `BG_API_BASE=http://localhost:5000` to point at a local BuildGara instance. See [Local development](#local-development).

### 3. Browser-side — start the popup login

```ts
// src/auth.ts (or wherever you configure the SDK)
import { buildGara } from "@buildgara/oauth-sdk";

export const bg = buildGara({
  clientId: import.meta.env.BG_CLIENT_ID,
  redirectUri: "https://myapp.com/callback", // must be registered on your Sub-App
  // scopes: "openid profile email role", // optional, default is "openid profile email role"
});
```

```tsx
// src/components/LoginButton.tsx (React example)
import { useState } from "react";
import { bg } from "../auth";
import type { UserInfo } from "@buildgara/oauth-sdk";

export function LoginButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. Open the popup (library manages state + PKCE internally)
      await bg.startLoginPopup({ width: 400, height: 600 });

      // 2. Wait for the popup to complete and post the result back
      const { profile } = await bg.waitForPopupResult();

      // 3. Create your own session from profile.sub
      await createMySession(profile);
      navigate("/dashboard");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button onClick={handleLogin} disabled={loading}>
      {loading ? "Signing in…" : "Login with BuildGara"}
    </button>
  );
}
```

### 4. Server-side — handle the callback (Express)

The popup is redirected to your `redirectUri` (`https://myapp.com/callback`). Mount the callback handler there:

```ts
// server/routes/auth.ts (Express)
import { buildGaraServer } from "@buildgara/oauth-sdk";

const bgServer = buildGaraServer({
  clientId: process.env.BG_CLIENT_ID!,
  clientSecret: process.env.BG_CLIENT_SECRET!,
  // BG_API_BASE env var or default https://buildgara.com
});

// The callback route — matches your redirectUri
app.get("/callback", bgServer.callbackHandler({
  onProfile: async ({ profile, accessToken, idToken }) => {
    // 🔑 Create or update your local user by profile.sub (NOT by email)
    const user = await upsertUserBySub(profile.sub, profile);

    // 🔐 Store accessToken server-side if you want to call BuildGara APIs
    // on behalf of the user. Lifetime: 1 hour. No refresh token.
    await saveAccessToken(user.id, accessToken);

    // Create your own session cookie
    return { sessionId: createSessionCookie(user) };
  },
}));
```

**How it works:**
1. The client-side `startLoginPopup()` sets cookies (`buildgara_oauth_state`, `buildgara_oauth_verifier`) before opening the popup.
2. BuildGara redirects the popup to your `/callback?code=...&state=...`.
3. The `callbackHandler` middleware reads the state from the cookie, verifies it matches, exchanges the code server-side (POST `/api/oauth/token` with your `client_secret`), fetches UserInfo, and calls your `onProfile` hook.
4. The middleware responds with a self-closing HTML page that posts the result message to the opener window and closes itself.
5. The opener’s `waitForPopupResult()` resolves with `{ profile, idToken? }`.

### 5. Create your own session

```ts
async function createMySession(profile: UserInfo) {
  // Upsert your local user by profile.sub (stable, unique BuildGara user id)
  let user = await db.users.findUnique({ where: { buildGaraSub: profile.sub } });
  if (!user) {
    user = await db.users.create({
      data: {
        buildGaraSub: profile.sub,
        name: profile.name,
        email: profile.email,
        avatarUrl: profile.avatar,
        role: profile.role,
      },
    });
  } else {
    // Optionally update display fields
    await db.users.update({
      where: { id: user.id },
      data: { name: profile.name, avatarUrl: profile.avatar },
    });
  }

  // Create your own session (cookie, JWT, whatever you use)
  await createSession(user.id);
}
```

> ⚠️ **Key your local users on `sub`, not email or username.** `sub` is stable and unique; emails/usernames can change. See [guide §6.5](https://github.com/buildgara/buildgara-main/blob/main/docs/login-with-buildgara.md#65-create-your-session).

---

## API Reference

### Browser-side client

```ts
import { buildGara } from "@buildgara/oauth-sdk";

const bg = buildGara({
  clientId: string,       // required — your bg_client_...
  redirectUri: string,    // required — must match a registered redirect URI
  scopes?: string,        // optional — default "openid profile email role"
});
```

#### `bg.buildAuthorizeUrl(overrideParams?)`

Returns the full authorize URL (does NOT open anything). Useful for the redirect flow or for debugging.

```ts
const url = bg.buildAuthorizeUrl();
// → https://buildgara.com/oauth/authorize?client_id=...&redirect_uri=...&response_type=code&scope=...&state=...&code_challenge=...&code_challenge_method=S256
```

#### `bg.startLoginPopup(options?)`

Opens a popup to BuildGara’s authorize page. The library manages `state` + PKCE `codeVerifier` internally (stored in localStorage + cookies). Returns the popup `Window` reference, or throws `PopupBlockedError` if the popup is blocked.

```ts
const popup = await bg.startLoginPopup({ width: 400, height: 600 });
```

After calling this, call `waitForPopupResult()`.

#### `bg.waitForPopupResult()`

Awaits the popup’s result message. Resolves with `{ profile: UserInfo, idToken?: string }` when the popup completes successfully, or throws on error:

| Error | Meaning |
|-------|---------|
| `PopupBlockedError` | The browser blocked the popup |
| `AccessDeniedError` | User clicked Cancel on the consent screen |
| `StateMismatchError` | State mismatch — possible CSRF; abort login |
| `InvalidCodeError` | Code expired, reused, or malformed |
| `TokenExchangeError` | Server-side token exchange failed |
| `UserInfoError` | UserInfo fetch failed |

```ts
const { profile, idToken } = await bg.waitForPopupResult();
// → create your own session from profile.sub
```

> ⚠️ **The access token is NOT returned to the browser.** It stays server-side in the `callbackHandler`’s `onProfile` hook. Do not echo it back to the browser. See [guide §6.5](https://github.com/buildgara/buildgara-main/blob/main/docs/login-with-buildgara.md#65-create-your-session).

#### `bg.handleRedirectCallback(exchangeEndpoint)`

For the **redirect flow** (alternative to popup). Call this on the consumer’s callback page (the page at `redirectUri`). Reads `state` + `codeVerifier` from localStorage (set by `startLoginPopup`), verifies state, then POSTs `code` + `codeVerifier` to the consumer’s exchange endpoint.

```ts
// On the callback page (https://myapp.com/callback)
const { profile } = await bg.handleRedirectCallback("/api/auth/buildgara/exchange");
```

The exchange endpoint should call the server-side `exchangeCode()` (see below) and return `{ profile, accessToken, idToken? }`.

### Server-side helper

```ts
import { buildGaraServer, exchangeCode } from "@buildgara/oauth-sdk";

const bgServer = buildGaraServer({
  clientId: string,        // required — your bg_client_...
  clientSecret: string,   // required — your bg_sec_... (server-only!)
});
```

#### `bgServer.exchangeCode(code, codeVerifier)`

Exchanges an authorization code for tokens + profile. Calls `POST /api/oauth/token` then `GET /api/oauth/userinfo`. Returns:

```ts
{
  profile: UserInfo;       // canonical profile from UserInfo
  accessToken: string;     // 1-hour Bearer token — keep server-side
  idToken?: string;        // informational only (HS256, symmetric secret)
}
```

```ts
// Express route: consumer's exchange endpoint (called by handleRedirectCallback)
app.post("/api/auth/buildgara/exchange", async (req, res) => {
  const { code, codeVerifier } = req.body;
  const { profile, accessToken } = await bgServer.exchangeCode(code, codeVerifier);

  // Upsert local user by profile.sub, create session, store accessToken server-side
  const user = await upsertUserBySub(profile.sub, profile);
  res.json({ ok: true });
});
```

#### `bgServer.callbackHandler(opts)`

Express middleware for the callback route (Google-style popup callback). Mount at your `redirectUri` path. Parses `?code=&state=` from the URL, verifies state against a cookie the client-side set, exchanges server-side, calls `onProfile`, and responds with a self-closing HTML page that posts the result message to the opener and closes itself.

```ts
app.get("/callback", bgServer.callbackHandler({
  onProfile: async ({ profile, accessToken }) => {
    const user = await upsertUserBySub(profile.sub, profile);
    await saveAccessToken(user.id, accessToken);
    return { ok: true };
  },
  // Optional: custom error / success renderers
  renderError: (req, res, error) => { /* custom error page */ },
  renderSuccess: (req, res, result, onProfileReturn) => { /* custom success page */ },
}));
```

### Types

```ts
interface UserInfo {
  sub: string;                // stable, unique BuildGara user id — key local users on this
  name: string;               // display name (fullName)
  preferred_username: string; // username (may change — don't key accounts on it)
  email: string;              // verified primary email
  email_verified: boolean;
  role: string;               // admin | founder | investor | provider | ...
  avatar: string | null;
  country: string;
  city: string;
  is_founder: boolean;
  is_investor: boolean;
  is_provider: boolean;
}

interface LoginResult {
  profile: UserInfo;
  idToken?: string;           // informational only — don't use for auth
}
```

### Errors

All errors extend `SsoError { message: string; code: string }`:

| Error class | `code` | When |
|-------------|--------|------|
| `ConfigurationError` | `CONFIGURATION_ERROR` | Missing/invalid clientId, redirectUri, etc. |
| `PopupBlockedError` | `POPUP_BLOCKED` | Browser blocked the popup |
| `AccessDeniedError` | `ACCESS_DENIED` | User cancelled consent |
| `StateMismatchError` | `STATE_MISMATCH` | State mismatch — possible CSRF |
| `InvalidCodeError` | `INVALID_CODE` | Code expired/reused/malformed |
| `TokenExchangeError` | `TOKEN_EXCHANGE_FAILED` | `/api/oauth/token` failed |
| `UserInfoError` | `USERINFO_FAILED` | `/api/oauth/userinfo` failed |

```ts
import {
  SsoError,
  AccessDeniedError,
  StateMismatchError,
  TokenExchangeError,
} from "@buildgara/oauth-sdk";

try {
  await bg.waitForPopupResult();
} catch (err) {
  if (err instanceof AccessDeniedError) {
    // User cancelled — show "login cancelled" message
  } else if (err instanceof StateMismatchError) {
    // Possible CSRF — abort and log
    console.error("State mismatch — possible attack");
  } else if (err instanceof SsoError) {
    // Other SSO error
    console.error(err.code, err.message);
  } else {
    // Unexpected error
    console.error(err);
  }
}
```

---

## Popup vs redirect flow

| | Popup (default) | Redirect |
|---|---|---|
| UX | Popup opens, user logs in, popup closes, main page updates | Main page navigates to BuildGara, redirects back |
| State storage | localStorage + cookies (library-managed) | localStorage (library-managed) |
| Callback | `callbackHandler` middleware (server) | Consumer’s callback page calls `handleRedirectCallback(exchangeEndpoint)` |
| Best for | SPAs (React/Vue/Angular) that don’t want a page reload | Traditional server-rendered apps, or when popups are problematic |

### Popup flow (recommended for SPAs)

```ts
await bg.startLoginPopup();
const { profile } = await bg.waitForPopupResult();
```

### Redirect flow (alternative)

```ts
// 1. Redirect the browser
window.location.href = bg.buildAuthorizeUrl();

// 2. On the callback page (at redirectUri):
const { profile } = await bg.handleRedirectCallback("/api/auth/buildgara/exchange");
```

The redirect flow requires the consumer to:
1. Mount `bgServer.callbackHandler()` at the `redirectUri` path (or write their own callback page that calls `exchangeCode()` server-side).
2. Pass the exchange endpoint URL to `handleRedirectCallback()`.

---

## Local development

### 1. Start a local BuildGara instance

Run the BuildGara backend and frontend locally:

```bash
# Backend
cd buildgara-main/backend
cp .env.example .env   # fill DB_* , JWT_SECRET, JWT_REFRESH_SECRET, etc.
npm install
npm run dev            # → http://localhost:5000

# Frontend
cd ../frontend
npm install
npm run dev            # → http://localhost:5173
```

### 2. Register a test Sub-App

1. Open `http://localhost:5173` and log in.
2. Go to **Settings → Developer Apps**.
3. Register a test app with redirect URI `http://localhost:3000/callback` (or your dev server’s callback URL).
4. Save the `client_id` and `client_secret`.

### 3. Configure your test app’s env

```bash
BG_CLIENT_ID=bg_client_...
BG_CLIENT_SECRET=bg_sec_...
BG_WEB_BASE=http://localhost:5173
BG_API_BASE=http://localhost:5000
```

### 4. Test the flow

```ts
const bg = buildGara({
  clientId: process.env.BG_CLIENT_ID!,
  redirectUri: "http://localhost:3000/callback",
});

await bg.startLoginPopup();
const { profile } = await bg.waitForPopupResult();
console.log(profile); // → { sub: "...", name: "...", email: "...", ... }
```

---

## Security checklist

Follow the [full checklist from the guide](https://github.com/buildgara/buildgara-main/blob/main/docs/login-with-buildgara.md#9-security-checklist):

1. ✅ Always generate & verify `state` — **done by the library**
2. ✅ Use PKCE (S256) on every request — **done by the library**
3. ✅ Keep `client_secret` server-side only — **consumer must not expose it to the browser**
4. ✅ Exchange the code once, immediately — **done by the library**
5. ✅ Validate `redirect_uri` on your side too — **register it in BuildGara and pass the same to the client config**
6. ✅ Key local users on `sub`, not email/username — **documented above**
7. ✅ Treat `id_token` as informational; verify identity via UserInfo — **done by the library (UserInfo is the source of truth)**
8. ✅ Store `access_token` server-side — **consumer must not send it to the browser**
9. ✅ Handle re-auth after 1 hour — **no refresh token; re-run the login flow silently**
10. ✅ Log consent failures and state mismatches — **catch the typed errors**

---

## FAQ

**Does “Login with BuildGara” give me the user’s password?**
No — you only ever receive an authorization code, then tokens and profile data.

**How long do tokens last? Can I refresh them?**
Auth codes: 5 minutes, single-use. Access tokens: 1 hour. **No refresh tokens are issued** — after expiry, re-run the login flow (silent re-login is natural since the user is usually still signed in to BuildGara).

**What identifies a user uniquely over time?**
`sub` from UserInfo — a stable internal id. `preferred_username`/`email` may change.

**Do I need to show a consent screen to my users?**
BuildGara shows it automatically for non-trusted apps. Trusted (official) apps are auto-approved. Ask a BuildGara admin to mark your app as Trusted in Admin → SSO Sub-Applications if you want to skip the consent screen.

**Can I skip PKCE?**
The server only *requires* `code_verifier` when a `code_challenge` was sent, so a no-PKCE flow technically works — but it’s strongly discouraged. The library always sends PKCE when `crypto.subtle` is available.

**What about logout?**
Implement logout in your own app. BuildGara has no cross-app logout broadcast; a user signing out of BuildGara doesn’t sign them out of your app and vice versa. If you want to also log the user out of BuildGara, link them to BuildGara’s logout and re-run the flow on next login.

**Where can I see a reference implementation?**
The [BuildGara Digital Identity app](https://github.com/buildgara/buildgara-digital-identity) is a working reference implementation of this exact flow.

**Can I use this without Express?**
Yes. The `buildGaraServer().exchangeCode()` function is framework-agnostic — it just returns `{ profile, accessToken, idToken }`. Only `callbackHandler()` is Express-specific (and you don’t have to use it — you can write your own callback route that calls `exchangeCode()`).

**Why doesn’t `waitForPopupResult()` return the access token?**
Per [guide §6.5](https://github.com/buildgara/buildgara-main/blob/main/docs/login-with-buildgara.md#65-create-your-session), the access token should stay server-side. The `callbackHandler`’s `onProfile` hook receives it server-side so you can store it there. Returning it to the browser would expose it to XSS.

---

## License

Proprietary — @buildgara/oauth-sdk is part of the BuildGara platform. Do not redistribute.
