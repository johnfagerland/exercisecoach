import { describe, expect, it } from "vitest";
import { WHOOP_AUTHORIZE_URL, WHOOP_READ_SCOPES } from "./config";
import {
  buildWhoopAuthorizeUrl,
  hashOAuthArtifact,
  parseWhoopProfileResponse,
  parseWhoopTokenResponse,
} from "./oauthFlow";

const config = {
  clientId: "client-1",
  clientSecret: "secret-1",
  redirectUri: "https://app.test/whoop/callback",
};

describe("parseWhoopTokenResponse", () => {
  it("parses a bearer grant carrying every supported scope", () => {
    expect(
      parseWhoopTokenResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        token_type: "Bearer",
        scope: WHOOP_READ_SCOPES.join(" "),
      }),
    ).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresInSeconds: 3600,
      scopes: [...WHOOP_READ_SCOPES],
    });
  });

  it("rejects a grant without the offline scope", () => {
    expect(() =>
      parseWhoopTokenResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "read:recovery read:sleep",
      }),
    ).toThrow("Whoop OAuth did not grant the required recovery and offline scopes");
  });

  it("rejects a grant without the recovery scope", () => {
    expect(() =>
      parseWhoopTokenResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "read:sleep offline",
      }),
    ).toThrow("Whoop OAuth did not grant the required recovery and offline scopes");
  });

  it("rejects a non-bearer token type", () => {
    expect(() =>
      parseWhoopTokenResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        token_type: "MAC",
        scope: WHOOP_READ_SCOPES.join(" "),
      }),
    ).toThrow("Malformed Whoop OAuth token response");
  });
});

describe("parseWhoopProfileResponse", () => {
  it("converts the numeric Whoop user id to a string", () => {
    expect(parseWhoopProfileResponse({ user_id: 10_129 })).toEqual({ whoopUserId: "10129" });
  });

  it("fails closed on a malformed profile response", () => {
    expect(() => parseWhoopProfileResponse({ user_id: "10129" })).toThrow(
      "Malformed Whoop profile response",
    );
  });
});

describe("buildWhoopAuthorizeUrl", () => {
  it("builds the Whoop authorization request with the full scope list and state", () => {
    const url = new URL(buildWhoopAuthorizeUrl(config, "state-1"));

    expect(url.origin + url.pathname).toBe(WHOOP_AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.test/whoop/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...WHOOP_READ_SCOPES]);
    expect(url.searchParams.get("state")).toBe("state-1");
  });
});

describe("hashOAuthArtifact", () => {
  it("hashes deterministically without leaking the raw artifact", async () => {
    const first = await hashOAuthArtifact("raw-artifact");
    const second = await hashOAuthArtifact("raw-artifact");
    const other = await hashOAuthArtifact("other-artifact");

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).not.toContain("raw-artifact");
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
