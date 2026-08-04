import { describe, expect, it } from "vitest";
import { WHOOP_API_BASE_URL } from "./config";
import {
  buildWhoopCollectionUrl,
  collectWhoopPages,
  parseWhoopCollectionResponse,
  parseWhoopRefreshResponse,
  whoopCollectionsForScopes,
  type WhoopListBudget,
  whoopRefreshDueAt,
} from "./client";

function futureBudget(remainingPages: number): WhoopListBudget {
  return { deadlineAt: Date.now() + 60_000, remainingPages };
}

describe("parseWhoopRefreshResponse", () => {
  it("parses a rotated token response and keeps only supported scopes", () => {
    expect(
      parseWhoopRefreshResponse(
        {
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 3600,
          token_type: "bearer",
          scope: "read:recovery read:workout offline",
        },
        "refresh-1",
        ["read:recovery", "offline"],
      ),
    ).toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresInSeconds: 3600,
      scopes: ["read:recovery", "offline"],
    });
  });

  it("falls back to the existing refresh token when Whoop does not rotate it", () => {
    expect(
      parseWhoopRefreshResponse(
        { access_token: "access-2", expires_in: 3600, token_type: "Bearer" },
        "refresh-1",
        ["read:recovery", "offline"],
      ).refreshToken,
    ).toBe("refresh-1");
  });

  it("rejects a non-bearer token type", () => {
    expect(() =>
      parseWhoopRefreshResponse(
        { access_token: "access-2", expires_in: 3600, token_type: "MAC" },
        "refresh-1",
        ["read:recovery"],
      ),
    ).toThrow("Malformed Whoop OAuth refresh response");
  });

  it("rejects a refresh that grants zero supported read scopes", () => {
    expect(() =>
      parseWhoopRefreshResponse(
        {
          access_token: "access-2",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "read:workout openid",
        },
        "refresh-1",
        ["read:recovery"],
      ),
    ).toThrow("Whoop OAuth refresh granted no supported read scopes");
  });
});

describe("parseWhoopCollectionResponse", () => {
  it("returns the records and continuation token", () => {
    expect(
      parseWhoopCollectionResponse({ records: [{ id: 1 }, { id: 2 }], next_token: "page-2" }),
    ).toEqual({ records: [{ id: 1 }, { id: 2 }], nextToken: "page-2" });
  });

  it("maps a null next_token to undefined", () => {
    expect(parseWhoopCollectionResponse({ records: [], next_token: null }).nextToken).toBe(
      undefined,
    );
  });

  it("fails closed on a malformed collection response", () => {
    expect(() => parseWhoopCollectionResponse({ records: "not-an-array" })).toThrow(
      "Malformed Whoop collection response",
    );
  });
});

describe("buildWhoopCollectionUrl", () => {
  it("builds the documented bounded query with the nextToken parameter", () => {
    const url = new URL(
      buildWhoopCollectionUrl({
        collection: "sleep",
        start: "2026-07-01T00:00:00.000Z",
        end: "2026-07-30T00:00:00.000Z",
        nextToken: "page-2",
      }),
    );

    expect(url.toString().startsWith(`${WHOOP_API_BASE_URL}/v2/activity/sleep?`)).toBe(true);
    expect(url.searchParams.get("start")).toBe("2026-07-01T00:00:00.000Z");
    expect(url.searchParams.get("end")).toBe("2026-07-30T00:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("nextToken")).toBe("page-2");
  });

  it("omits the nextToken parameter on the first page", () => {
    const url = new URL(
      buildWhoopCollectionUrl({
        collection: "recovery",
        start: "2026-07-01T00:00:00.000Z",
        end: "2026-07-30T00:00:00.000Z",
      }),
    );

    expect(url.pathname.endsWith("/v2/recovery")).toBe(true);
    expect(url.searchParams.has("nextToken")).toBe(false);
  });
});

describe("whoopCollectionsForScopes", () => {
  it("plans only the collections covered by granted scopes", () => {
    expect(whoopCollectionsForScopes(["read:recovery", "offline"])).toEqual(["recovery"]);
    expect(whoopCollectionsForScopes(["read:sleep", "read:cycles"])).toEqual(["sleep", "cycle"]);
    expect(whoopCollectionsForScopes(["read:workout", "offline"])).toEqual([]);
  });
});

describe("collectWhoopPages", () => {
  it("aggregates records across continuation pages", async () => {
    const records = await collectWhoopPages(async (nextToken) =>
      nextToken === undefined ? { records: ["a", "b"], nextToken: "page-2" } : { records: ["c"] },
    );

    expect(records).toEqual(["a", "b", "c"]);
  });

  it("rejects a repeated page token instead of fetching the same page forever", async () => {
    await expect(
      collectWhoopPages(async () => ({ records: [], nextToken: "repeated-page" })),
    ).rejects.toThrow("Whoop returned a repeated page token");
  });

  it("fails closed instead of reporting success when pagination is truncated", async () => {
    let page = 0;

    await expect(
      collectWhoopPages(async () => {
        page += 1;
        return { records: [], nextToken: `page-${page + 1}` };
      }, 2),
    ).rejects.toThrow("Whoop pagination exceeded the bounded page limit");
  });

  it("shares one bounded page budget across collection lists", async () => {
    const budget = futureBudget(2);

    await collectWhoopPages(async () => ({ records: [] }), 1, budget);
    await collectWhoopPages(async () => ({ records: [] }), 1, budget);

    await expect(collectWhoopPages(async () => ({ records: [] }), 1, budget)).rejects.toThrow(
      "Whoop pagination exceeded the aggregate page budget",
    );
  });

  it("fails closed when the aggregate request time budget is exhausted", async () => {
    const budget: WhoopListBudget = { deadlineAt: Date.now() - 1, remainingPages: 5 };

    await expect(collectWhoopPages(async () => ({ records: [] }), 1, budget)).rejects.toThrow(
      "Whoop aggregate request time budget exceeded",
    );
  });
});

describe("whoopRefreshDueAt", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");

  it("waits one sync interval when the token is nowhere near expiry", () => {
    expect(whoopRefreshDueAt(now, now + 2 * 60 * 60 * 1000)).toBe(now + 30 * 60 * 1000);
  });

  it("clamps to the pre-expiry skew when the token expires before the next interval", () => {
    expect(whoopRefreshDueAt(now, now + 10 * 60 * 1000)).toBe(now + 5 * 60 * 1000);
  });

  it("never schedules in the past for an already-expired token", () => {
    expect(whoopRefreshDueAt(now, now - 1000)).toBe(now);
  });
});
