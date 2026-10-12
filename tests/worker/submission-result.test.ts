import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleSubmissionsAPI } from "@/worker/handlers";

/**
 * Reviewing a submission, capturing the column values bound to the UPDATE.
 *
 * The bind order follows the statement in handlers.ts:
 *   status, reviewer_notes, transaction_hash, reviewed_at, updated_at,
 *   is_winner, winner_position, reward_amount, reward_currency, reward_usd,
 *   is_paid, paid_at, id
 */
const COL = {
  status: 0,
  reviewerNotes: 1,
  txHash: 2,
  isWinner: 5,
  winnerPosition: 6,
  rewardAmount: 7,
  rewardCurrency: 8,
  rewardUsd: 9,
  isPaid: 10,
  paidAt: 11,
} as const;

function makeEnv() {
  let updateArgs: any[] = [];
  const DB = {
    prepare(sql: string) {
      let args: any[] = [];
      const b = {
        bind(...a: any[]) {
          args = a;
          return b;
        },
        async first() {
          if (sql.includes("FROM session WHERE token"))
            return { userId: "sponsor-user" };
          if (sql.includes("SELECT role FROM user")) return { role: null };
          if (sql.includes("JOIN sponsors s ON b.sponsor_id = s.id"))
            return { user_id: "sponsor-user" };
          if (sql.includes("LEFT JOIN user_profiles up"))
            return {
              user_id: "winner",
              bounty_id: "b1",
              wallet_address: "1DrDBaLDkxpJKQYXeGmpBjBnbUwFHnJgDBHZW1xhbCyF9",
            };
          if (sql.includes("JOIN bounties b ON bs.bounty_id = b.id"))
            return { user_id: "winner", bounty_id: "b1", bounty_title: "T" };
          if (sql.includes("SELECT * FROM bounty_submissions WHERE id"))
            return { id: "sub1" };
          if (sql.includes("FROM notification_mutes")) return null;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.includes("UPDATE bounty_submissions")) updateArgs = args;
          return { success: true };
        },
      };
      return b;
    },
  };
  return { env: { DB } as any, cols: () => updateArgs };
}

const review = (env: any, body: any) =>
  handleSubmissionsAPI(
    new Request("https://x/api/submissions/sub1", {
      method: "PUT",
      headers: { Cookie: "better-auth.session_token=tok" },
      body: JSON.stringify(body),
    }),
    env,
    new URL("https://x/api/submissions/sub1"),
  );

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        blockHash: "b",
        outputs: [
          {
            address: "1DrDBaLDkxpJKQYXeGmpBjBnbUwFHnJgDBHZW1xhbCyF9",
            attoAlphAmount: "9000000000000000000000",
          },
        ],
      }),
    })) as any,
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("approving a submission writes structured columns", () => {
  it("stores placement and payout as numbers, not prose", async () => {
    const { env, cols } = makeEnv();
    const res = await review(env, {
      status: "approved",
      winner_position: 2,
      reward_amount: 305,
      reward_currency: "ALPH",
      reward_usd: 18,
      transaction_hash: "1".repeat(64),
      reviewer_notes: "Nice work",
    });

    expect(res.status).toBe(200);
    const c = cols();
    expect(c[COL.isWinner]).toBe(1);
    expect(c[COL.winnerPosition]).toBe(2);
    expect(c[COL.rewardAmount]).toBe(305);
    expect(c[COL.rewardCurrency]).toBe("ALPH");
    expect(c[COL.rewardUsd]).toBe(18);
  });

  it("keeps the reviewer's note free of reward text", async () => {
    // The note used to have "Tier 2 placement. Reward: 305 ALPH (...)"
    // appended, which the earnings query then parsed back out.
    const { env, cols } = makeEnv();
    await review(env, {
      status: "approved",
      winner_position: 1,
      reward_amount: 100,
      reward_usd: 5,
      transaction_hash: "2".repeat(64),
      reviewer_notes: "Nice work",
    });

    expect(cols()[COL.reviewerNotes]).toBe("Nice work");
    expect(cols()[COL.reviewerNotes]).not.toMatch(/Reward:|placement/);
  });

  it("marks paid only when a transaction hash is supplied", async () => {
    const { env, cols } = makeEnv();
    await review(env, {
      status: "approved",
      winner_position: 1,
      reward_amount: 100,
      transaction_hash: "3".repeat(64),
    });
    expect(cols()[COL.isPaid]).toBe(1);
    expect(cols()[COL.paidAt]).toBeTypeOf("number");

    const b = makeEnv();
    await review(b.env, {
      status: "approved",
      winner_position: 1,
      reward_amount: 100,
    });
    expect(b.cols()[COL.isPaid]).toBe(0);
    expect(b.cols()[COL.paidAt]).toBeNull();
  });

  it("defaults the settlement currency to ALPH", async () => {
    const { env, cols } = makeEnv();
    await review(env, { status: "approved", winner_position: 1 });
    expect(cols()[COL.rewardCurrency]).toBe("ALPH");
  });
});

describe("non-approved outcomes do not create a winner", () => {
  it("clears the winner columns on reject", async () => {
    const { env, cols } = makeEnv();
    await review(env, { status: "rejected", reviewer_notes: "Off-topic" });

    const c = cols();
    expect(c[COL.isWinner]).toBe(0);
    expect(c[COL.winnerPosition]).toBeNull();
    expect(c[COL.rewardAmount]).toBeNull();
    expect(c[COL.rewardUsd]).toBeNull();
    expect(c[COL.isPaid]).toBe(0);
  });

  it("clears them on revision_requested too", async () => {
    const { env, cols } = makeEnv();
    await review(env, { status: "revision_requested" });
    expect(cols()[COL.isWinner]).toBe(0);
    expect(cols()[COL.winnerPosition]).toBeNull();
  });

  it("does not record a transaction hash on a rejection", async () => {
    // A stale hash left in the form would otherwise be consumed against the
    // unique index from migration 028, and the actual winner could never be
    // approved with that transaction -- they would get "already been used".
    const { env, cols } = makeEnv();
    await review(env, {
      status: "rejected",
      transaction_hash: "f".repeat(64),
    });
    expect(cols()[COL.txHash]).toBeNull();
  });

  it("ignores reward fields sent alongside a rejection", async () => {
    // A stale form must not leave payout data on a rejected submission.
    const { env, cols } = makeEnv();
    await review(env, {
      status: "rejected",
      winner_position: 1,
      reward_amount: 500,
      reward_usd: 20,
    });
    expect(cols()[COL.rewardAmount]).toBeNull();
    expect(cols()[COL.rewardUsd]).toBeNull();
  });
});

describe("validation of the structured fields", () => {
  it("rejects a non-positive or fractional winner_position", async () => {
    for (const pos of [0, -1, 1.5]) {
      const { env } = makeEnv();
      const res = await review(env, {
        status: "approved",
        winner_position: pos,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/winner_position/);
    }
  });

  it("rejects negative or non-numeric amounts instead of storing them", async () => {
    for (const body of [
      { reward_amount: -1 },
      { reward_amount: "abc" },
      { reward_usd: -0.5 },
      { reward_usd: "lots" },
    ]) {
      const { env } = makeEnv();
      const res = await review(env, {
        status: "approved",
        winner_position: 1,
        ...body,
      });
      expect(res.status).toBe(400);
    }
  });

  it("accepts an approval with no payout recorded yet", async () => {
    // Winner chosen now, amount settled later.
    const { env, cols } = makeEnv();
    const res = await review(env, { status: "approved", winner_position: 1 });
    expect(res.status).toBe(200);
    expect(cols()[COL.isWinner]).toBe(1);
    expect(cols()[COL.rewardAmount]).toBeNull();
  });

  it("accepts a zero reward", async () => {
    const { env, cols } = makeEnv();
    const res = await review(env, {
      status: "approved",
      winner_position: 1,
      reward_amount: 0,
    });
    expect(res.status).toBe(200);
    expect(cols()[COL.rewardAmount]).toBe(0);
  });
});
