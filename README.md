# buildgara-oauth-sdk

**Login with BuildGara — OAuth 2.0 Authorization Code + PKCE SDK**

Drop-in SDK for web apps and backend services to add **"Login with BuildGara"** (single sign-on / SSO). BuildGara acts as the identity provider (IdP); your app creates its own session from the authenticated user's profile (`sub`).

- **Protocol:** OAuth 2.0 `authorization_code` + [PKCE (S256)](https://www.rfc-editor.org/rfc/rfc7636)
- **Flow:** Google-style popup (or redirect) → consent → callback → server-side token exchange → UserInfo → local session
- **Token lifetime:** Access token **1 hour**, auth code **5 min (single-use)**.
- **Source of truth for identity:** UserInfo endpoint — canonical user profile keyed on `sub`.

---

## Installation

```bash
npm install buildgara-oauth-sdk
# or
bun add buildgara-oauth-sdk
# or
yarn add buildgara-oauth-sdk
```

**Requirements:** Node.js 18+ (uses native `fetch`).

---

## Quickstart Guide

### 1. Register a BuildGara Sub-App

1. Log in to [BuildGara](https://buildgara.com).
2. Go to **Settings → Developer Apps**.
3. Click **Register Sub-App** and fill in your app details & Redirect URIs (e.g. `https://myapp.com/callback`).
4. Save your generated credentials:
   ```env
   CLIENT ID:      bg_client_x1y2z3...
   CLIENT SECRET:  bg_sec_a1b2c3...
   ```

---

### 2. Configure Environment Variables

#### Frontend App (`.env` or `.env.local`)
```env
VITE_BUILDGARA_CLIENT_ID=bg_client_x1y2z3...
VITE_BUILDGARA_REDIRECT_URI=https://myapp.com/callback
```

#### Backend Server (`.env`)
```env
BUILDGARA_CLIENT_ID=bg_client_x1y2z3...
BUILDGARA_CLIENT_SECRET=bg_sec_a1b2c3...
```

---

### 3. Client Integration (Frontend / React / Vue / Vanilla JS)

Initialize `buildGara` client instance:

```ts
// src/lib/sso.ts
import { buildGara } from "buildgara-oauth-sdk";

export const ssoClient = buildGara({
  clientId: import.meta.env.VITE_BUILDGARA_CLIENT_ID,
  redirectUri: import.meta.env.VITE_BUILDGARA_REDIRECT_URI || `${window.location.origin}/callback`,
});
```

Trigger Google-style Popup Login in your UI component:

```tsx
// src/components/LoginButton.tsx
import { useState } from "react";
import { ssoClient } from "../lib/sso";

export function LoginButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSSOLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. Open login popup (manages state & PKCE code verifier)
      await ssoClient.startLoginPopup({ width: 450, height: 600 });

      // 2. Wait for login result message from callback popup
      const { profile } = await ssoClient.waitForPopupResult();

      console.log("Logged in user profile:", profile);
      // Proceed with authenticated app flow
    } catch (err: any) {
      setError(err.message || "SSO Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button onClick={handleSSOLogin} disabled={loading}>
      {loading ? "Signing in..." : "Login with BuildGara"}
    </button>
  );
}
```

---

### 4. Callback Handling Options

You can handle the callback using either **Approach A (Backend Route Controller)** or **Approach B (Express Middleware)**.

#### Approach A: Frontend Callback Page + Backend Controller (Recommended)

**1. Frontend Callback Component (`/callback` page)**

```tsx
// src/pages/SSOCallback.tsx
import { useEffect, useState } from "react";

export function SSOCallback() {
  const [status, setStatus] = useState("Authenticating session...");

  useEffect(() => {
    const runCallback = async () => {
      const code = new URLSearchParams(window.location.search).get("code");
      if (!code) {
        setStatus("Invalid callback code");
        return;
      }

      try {
        // Post authorization code to your backend exchange endpoint
        const res = await fetch("/api/auth/sso-callback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Authentication failed");

        // Notify parent opener window and close popup
        if (window.opener) {
          window.opener.postMessage(
            {
              _buildgara: "buildgara-login-result",
              status: "done",
              profile: data.user,
            },
            window.location.origin
          );
          window.close();
        }
      } catch (err: any) {
        setStatus(err.message);
      }
    };

    runCallback();
  }, []);

  return <div>{status}</div>;
}
```

**2. Backend Exchange Route Controller (Express / Node.js / Bun)**

```ts
// server/controllers/authController.ts
import { buildGaraServer } from "buildgara-oauth-sdk";

const bgServer = buildGaraServer({
  clientId: process.env.BUILDGARA_CLIENT_ID!,
  clientSecret: process.env.BUILDGARA_CLIENT_SECRET!,
});

export async function ssoCallbackController(req: any, res: any) {
  try {
    const { code, code_verifier } = req.body;

    // Exchange authorization code for canonical BuildGara UserInfo
    const { profile, accessToken } = await bgServer.exchangeCode(code, code_verifier || "");

    // Find or create user keyed on stable profile.sub
    let user = await db.user.findUnique({ where: { buildGaraSub: profile.sub } });
    if (!user) {
      user = await db.user.create({
        data: {
          buildGaraSub: profile.sub,
          name: profile.name,
          email: profile.email,
          avatar: profile.avatar,
          role: profile.role,
        },
      });
    }

    // Create session / app token
    const token = generateAppJwt(user);
    return res.json({ success: true, token, user: profile });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "SSO exchange failed" });
  }
}
```

---

#### Approach B: Direct Express Middleware Callback

If your server directly handles the redirect endpoint (e.g. `GET /callback`):

```ts
import { buildGaraServer } from "buildgara-oauth-sdk";

const bgServer = buildGaraServer({
  clientId: process.env.BUILDGARA_CLIENT_ID!,
  clientSecret: process.env.BUILDGARA_CLIENT_SECRET!,
});

app.get(
  "/callback",
  bgServer.callbackHandler({
    onProfile: async ({ profile, accessToken }) => {
      // Upsert local user by profile.sub
      const user = await findOrCreateUser(profile);
      return { success: true, userId: user.id };
    },
  })
);
```

---

## Advanced: Local Development & Custom Environments

By default, the SDK connects automatically to production (`https://buildgara.com` for web login and `https://api.buildgara.com` for API calls).

If you are developing or testing against a local instance of BuildGara, you can override the base URLs via config options or environment variables:

```env
# Frontend .env (Local Dev Override)
VITE_BUILDGARA_SSO_URL=http://localhost:5173
VITE_BUILDGARA_API_URL=http://localhost:5000

# Backend .env (Local Dev Override)
BUILDGARA_API_URL=http://localhost:5000
```

```ts
// Client Config Override
const ssoClient = buildGara({
  clientId: "bg_client_...",
  redirectUri: "http://localhost:5174/callback",
  webBaseUrl: "http://localhost:5173", // optional
  apiBaseUrl: "http://localhost:5000", // optional
});

// Server Config Override
const bgServer = buildGaraServer({
  clientId: "bg_client_...",
  clientSecret: "bg_sec_...",
  apiBaseUrl: "http://localhost:5000", // optional
});
```

---

## API Reference

### `buildGara(config)`

Creates a client-side SSO helper instance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clientId` | `string` | ✅ | Registered client ID (`bg_client_...`) |
| `redirectUri` | `string` | ✅ | Registered redirect callback URL |
| `webBaseUrl` | `string` | ❌ | Optional Web URL override (default `https://buildgara.com`) |
| `apiBaseUrl` | `string` | ❌ | Optional API URL override (default `https://api.buildgara.com`) |
| `scopes` | `string` | ❌ | Scopes requested (default `"openid profile email role"`) |

#### Client Methods

- **`startLoginPopup(options?: { width?: number; height?: number }): Promise<Window | null>`**
  Opens the popup login window and initializes state + PKCE cookies.

- **`waitForPopupResult(): Promise<LoginResult>`**
  Waits for popup completion message and resolves with `{ profile, idToken? }`.

- **`buildAuthorizeUrl(overrideParams?: Record<string, string>): string`**
  Generates the raw authorize URL.

- **`handleRedirectCallback(exchangeEndpoint: string): Promise<LoginResult>`**
  For full-page redirect flow.

---

### `buildGaraServer(config)`

Creates a server-side SSO helper instance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clientId` | `string` | ✅ | Registered client ID (`bg_client_...`) |
| `clientSecret` | `string` | ✅ | Registered client secret (`bg_sec_...`) — **keep server-side** |
| `apiBaseUrl` | `string` | ❌ | Optional API URL override (default `https://api.buildgara.com`) |

#### Server Methods

- **`exchangeCode(code: string, codeVerifier?: string): Promise<ExchangeResult>`**
  Exchanges authorization code for user profile & access token.

- **`callbackHandler(options: CallbackHandlerOpts)`**
  Express GET handler for full-page or popup callback flow.

---

## TypeScript Types

```ts
export interface UserInfo {
  sub: string;                // Stable, unique BuildGara user ID
  name: string;               // Full display name
  preferred_username: string; // Username
  email: string;              // Primary email address
  email_verified: boolean;
  role: string;               // e.g. "admin", "founder", "investor", "provider"
  avatar: string | null;      // Avatar image URL
  country: string;
  city: string;
  is_founder: boolean;
  is_investor: boolean;
  is_provider: boolean;
}

export interface LoginResult {
  profile: UserInfo;
  idToken?: string;
}

export interface ExchangeResult {
  profile: UserInfo;
  accessToken: string;
  idToken?: string;
}
```

---

## Error Handling

All errors extend `SsoError`:

| Error Class | Code | Cause |
|-------------|------|-------|
| `ConfigurationError` | `CONFIGURATION_ERROR` | Missing or invalid `clientId` / `redirectUri` / `clientSecret` |
| `PopupBlockedError` | `POPUP_BLOCKED` | Browser popup blocker prevented opening the login window |
| `AccessDeniedError` | `ACCESS_DENIED` | User cancelled the consent screen |
| `StateMismatchError` | `STATE_MISMATCH` | OAuth state parameter validation failed (anti-CSRF safeguard) |
| `InvalidCodeError` | `INVALID_CODE` | Authorization code expired, missing, or already used |
| `TokenExchangeError` | `TOKEN_EXCHANGE_FAILED` | Code exchange with BuildGara server failed |
| `UserInfoError` | `USERINFO_FAILED` | Fetching user profile failed |

---

## Best Practices & Security

1. **Always key local accounts on `sub`**:
   `sub` is guaranteed to be immutable and unique. Do not use email or username as primary keys because users may update their email or username on BuildGara.

2. **Never expose `clientSecret` in frontend code**:
   `clientSecret` must only be configured on your backend server.

3. **Validate `redirectUri`**:
   The `redirectUri` sent during login must match the exact string registered in BuildGara Developer Settings.

---

## License

[MIT License](LICENSE) © BuildGara
