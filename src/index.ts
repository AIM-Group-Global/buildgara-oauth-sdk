/**
 * @buildgara/oauth-sdk — Login with BuildGara
 *
 * OAuth 2.0 Authorization Code + PKCE SDK for third-party apps.
 * BuildGara acts as the identity provider (IdP); your app creates its own
 * session from the profile's `sub` after login.
 *
 * @example Popup flow (React / any SPA)
 * ```ts
 * import { buildGara } from "@buildgara/oauth-sdk";
 *
 * const bg = buildGara({
 *   clientId: import.meta.env.BG_CLIENT_ID,
 *   redirectUri: "https://myapp.com/callback",
 * });
 *
 * await bg.startLoginPopup();
 * const { profile } = await bg.waitForPopupResult();
 * // → create your own session from profile.sub
 * ```
 *
 * @example Server-side exchange (Express)
 * ```ts
 * import { buildGaraServer } from "@buildgara/oauth-sdk";
 *
 * const bgServer = buildGaraServer({
 *   clientId: process.env.BG_CLIENT_ID!,
 *   clientSecret: process.env.BG_CLIENT_SECRET!,
 * });
 *
 * app.get("/callback", bgServer.callbackHandler({
 *   onProfile: async ({ profile, accessToken }) => {
 *     const user = await upsertUserBySub(profile.sub, profile);
 *     return { ok: true };
 *   },
 * }));
 * ```
 */

// --- Client (browser) ---

export { buildGara } from "./client.js";
export type { BuildGaraClient } from "./client.js";
export type { BuildGaraClientConfig } from "./types.js";

// --- Server (Node / Express) ---

export { buildGaraServer, exchangeCode } from "./server.js";
export type { BuildGaraServer, BuildGaraServerConfig, CallbackHandlerOpts, ExchangeResult } from "./server.js";

// --- Shared types ---

export type { UserInfo, LoginResult, OnProfileContext, OnProfileResult } from "./types.js";

// --- Errors ---

export {
  SsoError,
  ConfigurationError,
  PopupBlockedError,
  AccessDeniedError,
  StateMismatchError,
  InvalidCodeError,
  TokenExchangeError,
  UserInfoError,
} from "./errors.js";
