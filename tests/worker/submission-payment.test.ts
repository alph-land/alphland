import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleSubmissionsAPI } from "@/worker/handlers";

/**
 * Reviewing a submission as its sponsor, with control over what the UPDATE
 * does. `updateError` simulates the unique index on transaction_hash firing.
 */
function makeEnv(opts: {
  sponsorUserId?: string;
  sessionUserId?: string | null;
  updateError?: string;
  walletAddress?: string | null;
}) {
  const {
    sponsorUserId = "sponsor-user",
    sessionUserId = "sponsor-user",
    updateError,
    walletAddress = "1DrDBaLDkxpJKQYXeGmpBjBnbUwFHnJgDBHZW1xhbCyF9",
  } = opts;

  const updates: any[][] = [];

  const DB = {
    prepare(sql: string) {
      let args: any[] = [];
      const b = {
        bind(...a: any[]) {
          args = a;
          return b;
        },
        async first() {
          if (sql.includes("FROM session WHERE token")) {
            return sessionUserId ? { userId: sessionUserId } : null;
          }
          if (sql.includes("SELECT role FROM user")) return { role: null };
          // sponsor that owns the submission's bounty
          if (sql.includes("JOIN sponsors s ON b.sponsor_id = s.id")) {
            return { user_id: sponsorUserId };
          }
          if (sql.includes("LEFT JOIN user_profiles up")) {
            return {
              user_id: "winner",
              bounty_id: "b1",
              wallet_address: walletAddress,
            };
          }
          if (sql.includes("SELECT * FROM bounty_submissions WHERE id")) {
            return { id: "sub1", status: "approved" };
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.includes("UPDATE bounty_submissions")) {
            updates.push(args);
            if (updateError) throw new Error(updateError);
          }
          return { success: true };
        },
      };
      return b;
    },
  };

  return { env: { DB } as any, updates };
}

// Distinct well-formed hashes; the handler rejects anything that is not
// 64 hex characters before it reaches the database.
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

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
        blockHash: "block1",
        outputs: [
          {
            address: "1DrDBaLDkxpJKQYXeGmpBjBnbUwFHnJgDBHZW1xhbCyF9",
            attoAlphAmount: "500000000000000000000",
          },
        ],
      }),
    })) as any,
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("PUT /api/submissions/:id — reused transaction hash", () => {
  it("returns 409, not 500, when the unique index rejects a reused hash", async () => {
    // The on-chain checks pass -- the transaction is real, confirmed and large
    // enough. What they cannot see is that it already paid someone else.
    const { env } = makeEnv({
      updateError:
        "UNIQUE constraint failed: bounty_submissions.transaction_hash",
    });

    const res = await review(env, {
      status: "approved",
      transaction_hash: HASH_A,
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already been used/i);
  });

  it("names the transaction, not a generic failure, so the sponsor can act", async () => {
    const { env } = makeEnv({
      updateError:
        "UNIQUE constraint failed: bounty_submissions.transaction_hash",
    });
    const body = await (
      await review(env, { status: "approved", transaction_hash: HASH_B })
    ).json();

    expect(body.error).toMatch(/transaction hash/i);
    expect(body.error).not.toMatch(/UNIQUE constraint/);
  });

  it("still surfaces unrelated database errors instead of masking them as 409", async () => {
    const { env } = makeEnv({ updateError: "database is locked" });
    await expect(
      review(env, { status: "approved", transaction_hash: HASH_C }),
    ).rejects.toThrow("database is locked");
  });

  it("accepts a first-time hash", async () => {
    const { env, updates } = makeEnv({});
    const res = await review(env, {
      status: "approved",
      transaction_hash: HASH_A,
      reward_amount: "500",
    });

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(HASH_A);
  });

  it("does not touch the hash when rejecting a submission", async () => {
    const { env, updates } = makeEnv({});
    const res = await review(env, { status: "rejected" });

    expect(res.status).toBe(200);
    expect(updates[0]?.[2]).toBeNull(); // transaction_hash bind
  });
});

describe("PUT /api/submissions/:id — hash is stored in one canonical form", () => {
  it("lowercases and trims, so case variants hit the same unique index entry", async () => {
    // The explorer accepts either case. Stored as typed, "ABC…" and "abc…"
    // were two index keys for one payment.
    const { env, updates } = makeEnv({});
    const res = await review(env, {
      status: "approved",
      transaction_hash: `  ${HASH_A.toUpperCase()}\n`,
      reward_amount: "500",
    });

    expect(res.status).toBe(200);
    expect(updates[0]).toContain(HASH_A);
    expect(updates[0]).not.toContain(HASH_A.toUpperCase());
  });

  it("rejects a malformed hash before touching the database", async () => {
    const { env, updates } = makeEnv({});
    for (const bad of ["dup", "g".repeat(64), "a".repeat(63), "0x" + HASH_A]) {
      const res = await review(env, {
        status: "approved",
        transaction_hash: bad,
      });
      expect(res.status).toBe(400);
    }
    expect(updates).toHaveLength(0);
  });

  it("treats a blank hash as none, not as a value to index", async () => {
    const { env, updates } = makeEnv({});
    const res = await review(env, {
      status: "approved",
      transaction_hash: "  ",
    });
    expect(res.status).toBe(200);
    expect(updates[0]?.[2]).toBeNull(); // transaction_hash bind
  });
});

describe("PUT /api/submissions/:id — authorisation still holds", () => {
  it("rejects a caller who does not own the bounty's sponsor", async () => {
    const { env } = makeEnv({
      sponsorUserId: "the-real-sponsor",
      sessionUserId: "someone-else",
    });
    const res = await review(env, { status: "approved" });
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated caller", async () => {
    const { env } = makeEnv({ sessionUserId: null });
    const res = await review(env, { status: "approved" });
    expect(res.status).toBe(401);
  });

  it("rejects a status outside the review enum", async () => {
    const { env } = makeEnv({});
    const res = await review(env, { status: "whatever" });
    expect(res.status).toBe(400);
  });
});
