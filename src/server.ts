import express from "express";
import type {
  LoginResult,
  OnProfileContext,
  OnProfileResult,
  UserInfo,
} from "./types.js";

type ExpressResponse = express.Response;
type ExpressRequest = express.Request;
type ExpressNextFunction = express.NextFunction;
import {
  AccessDeniedError,
  ConfigurationError,
  InvalidCodeError,
  SsoError,
  StateMismatchError,
  TokenExchangeError,
  UserInfoError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Config for the server-side helper. Needs clientId + clientSecret (both from
 *  the consumer's registered BuildGara Sub-App). */
export interface BuildGaraServerConfig {
  clientId: string;
  clientSecret: string;
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

export interface BuildGaraServer {
  /** Exchange an authorization code + PKCE verifier for tokens + profile.
   *  Calls POST /api/oauth/token then GET /api/oauth/userinfo.
   *  The access_token stays server-side — do NOT send it to the browser. */
  exchangeCode: (code: string, codeVerifier: string) => Promise<ExchangeResult>;

  /** Express middleware for the callback route (Google-style popup callback).
   *  Mount at the consumer's redirectUri path. Parses ?code=&state= from the
   *  URL, verifies state against a cookie the client-side set, exchanges
   *  server-side, calls onProfile, responds with a self-closing HTML page that
   *  postsMessage to the opener and closes itself. */
  callbackHandler: (
    opts: CallbackHandlerOpts,
  ) => (req: ExpressRequest, res: ExpressResponse, next: ExpressNextFunction) => void;
}

export interface CallbackHandlerOpts {
  /** Called after successful token exchange + UserInfo. Consumer upserts a
   *  local user by profile.sub, creates a session, stores accessToken server-side,
   *  and returns whatever to render in the self-closing callback page. */
  onProfile: (
    ctx: OnProfileContext,
  ) => Promise<OnProfileResult> | OnProfileResult;

  /** Optional custom error HTML renderer. Default: plain "login failed" page. */
  renderError?: (
    req: ExpressRequest,
    res: ExpressResponse,
    error: SsoError,
  ) => void;

  /** Optional custom success HTML renderer. Default: minimal page that posts
   *  the result to the opener and closes itself. */
  renderSuccess?: (
    req: ExpressRequest,
    res: ExpressResponse,
    result: LoginResult,
    onProfileReturn: OnProfileResult,
  ) => void;
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function readEnv(name: string, fallback: string): string {
  const val = process.env?.[name];
  if (typeof val === "string" && val) {
    return val.replace(/\/+$/, "");
  }
  return fallback;
}

const DEFAULT_API_BASE = "https://buildgara.com";

// ---------------------------------------------------------------------------
// Cookie names (set by client-side, read by server callbackHandler)
// ---------------------------------------------------------------------------

const STATE_COOKIE_NAME = "buildgara_oauth_state";
const VERIFIER_COOKIE_NAME = "buildgara_oauth_verifier";

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function buildGaraServer(config: BuildGaraServerConfig): BuildGaraServer {
  if (!config.clientId || typeof config.clientId !== "string") {
    throw new ConfigurationError(
      "clientId is required on the server config (e.g. 'bg_client_...').",
    );
  }
  if (!config.clientSecret || typeof config.clientSecret !== "string") {
    throw new ConfigurationError(
      "clientSecret is required on the server config (e.g. 'bg_sec_...'). Server-only — never expose to browser.",
    );
  }

  const apiBase = readEnv("BG_API_BASE", DEFAULT_API_BASE);

  return {
    exchangeCode: (code, codeVerifier) =>
      exchangeCodeInner(
        { apiBase, clientId: config.clientId, clientSecret: config.clientSecret },
        code,
        codeVerifier,
      ),

    callbackHandler: (opts) =>
      callbackHandlerInner(
        { apiBase, clientId: config.clientId, clientSecret: config.clientSecret },
        opts,
      ),
  };
}

// Convenience wrapper — exchange a code with a full config object
export async function exchangeCode(
  config: BuildGaraServerConfig,
  code: string,
  codeVerifier: string,
): Promise<{ profile: UserInfo; accessToken: string; idToken?: string }> {
  const server = buildGaraServer(config);
  return server.exchangeCode(code, codeVerifier);
}

// ---------------------------------------------------------------------------
// Token exchange + UserInfo
// ---------------------------------------------------------------------------

async function exchangeCodeInner(
  ctx: { apiBase: string; clientId: string; clientSecret: string },
  code: string,
  codeVerifier: string,
): Promise<ExchangeResult> {
  if (!code || typeof code !== "string") {
    throw new InvalidCodeError("code is required.");
  }
  if (!codeVerifier || typeof codeVerifier !== "string") {
    throw new InvalidCodeError("codeVerifier is required.");
  }

  // 1. Exchange the authorization code for tokens (server-to-server)
  const tokenRes = await fetch(`${ctx.apiBase}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    const body = await safeJson(tokenRes);
    throw new TokenExchangeError(
      body?.error_description as string ?? `Token exchange failed: ${tokenRes.status}`,
      body?.error as string ?? "TOKEN_EXCHANGE_FAILED",
    );
  }

  const tokenData = await tokenRes.json() as {
    access_token: string;
    token_type: string;
    expires_in: number;
    id_token?: string;
    scope?: string;
  };

  const accessToken = tokenData.access_token;
  if (!accessToken) {
    throw new TokenExchangeError("Token exchange response missing access_token.");
  }

  // 2. Fetch the canonical profile from UserInfo (source of truth for identity)
  const userRes = await fetch(`${ctx.apiBase}/api/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!userRes.ok) {
    const body = await safeJson(userRes);
    throw new UserInfoError(
      body?.error_description as string ?? `UserInfo failed: ${userRes.status}`,
      body?.error as string ?? "USERINFO_FAILED",
    );
  }

  const profile = await userRes.json() as UserInfo;
  if (!profile || typeof profile.sub !== "string") {
    throw new UserInfoError("UserInfo response missing 'sub'.");
  }

  return {
    profile,
    accessToken,
    idToken: tokenData.id_token,
  };
}

// ---------------------------------------------------------------------------
// Callback handler (Express middleware — GET route)
// ---------------------------------------------------------------------------

export function callbackHandlerInner(
  ctx: { apiBase: string; clientId: string; clientSecret: string },
  opts: CallbackHandlerOpts,
): (req: ExpressRequest, res: ExpressResponse, next: ExpressNextFunction) => void {
  return async (req, res, next) => {
    try {
      await handleCallback(req, res, ctx, opts);
    } catch (err) {
      const error =
        err instanceof SsoError
          ? err
          : new SsoError(String(err), "INTERNAL_ERROR");
      if (opts.renderError) {
        opts.renderError(req, res, error);
      } else {
        renderDefaultError(res, error);
      }
    }
  };
}

async function handleCallback(
  req: ExpressRequest,
  res: ExpressResponse,
  ctx: { apiBase: string; clientId: string; clientSecret: string },
  opts: CallbackHandlerOpts,
) {
  const params = req.query as Record<string, string | string[] | undefined>;

  const error = params.error as string | undefined;
  const code = params.code as string | undefined;
  const returnedState = params.state as string | undefined;

  // 1. Check for redirect errors (user denied, etc.)
  if (error) {
    if (error === "access_denied") {
      throw new AccessDeniedError();
    }
    throw new SsoError(
      params.error_description as string ?? `Login failed: ${error}`,
      error,
    );
  }

  if (!code) {
    throw new InvalidCodeError("No authorization code in the callback URL.");
  }

  // 2. Verify state — read the original state from a cookie the client-side set
  //    before opening the popup. The cookie is non-httpOnly (JS-readable) and
  //    short-lived. The server reads it from req.headers.cookie.
  const cookieHeader = req.headers.cookie as string | undefined;
  const cookies = parseCookie(cookieHeader);

  const originalState = cookies[STATE_COOKIE_NAME];
  const codeVerifier = cookies[VERIFIER_COOKIE_NAME];

  if (!originalState) {
    throw new StateMismatchError();
  }

  if (returnedState !== originalState) {
    throw new StateMismatchError();
  }

  if (!codeVerifier) {
    throw new InvalidCodeError(
      "Missing codeVerifier cookie — try logging in again.",
    );
  }

  // 3. Exchange the code server-side
  const exchange = await exchangeCodeInner(ctx, code, codeVerifier);

  // 4. Clear the cookies
  // Clear the flow cookies (client-side set these before opening popup)
  res.clearCookie(STATE_COOKIE_NAME);
  res.clearCookie(VERIFIER_COOKIE_NAME);

  // 5. Call the consumer's onProfile hook
  const onProfileResult = await opts.onProfile({
    profile: exchange.profile,
    accessToken: exchange.accessToken,
    idToken: exchange.idToken,
  });

  // 6. Respond with self-closing HTML that postsMessage to opener + closes
  const result: LoginResult = {
    profile: exchange.profile,
    idToken: exchange.idToken,
  };

  if (opts.renderSuccess) {
    opts.renderSuccess(req, res, result, onProfileResult);
  } else {
    renderDefaultSuccess(res, result, onProfileResult);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeJson(res: Response): Promise<any> {
  try {
    const text = await res.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function renderDefaultError(res: ExpressResponse, error: SsoError) {
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Login Failed</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333;">
  <div style="text-align:center;padding:2rem;">
    <h2>Login Failed</h2>
    <p style="color:#666;">${escapeHtml(error.message)}</p>
    <p style="color:#999;font-size:14px;">Error code: ${escapeHtml(error.code)}</p>
  </div>
</body>
</html>`;
  res.status(400).set("Content-Type", "text/html").send(html);
}

function renderDefaultSuccess(
  res: ExpressResponse,
  result: LoginResult,
  _onProfileReturn: OnProfileResult,
) {
  const payload = JSON.stringify({
    _buildgara: "buildgara-login-result",
    status: "done",
    profile: result.profile,
    idToken: result.idToken,
  });

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Signing in…</title>
  <script>
    (function () {
      try {
        window.opener?.postMessage(${JSON.stringify(payload)}, window.location.origin);
      } catch (e) {
        // ignore
      }
      window.close();
    })();
  <\/script>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fafafa; color: #333; }
    .spinner { width: 32px; height: 32px; border: 3px solid #e5e7eb; border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <p style="margin-top:12px;font-size:14px;color:#666;">Signing you in…</p>
</body>
</html>`;
  res.status(200).set("Content-Type", "text/html").send(html);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseCookie(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}
