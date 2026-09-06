/**
 * BuildGara UserInfo — the canonical profile returned from
 * GET /api/oauth/userinfo (Bearer access token).
 *
 * Source of truth for identity. The id_token is HS256-signed with a
 * symmetric secret third parties cannot verify, so treat it as
 * informational only (see docs/login-with-buildgara.md §6.4).
 */
export interface UserInfo {
  /** Stable, unique BuildGara user id. Key your local user on this — not email/username. */
  sub: string;
  /** Display name (fullName). */
  name: string;
  /** Username (may change — don't key accounts on it). */
  preferred_username: string;
  /** Verified primary email. */
  email: string;
  email_verified: boolean;
  /** Current role: admin | founder | investor | provider | ... */
  role: string;
  /** Avatar URL or null. */
  avatar: string | null;
  country: string;
  city: string;
  is_founder: boolean;
  is_investor: boolean;
  is_provider: boolean;
}

/** What waitForPopupResult / handleRedirectCallback resolve with. */
export interface LoginResult {
  profile: UserInfo;
  /** Informational only — HS256 with a symmetric secret you can't verify.
   *  Do NOT use this for authentication; use UserInfo via the server-side
   *  exchange instead. Present only when the server included it. */
  idToken?: string;
}

/** Config for the browser-side client. */
export interface BuildGaraClientConfig {
  /** Your registered BuildGara Sub-App client id (bg_client_...). */
  clientId: string;
  /** One of your registered redirect URIs (origin + pathname must match exactly). */
  redirectUri: string;
  /** Optional custom scope string. Default: "openid profile email role". */
  scopes?: string;
}

/** Config for the server-side helper. */
export interface BuildGaraServerConfig {
  /** Your registered Sub-App client secret (bg_sec_...). Server-only — never send to browser. */
  clientSecret: string;
}

/** Shape the consumer's onProfile hook returns — opaque to the library,
 *  passed back to the self-closing callback page so it can render a minimal
 *  "done" status. Most consumers just return { ok: true } or a session id. */
export type OnProfileResult = unknown;

/** Shape the consumer's onProfile hook receives. */
export interface OnProfileContext {
  profile: UserInfo;
  /** Server-side only. Keep it server-side (encrypted / memory / DB) —
   *  do NOT echo it back to the browser. Lifetime: 1 hour. No refresh token. */
  accessToken: string;
  /** Informational only (HS256, symmetric secret). */
  idToken?: string;
}

/** Result of exchangeCode / callbackHandler's onProfile. */
export interface ExchangeResult {
  profile: UserInfo;
  /** Server-side only. Keep it server-side — do NOT send to browser.
   *  Lifetime: 1 hour. No refresh token is issued. */
  accessToken: string;
  /** Informational only (HS256, symmetric secret — can't verify yourself). */
  idToken?: string;
}
