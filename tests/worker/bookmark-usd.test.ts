import { describe, it, expect } from "vitest";
import { handleBookmarksAPI } from "@/worker/handlers";

/**
 * usd_equivalent must come from reward_usd (server-derived, refreshed daily),
 * not reward_usd_value (hand-typed, 0 for every bounty since 025).
 */
describe("GET /api/bookmarks reward.usd_equivalent", () => {
  it("reads reward_usd, not the dead reward_usd_value column", async () => {
    let selectSql = "";
    const DB = {
      prepare(sql: string) {
        const b = {
          bind: () => b,
          async first() {
            return sql.includes("FROM session WHERE token")
              ? { userId: "u1" }
              : null;
          },
          async all() {
            selectSql = sql;
            return {
              results: [
                {
                  bounty_id: "b1",
                  reward_amount: 1000,
                  reward_currency: "ALPH",
                  reward_usd: 42.5,
                  reward_usd_value: 0,
                },
              ],
            };
          },
        };
        return b;
      },
    };

    const res = await handleBookmarksAPI(
      new Request("https://x/api/bookmarks", {
        headers: { Cookie: "better-auth.session_token=tok" },
      }),
      { DB } as any,
      new URL("https://x/api/bookmarks"),
    );
    const { bookmarks } = (await res.json()) as any;

    expect(bookmarks[0].reward.usd_equivalent).toBe(42.5);
    expect(selectSql).toContain("bo.reward_usd,");
    expect(selectSql).not.toContain("reward_usd_value");
  });
});
