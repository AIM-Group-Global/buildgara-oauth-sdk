import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock browser globals for Node test environment
const mockLocalStorage = {
  store: {} as Record<string, string>,
  getItem(key: string) { return this.store[key] ?? null; },
  setItem(key: string, value: string) { this.store[key] = value; },
  removeItem(key: string) { delete this.store[key]; },
};

function setupDom() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = mockLocalStorage;

  // crypto is a getter on globalThis — use Object.defineProperty
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Object.defineProperty(globalThis, "crypto", {
    value: {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 7 + 3) % 256;
        return arr;
      },
      subtle: {
        digest: async (_algorithm: string, data: Uint8Array) => {
          // Deterministic fake SHA-256 for testing
          const hash = new Uint8Array(32);
          let h = 0;
          for (let i = 0; i < data.length; i++) {
            h = (h * 31 + data[i]) >>> 0;
          }
          hash[0] = h & 0xff;
          hash[1] = (h >> 8) & 0xff;
          return hash;
        },
      },
    },
    writable: false,
    configurable: true,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createMockWindow = () => {
    const w: any = {
      location: { href: "https://myapp.com/", origin: "https://myapp.com" },
      open: vi.fn(() => w),
      close: vi.fn(),
      closed: false,
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (...args: any[]) => void) => {
        w._listeners = w._listeners || {};
        w._listeners[event] = handler;
      }),
      screen: { width: 1024, height: 768 },
    };
    return w;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = createMockWindow();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = { cookie: "" };
}

function teardownDom() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).localStorage;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).crypto;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).document;
}

describe("BuildGaraClient — URL building", () => {
  beforeEach(() => { setupDom(); vi.clearAllMocks(); });
  afterEach(() => { teardownDom(); });

  it("builds a correct authorize URL with PKCE", async () => {
    const mod = await import("../src/client.ts");
    const bg = mod.buildGara({
      clientId: "bg_client_test123",
      redirectUri: "https://myapp.com/callback",
    });

    await bg.startLoginPopup();
    const url = bg.buildAuthorizeUrl();

    expect(url).toContain("https://buildgara.com/oauth/authorize");
    expect(url).toContain("client_id=bg_client_test123");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fmyapp.com%2Fcallback");
    expect(url).toContain("response_type=code");
    expect(url).toContain("scope=openid+profile+email+role");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("state=");
    expect(url).toContain("code_challenge=");
  });

  it("uses custom scopes when provided", async () => {
    const mod = await import("../src/client.ts");
    const bg = mod.buildGara({
      clientId: "bg_client_test123",
      redirectUri: "https://myapp.com/callback",
      scopes: "openid email",
    });

    await bg.startLoginPopup();
    const url = bg.buildAuthorizeUrl();

    expect(url).toContain("scope=openid+email");
  });

  it("throws ConfigurationError when clientId is missing", async () => {
    const mod = await import("../src/client.ts");
    // @ts-expect-error — testing invalid config
    expect(() => mod.buildGara({})).toThrow("clientId is required");
  });

  it("throws ConfigurationError when redirectUri is invalid", async () => {
    const mod = await import("../src/client.ts");
    // @ts-expect-error — testing invalid config
    expect(() =>
      mod.buildGara({ clientId: "x", redirectUri: "not-a-url" }),
    ).toThrow("not a valid URL");
  });
});

describe("BuildGaraClient — popup flow", () => {
  beforeEach(() => { setupDom(); vi.clearAllMocks(); });
  afterEach(() => { teardownDom(); });

  it("opens a popup and navigates to the authorize URL", async () => {
    const mod = await import("../src/client.ts");
    const bg = mod.buildGara({
      clientId: "bg_client_test123",
      redirectUri: "https://myapp.com/callback",
    });

    await bg.startLoginPopup();

    const windowOpen = vi.mocked((globalThis as any).window.open);
    expect(windowOpen).toHaveBeenCalledWith(
      "about:blank",
      "_blank",
      expect.stringContaining("width=400"),
    );
  });

  it("throws PopupBlockedError when window.open returns null", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window.open = () => null;

    const mod = await import("../src/client.ts");
    const bg = mod.buildGara({
      clientId: "bg_client_test123",
      redirectUri: "https://myapp.com/callback",
    });

    await expect(bg.startLoginPopup()).rejects.toThrow("popup was blocked");
  });

});

describe("BuildGaraClient — redirect callback", () => {
  beforeEach(() => { setupDom(); vi.clearAllMocks(); });
  afterEach(() => { teardownDom(); });

  it("throws ConfigurationError when no pending request exists", async () => {
    const mod = await import("../src/client.ts");
    const bg = mod.buildGara({
      clientId: "bg_client_test123",
      redirectUri: "https://myapp.com/callback",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window.location = {
      search: "?code=bg_code_abc&state=xyz",
      origin: "https://myapp.com",
    } as Location;

    await expect(
      bg.handleRedirectCallback("/api/auth/buildgara/exchange"),
    ).rejects.toThrow("No pending login request found");
  });

  it("throws AccessDeniedError when error=access_denied in URL", async () => {
    const mod = await import("../src/client.ts");
    const bg = mod.buildGara({
      clientId: "bg_client_test123",
      redirectUri: "https://myapp.com/callback",
    });

    await bg.startLoginPopup();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.assign((globalThis as any).window.location, {
      search: "?error=access_denied&error_description=User denied access&state=doesntmatter",
    });

    await expect(
      bg.handleRedirectCallback("/api/auth/buildgara/exchange"),
    ).rejects.toThrow("Login cancelled");
  });
});

describe("PKCE challenge generation", () => {
  it("generates a non-empty code challenge in the authorize URL", async () => {
    setupDom();
    const mod = await import("../src/client.ts");
    const bg = mod.buildGara({
      clientId: "bg_client_test123",
      redirectUri: "https://myapp.com/callback",
    });

    await bg.startLoginPopup();
    const url = bg.buildAuthorizeUrl();
    const match = url.match(/code_challenge=([^&]+)/);
    expect(match).not.toBeNull();
    expect(match![1]).not.toBe("");
    expect(match![1].length).toBeGreaterThan(20);

    teardownDom();
  });
});
