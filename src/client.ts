import type { BuildGaraClientConfig, LoginResult, UserInfo } from "./types.js";
import {
  AccessDeniedError,
  ConfigurationError,
  InvalidCodeError,
  PopupBlockedError,
  SsoError,
  StateMismatchError,
  TokenExchangeError,
  UserInfoError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Env helpers (read consumer's BG_WEB_BASE / BG_API_BASE, fallback production)
// ---------------------------------------------------------------------------

function readEnv(names: string | string[], fallback: string): string {
  const nameList = Array.isArray(names) ? names : [names];
  for (const name of nameList) {
    const inline =
      (typeof import.meta !== "undefined"
        ? (import.meta as any).env?.[name]
        : undefined) ??
      (typeof process !== "undefined" ? process.env?.[name] : undefined);
    if (typeof inline === "string" && inline) {
      return inline.replace(/\/+$/, "");
    }
  }
  return fallback;
}

const DEFAULT_WEB_BASE = "https://buildgara.com";
const DEFAULT_API_BASE = "https://api.buildgara.com";

// ---------------------------------------------------------------------------
// Random + base64url
// ---------------------------------------------------------------------------

function randomToken(bytes: number): string {
  const arr = new Uint8Array(bytes);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
  }
  return base64UrlEncode(arr);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[],
    );
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  try {
    if (!globalThis.crypto?.subtle) {
      warnOnce(
        "crypto.subtle unavailable — PKCE (S256) disabled. The flow will still work, but PKCE is strongly recommended.",
      );
      return "";
    }
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(codeVerifier),
    );
    return base64UrlEncode(new Uint8Array(digest));
  } catch {
    warnOnce(
      "Failed to compute PKCE code challenge — PKCE disabled. The flow will still work, but PKCE is strongly recommended.",
    );
    return "";
  }
}

let warnOnceFlag = false;
function warnOnce(msg: string) {
  if (warnOnceFlag) return;
  warnOnceFlag = true;
  // eslint-disable-next-line no-console
  console.warn("[buildgara-oauth-sdk]", msg);
}

// ---------------------------------------------------------------------------
// Storage: localStorage (same-origin shared) + cookies (for server middleware)
// ---------------------------------------------------------------------------

const storageKeyPrefix = "buildgara:sso:";
const stateCookieName = "buildgara_oauth_state";
const verifierCookieName = "buildgara_oauth_verifier";

function storageSave(key: string, value: string) {
  try {
    localStorage.setItem(storageKeyPrefix + key, value);
  } catch {
    /* localStorage unavailable */
  }
}

function storageRead(key: string): string | null {
  try {
    return localStorage.getItem(storageKeyPrefix + key);
  } catch {
    return null;
  }
}

function storageClear(key: string) {
  try {
    localStorage.removeItem(storageKeyPrefix + key);
  } catch {
    /* ignore */
  }
}

function setCookie(name: string, value: string) {
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; expires=${expires}; samesite=lax`;
}

function clearCookies() {
  document.cookie = `${stateCookieName}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  document.cookie = `${verifierCookieName}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

// ---------------------------------------------------------------------------
// Internal state maps
// ---------------------------------------------------------------------------

interface PendingRequest {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  requestId: number;
}

const pendingStore = new Map<number, PendingRequest>();
const popupStore = new Map<number, Window>();
let nextRequestId = 0;

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export interface BuildGaraClient {
  /** Build the authorize URL (does NOT open anything). Requires a pending
   *  request from startLoginPopup() first. */
  buildAuthorizeUrl: (overrideParams?: Record<string, string>) => string;

  /** Start the Google-style popup login flow. Opens a popup to BuildGara's
   *  authorize page. Call waitForPopupResult() afterwards to await the result.
   *  Throws PopupBlockedError if the popup is blocked. */
  startLoginPopup: (
    options?: { width?: number; height?: number },
  ) => Promise<Window | null>;

  /** Await the popup's result. Call after startLoginPopup(). Resolves with
   *  { profile, idToken? } when the popup posts the result message and closes,
   *  or throws on error (AccessDenied, StateMismatch, TokenExchangeFailed, etc.). */
  waitForPopupResult: () => Promise<LoginResult>;

  /** Handle the redirect-flow callback on the consumer's callback page.
   *  Call this on the page at redirectUri after BuildGara redirects back.
   *  Reads state+verifier from localStorage (set by startLoginPopup), verifies
   *  state, then POSTs code+verifier to the consumer's exchange endpoint.
   *  Requires exchangeEndpoint to be configured. */
  handleRedirectCallback: (
    exchangeEndpoint?: string,
  ) => Promise<LoginResult>;
}

export function buildGara(config: BuildGaraClientConfig): BuildGaraClient {
  if (!config.clientId || typeof config.clientId !== "string") {
    throw new ConfigurationError(
      "clientId is required and must be a non-empty string (e.g. 'bg_client_...').",
    );
  }
  if (!config.redirectUri || typeof config.redirectUri !== "string") {
    throw new ConfigurationError(
      "redirectUri is required and must be a non-empty string (e.g. 'https://myapp.com/callback'). It must match one of your registered redirect URIs (origin + pathname).",
    );
  }
  try {
    new URL(config.redirectUri);
  } catch {
    throw new ConfigurationError(
      `redirectUri is not a valid URL: ${config.redirectUri}`,
    );
  }

  const scopes = config.scopes ?? "openid profile email role";
  const webBaseUrl =
    config.webBaseUrl?.replace(/\/+$/, "") ??
    readEnv(["BG_WEB_BASE", "VITE_BG_WEB_BASE", "VITE_BUILDGARA_SSO_URL"], DEFAULT_WEB_BASE);
  const apiBaseUrl =
    config.apiBaseUrl?.replace(/\/+$/, "") ??
    readEnv(["BG_API_BASE", "VITE_BG_API_BASE", "VITE_BUILDGARA_API_URL"], DEFAULT_API_BASE);

  return {
    buildAuthorizeUrl: (overrideParams) =>
      buildAuthorizeUrlInner({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        scopes,
        webBaseUrl,
        pending: currentPending(),
      }, overrideParams),

    startLoginPopup: (options) =>
      startLoginPopupInner({ config, scopes, webBaseUrl, apiBaseUrl }, options),

    waitForPopupResult: () =>
      waitForPopupResultInner({ config, webBaseUrl, apiBaseUrl }),

    handleRedirectCallback: (exchangeEndpoint) =>
      handleRedirectCallbackInner({ config, apiBaseUrl }, exchangeEndpoint),
  };
}

function currentPending(): PendingRequest | undefined {
  const requestId = (window as any).__buildgaraLastRequestId as number | undefined;
  if (requestId == null) return undefined;
  return pendingStore.get(requestId) ?? undefined;
}

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

function buildAuthorizeUrlInner(
  ctx: {
    clientId: string;
    redirectUri: string;
    scopes: string;
    webBaseUrl: string;
    pending: PendingRequest | undefined;
  },
  overrideParams?: Record<string, string>,
): string {
  const pending = ctx.pending;
  if (!pending) {
    throw new ConfigurationError(
      "No pending login request — call startLoginPopup() first.",
    );
  }

  const query = new URLSearchParams({
    client_id: ctx.clientId,
    redirect_uri: ctx.redirectUri,
    response_type: "code",
    scope: ctx.scopes,
    state: pending.state,
    ...(pending.codeChallenge && {
      code_challenge: pending.codeChallenge,
      code_challenge_method: "S256",
    }),
    ...(overrideParams ?? {}),
  });

  return `${ctx.webBaseUrl}/oauth/authorize?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Popup flow
// ---------------------------------------------------------------------------

async function startLoginPopupInner(
  ctx: {
    config: BuildGaraClientConfig;
    scopes: string;
    webBaseUrl: string;
    apiBaseUrl: string;
  },
  options?: { width?: number; height?: number },
): Promise<Window | null> {
  const requestId = ++nextRequestId;
  (window as any).__buildgaraLastRequestId = requestId;

  const pending: PendingRequest = {
    state: randomToken(16),
    codeVerifier: randomToken(48),
    codeChallenge: "",
    requestId,
  };
  pendingStore.set(requestId, pending);

  // PKCE challenge (async — must be in the authorize URL)
  pending.codeChallenge = await computeCodeChallenge(pending.codeVerifier);

  // Persist for callback page — localStorage is same-origin shared across
  // popup + opener.
  storageSave(`req_${requestId}`, JSON.stringify(pending));

  // Also set cookies so the server-side callbackHandler middleware can verify
  // state server-side. Non-httpOnly, same-origin, short-lived.
  setCookie(stateCookieName, pending.state);
  setCookie(verifierCookieName, pending.codeVerifier);

  const url = `${ctx.webBaseUrl}/oauth/authorize?${new URLSearchParams({
    client_id: ctx.config.clientId,
    redirect_uri: ctx.config.redirectUri,
    response_type: "code",
    scope: ctx.scopes,
    state: pending.state,
    ...(pending.codeChallenge && {
      code_challenge: pending.codeChallenge,
      code_challenge_method: "S256",
    }),
  }).toString()}`;

  // Google-style: open about:blank synchronously, then navigate
  const popup = window.open("about:blank", "_blank", popupFeatures(options));

  if (!popup || popup.closed || typeof popup.closed === "undefined") {
    cleanup(requestId);
    throw new PopupBlockedError();
  }

  await sleep(150);

  try {
    popup.location.href = url;
  } catch {
    cleanup(requestId);
    throw new PopupBlockedError();
  }

  popupStore.set(requestId, popup);
  return popup;
}

function popupFeatures(options?: { width?: number; height?: number }): string {
  const w = options?.width ?? 400;
  const h = options?.height ?? 600;
  const left = Math.round(((window.screen?.width ?? 1024) - w) / 2);
  const top = Math.round(((window.screen?.height ?? 768) - h) / 2);
  return [
    `width=${w}`,
    `height=${h}`,
    `left=${left}`,
    `top=${top}`,
    "menubar=no",
    "toolbar=no",
    "location=yes",
    "status=no",
    "resizable=yes",
  ].join(",");
}

// ---------------------------------------------------------------------------
// Wait for popup result
// ---------------------------------------------------------------------------

interface PopupResultMessage {
  _buildgara: string;
  requestId: number;
  status: "done" | "error";
  profile?: UserInfo;
  idToken?: string;
  errorCode?: string;
  error?: string;
}

function waitForPopupResultInner(
  _ctx: {
    config: BuildGaraClientConfig;
    webBaseUrl: string;
    apiBaseUrl: string;
  },
): Promise<LoginResult> {
  return new Promise((resolve, reject) => {
    const requestId = (window as any).__buildgaraLastRequestId as number | undefined;
    if (requestId == null || !pendingStore.has(requestId)) {
      reject(
        new ConfigurationError(
          "No pending login request — call startLoginPopup() first.",
        ),
      );
      return;
    }

    const pending = pendingStore.get(requestId)!;
    const popup = popupStore.get(requestId) ?? null;

    // Already closed? Reject.
    if (popup && popup.closed) {
      cleanup(requestId);
      reject(new StateMismatchError());
      return;
    }

    const expectedOrigin = window.location.origin;

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) return;

      const msg = event.data as PopupResultMessage | null;
      if (!msg || msg._buildgara !== "buildgara-login-result") return;
      if (msg.requestId !== requestId) return;

      cleanup(requestId);

      if (msg.status === "done" && msg.profile) {
        resolve({ profile: msg.profile, idToken: msg.idToken });
      } else {
        reject(mapPopupError(msg.errorCode, msg.error));
      }
    };

    const onPopupClose = () => {
      cleanup(requestId);
      reject(
        new SsoError(
          "The login popup was closed before login completed. Please try again.",
          "POPUP_CLOSED",
        ),
      );
    };

    window.addEventListener("message", onMessage);
    if (popup) popup.addEventListener("close", onPopupClose);

    const timeout = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      if (popup) popup.removeEventListener("close", onPopupClose);
      cleanup(requestId);
      reject(
        new SsoError(
          "The login popup timed out. Please try again.",
          "POPUP_TIMEOUT",
        ),
      );
    }, 10 * 60 * 1000);

    // Expose cancel for advanced use
    (resolve as any)._buildgaraCancel = () => {
      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (popup) popup.removeEventListener("close", onPopupClose);
      cleanup(requestId);
    };
  });
}

function mapPopupError(
  errorCode?: string,
  message?: string,
): Error {
  switch (errorCode) {
    case "ACCESS_DENIED":
      return new AccessDeniedError();
    case "STATE_MISMATCH":
      return new StateMismatchError();
    case "INVALID_CODE":
      return new InvalidCodeError(message);
    case "TOKEN_EXCHANGE_FAILED":
      return new TokenExchangeError(message ?? "Token exchange failed", errorCode);
    case "USERINFO_FAILED":
      return new UserInfoError(message ?? "Failed to fetch user profile", errorCode);
    default:
      return new SsoError(
        message ?? "An error occurred during login.",
        errorCode ?? "UNKNOWN",
      );
  }
}

// ---------------------------------------------------------------------------
// Redirect callback flow
// ---------------------------------------------------------------------------

async function handleRedirectCallbackInner(
  ctx: {
    config: BuildGaraClientConfig;
    apiBaseUrl: string;
  },
  exchangeEndpoint?: string,
): Promise<LoginResult> {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  const code = params.get("code");
  const state = params.get("state");

  // Find the matching pending request by state (the callback page may not
  // share the requestId with the opener — fallback to localStorage scan).
  const pending = findPendingByState(state);

  if (error) {
    if (pending) cleanup(pending.requestId);
    if (error === "access_denied") {
      throw new AccessDeniedError();
    }
    throw new SsoError(
      params.get("error_description") ?? `Login failed: ${error}`,
      error,
    );
  }

  if (!code) {
    throw new InvalidCodeError("No authorization code in the callback URL.");
  }

  if (!pending) {
    throw new ConfigurationError(
      "No pending login request found for this callback. This may not be a BuildGara callback, or the login was not started correctly.",
    );
  }

  if (state !== pending.state) {
    cleanup(pending.requestId);
    throw new StateMismatchError();
  }

  const codeVerifier = pending.codeVerifier;
  cleanup(pending.requestId);

  if (!exchangeEndpoint) {
    throw new ConfigurationError(
      "exchangeEndpoint is required for the redirect flow. Pass the URL of your server route that performs the token exchange (e.g. '/api/auth/buildgara/exchange').",
    );
  }

  const exchange = await exchangeCodeOnServer(
    ctx.apiBaseUrl,
    code,
    codeVerifier,
    ctx.config.clientId,
    ctx.config.redirectUri,
    exchangeEndpoint,
  );
  return { profile: exchange.profile, idToken: exchange.idToken };
}

async function exchangeCodeOnServer(
  apiBaseUrl: string,
  code: string,
  codeVerifier: string,
  clientId: string,
  redirectUri: string,
  exchangeEndpoint: string,
): Promise<{ profile: UserInfo; accessToken: string; idToken?: string }> {
  const res = await fetch(exchangeEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      codeVerifier,
      clientId,
      redirectUri,
    }),
  });

  if (!res.ok) {
    let body: any = {};
    try {
      body = await res.json();
    } catch {
      body = { error_description: `${res.status} ${res.statusText}` };
    }
    throw new TokenExchangeError(
      (body.error_description as string) ??
        `Token exchange failed: ${res.status}`,
      (body.error as string) ?? "TOKEN_EXCHANGE_FAILED",
    );
  }

  const data = await res.json();
  if (!data.profile) {
    throw new TokenExchangeError(
      "Exchange endpoint did not return a profile.",
    );
  }
  return data as { profile: UserInfo; accessToken: string; idToken?: string };
}

/** Find a pending request by state value. First checks the in-memory map,
 *  then scans localStorage (same-origin shared across popup + opener). */
function findPendingByState(state: string | null): PendingRequest | null {
  if (!state) return null;
  for (const pending of pendingStore.values()) {
    if (pending.state === state) return pending;
  }
  // Fallback: scan localStorage
  for (let i = 0; i < 100; i++) {
    const raw = storageRead(`req_${i}`);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as PendingRequest;
      if (parsed.state === state) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup(requestId: number) {
  pendingStore.delete(requestId);
  popupStore.delete(requestId);
  storageClear(`req_${requestId}`);
  clearCookies();
  if ((window as any).__buildgaraLastRequestId === requestId) {
    delete (window as any).__buildgaraLastRequestId;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
