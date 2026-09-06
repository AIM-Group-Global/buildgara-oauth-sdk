/**
 * Base error for all BuildGara OAuth SDK failures.
 * Each subclass carries a stable `code` string consumers can switch on.
 */
export class SsoError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = this.constructor.name;
    // Ensure proper V8 stack trace capture
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/** Consumer misconfigured the SDK (missing clientId, bad redirectUri, etc.). */
export class ConfigurationError extends SsoError {
  constructor(message: string) {
    super(message, "CONFIGURATION_ERROR");
  }
}

/** The user's browser blocked the popup (popup blocker). */
export class PopupBlockedError extends SsoError {
  constructor() {
    super(
      "The login popup was blocked by your browser. Please allow popups for this site and try again.",
      "POPUP_BLOCKED",
    );
  }
}

/** User clicked Cancel on the BuildGara consent screen. */
export class AccessDeniedError extends SsoError {
  constructor() {
    super("Login cancelled — the user denied access.", "ACCESS_DENIED");
  }
}

/** State mismatch — possible login CSRF. Abort and do not log the user in. */
export class StateMismatchError extends SsoError {
  constructor() {
    super(
      "State mismatch — possible CSRF attack. Aborting login. Please try again.",
      "STATE_MISMATCH",
    );
  }
}

/** The authorization code is expired, already used, or malformed. */
export class InvalidCodeError extends SsoError {
  constructor(message?: string) {
    super(
      message ?? "Authorization code is invalid, expired, or already used.",
      "INVALID_CODE",
    );
  }
}

/** The server-to-server token exchange failed (POST /api/oauth/token). */
export class TokenExchangeError extends SsoError {
  constructor(message: string, public readonly apiErrorCode?: string) {
    super(message, "TOKEN_EXCHANGE_FAILED");
  }
}

/** Fetching UserInfo failed (GET /api/oauth/userinfo). */
export class UserInfoError extends SsoError {
  constructor(message: string, public readonly apiErrorCode?: string) {
    super(message, "USERINFO_FAILED");
  }
}
