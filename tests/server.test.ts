import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch globally
vi.stubGlobal("fetch", vi.fn());

// Mock express types for test handles
class MockExpressResponse {
  statusCode = 200;
  private _headers = new Map<string, string>();
  private _body = "";

  status(code: number) { this.statusCode = code; return this; }
  set(key: string, value: string) { this._headers.set(key, value); return this; }
  send(body: string) { this._body = body; return this; }
  clearCookie(name: string) { /* no-op for tests */ }
  getHeader(key: string) { return this._headers.get(key); }
}

class MockExpressRequest {
  query = {} as Record<string, string | string[]>;
  headers = { cookie: undefined as string | undefined };
}

describe("buildGaraServer — configuration", () => {
  it("throws ConfigurationError when clientSecret is missing", async () => {
    const { buildGaraServer } = await import("../src/server.ts");
    // @ts-expect-error — testing invalid config
    expect(() => buildGaraServer({ clientId: "bg_client_x" })).toThrow(
      "clientSecret is required on the server config",
    );
  });

  it("throws ConfigurationError when clientId is missing", async () => {
    const { buildGaraServer } = await import("../src/server.ts");
    // @ts-expect-error — testing invalid config
    expect(() => buildGaraServer({ clientSecret: "bg_sec_x" })).toThrow(
      "clientId is required on the server config",
    );
  });
});

describe("exchangeCode — token exchange + UserInfo", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("exchanges a code and returns profile + accessToken", async () => {
    const { buildGaraServer } = await import("../src/server.ts");

    const tokenJson = JSON.stringify({
      access_token: "access_token_abc",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: "id_token_xyz",
      scope: "openid profile email role",
    });
    const profileJson = JSON.stringify({
      sub: "42",
      name: "Anisha Sharma",
      preferred_username: "anisha",
      email: "anisha@example.com",
      email_verified: true,
      role: "founder",
      avatar: null,
      country: "Nepal",
      city: "Kathmandu",
      is_founder: true,
      is_investor: false,
      is_provider: false,
    });

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => JSON.parse(tokenJson),
      text: async () => tokenJson,
    } as unknown as Response);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => JSON.parse(profileJson),
      text: async () => profileJson,
    } as Response);

    const server = buildGaraServer({
      clientId: "bg_client_test123",
      clientSecret: "bg_sec_secret456",
    });

    const result = await server.exchangeCode("bg_code_abc123", "verifier_xyz");

    expect(result.profile.sub).toBe("42");
    expect(result.profile.email).toBe("anisha@example.com");
    expect(result.accessToken).toBe("access_token_abc");
    expect(result.idToken).toBe("id_token_xyz");

    // Verify token endpoint was called with correct params
    expect(fetch).toHaveBeenNthCalledWith(1, expect.stringContaining("/api/oauth/token"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: "bg_code_abc123",
        client_id: "bg_client_test123",
        client_secret: "bg_sec_secret456",
        code_verifier: "verifier_xyz",
      }),
    });

    // Verify UserInfo endpoint was called with the access token
    expect(fetch).toHaveBeenNthCalledWith(2, expect.stringContaining("/api/oauth/userinfo"), {
      headers: { Authorization: "Bearer access_token_abc" },
    });
  });

  it("throws InvalidCodeError when code is missing", async () => {
    const { buildGaraServer } = await import("../src/server.ts");
    const server = buildGaraServer({
      clientId: "bg_client_test123",
      clientSecret: "bg_sec_secret456",
    });

    await expect(
      server.exchangeCode("", "verifier_xyz"),
    ).rejects.toThrow("code is required");
  });

  it("throws TokenExchangeError when token endpoint returns 400", async () => {
    const { buildGaraServer } = await import("../src/server.ts");

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "invalid_grant",
        error_description: "Authorization code has expired",
      }),
      text: async () => JSON.stringify({ error: "invalid_grant", error_description: "Authorization code has expired" }),
    } as unknown as Response);

    const server = buildGaraServer({
      clientId: "bg_client_test123",
      clientSecret: "bg_sec_secret456",
    });

    await expect(
      server.exchangeCode("bg_code_expired", "verifier_xyz"),
    ).rejects.toMatchObject({ code: "TOKEN_EXCHANGE_FAILED" });
  });

  it("throws UserInfoError when UserInfo endpoint returns 401", async () => {
    const { buildGaraServer } = await import("../src/server.ts");

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "access_token_abc",
        token_type: "Bearer",
        expires_in: 3600,
      }),
      text: async () => JSON.stringify({ access_token: "access_token_abc" }),
    } as unknown as Response);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({
        error: "invalid_token",
        error_description: "Token is invalid or expired",
      }),
      text: async () => JSON.stringify({ error: "invalid_token", error_description: "Token is invalid or expired" }),
    } as unknown as Response);

    const server = buildGaraServer({
      clientId: "bg_client_test123",
      clientSecret: "bg_sec_secret456",
    });

    await expect(
      server.exchangeCode("bg_code_abc", "verifier_xyz"),
    ).rejects.toMatchObject({ code: "USERINFO_FAILED" });
  });
});

describe("callbackHandler — middleware", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("responds with self-closing HTML on success", async () => {
    const { buildGaraServer } = await import("../src/server.ts");

    const tokenJson = JSON.stringify({
      access_token: "access_token_abc",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: "id_token_xyz",
    });
    const profileJson = JSON.stringify({
      sub: "42",
      name: "Anisha Sharma",
      preferred_username: "anisha",
      email: "anisha@example.com",
      email_verified: true,
      role: "founder",
      avatar: null,
      country: "Nepal",
      city: "Kathmandu",
      is_founder: true,
      is_investor: false,
      is_provider: false,
    });

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => JSON.parse(tokenJson),
      text: async () => tokenJson,
    } as unknown as Response);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => JSON.parse(profileJson),
      text: async () => profileJson,
    } as Response);

    const server = buildGaraServer({
      clientId: "bg_client_test123",
      clientSecret: "bg_sec_secret456",
    });

    const req = new MockExpressRequest();
    req.query = { code: "bg_code_abc123", state: "state_abc" };
    req.headers.cookie = "buildgara_oauth_state=state_abc; buildgara_oauth_verifier=verifier_xyz";

    const res = new MockExpressResponse();
    const onProfile = vi.fn().mockResolvedValue({ ok: true });

    const handler = server.callbackHandler({ onProfile });
    await handler(req as any, res as any, vi.fn());

    expect(onProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ sub: "42" }),
        accessToken: "access_token_abc",
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res._body).toContain("Signing you in");
    expect(res._body).toContain("buildgara-login-result");
    expect(res._body).toContain("window.close()");
    expect(res._body).toContain("window.opener");
  });

  it("responds with error HTML on access_denied", async () => {
    const { buildGaraServer } = await import("../src/server.ts");

    const server = buildGaraServer({
      clientId: "bg_client_test123",
      clientSecret: "bg_sec_secret456",
    });

    const req = new MockExpressRequest();
    req.query = {
      error: "access_denied",
      error_description: "User denied access",
    };

    const res = new MockExpressResponse();
    const handler = server.callbackHandler({ onProfile: vi.fn() });
    await handler(req as any, res as any, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res._body).toContain("Login Failed");
    expect(res._body).toContain("ACCESS_DENIED");
  });

  it("responds with error HTML on state mismatch", async () => {
    const { buildGaraServer } = await import("../src/server.ts");

    const tokenJson = JSON.stringify({
      access_token: "access_token_abc",
      token_type: "Bearer",
      expires_in: 3600,
    });
    const profileJson = JSON.stringify({
      sub: "42",
      name: "Anisha Sharma",
      preferred_username: "anisha",
      email: "anisha@example.com",
      email_verified: true,
      role: "founder",
      avatar: null,
      country: "Nepal",
      city: "Kathmandu",
      is_founder: true,
      is_investor: false,
      is_provider: false,
    });

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => JSON.parse(tokenJson),
      text: async () => tokenJson,
    } as unknown as Response);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => JSON.parse(profileJson),
      text: async () => profileJson,
    } as Response);

    const server = buildGaraServer({
      clientId: "bg_client_test123",
      clientSecret: "bg_sec_secret456",
    });

    const req = new MockExpressRequest();
    req.query = { code: "bg_code_abc123", state: "state_WRONG" };
    req.headers.cookie = "buildgara_oauth_state=state_correct; buildgara_oauth_verifier=verifier_xyz";

    const res = new MockExpressResponse();
    const handler = server.callbackHandler({ onProfile: vi.fn() });
    await handler(req as any, res as any, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res._body).toContain("Login Failed");
    expect(res._body).toContain("STATE_MISMATCH");
  });

  it("responds with error HTML when codeVerifier cookie is missing", async () => {
    const { buildGaraServer } = await import("../src/server.ts");

    const server = buildGaraServer({
      clientId: "bg_client_test123",
      clientSecret: "bg_sec_secret456",
    });

    const req = new MockExpressRequest();
    req.query = { code: "bg_code_abc123", state: "state_abc" };
    req.headers.cookie = "buildgara_oauth_state=state_abc"; // missing verifier

    const res = new MockExpressResponse();
    const handler = server.callbackHandler({ onProfile: vi.fn() });
    await handler(req as any, res as any, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res._body).toContain("codeVerifier cookie");
  });
});
