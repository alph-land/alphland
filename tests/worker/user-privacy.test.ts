import { describe, it, expect } from "vitest";
import worker, { type Env } from "@/worker/index";

/**
 * D1 mock for the profile and notification routes. `writes` records every
 * statement that reached run(), with its bound args, so a test can assert a
 * rejected request changed nothing.
 */
function makeEnv(opts: {
  sessionUserId?: string | null;
  role?: string | null;
  sponsorOfTarget?: boolean;
}) {
  const { sessionUserId = null, role = null, sponsorOfTarget = false } = opts;
  const writes: { sql: string; args: any[] }[] = [];

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
            return sessionUserId ? { userId: sessionUserId } : null;
          if (sql.includes("SELECT role FROM user"))
            return role !== null ? { role } : null;
          if (sql.includes("FROM bounty_submissions bs"))
            return sponsorOfTarget ? { 1: 1 } : null;
          if (sql.includes("FROM user_profiles up")) {
            if (args[0] === "missing") return null;
            return {
              user_id: "victim",
              username: "victim",
              email: "victim@example.com",
              wallet_address: "1VictimWallet",
              bio: "hi",
            };
          }
          if (sql.includes("COUNT(*)")) return { count: 0 };
          return { id: "p1" };
        },
        async all() {
          return { results: [] };
        },
        async run() {
          writes.push({ sql, args });
          return { success: true, meta: { changes: 1 } };
        },
      };
      return b;
    },
  };

  return { env: { DB } as unknown as Env, writes };
}

const COOKIE = "better-auth.session_token=tok";

function req(
  path: string,
  opts: { method?: string; cookie?: boolean; body?: unknown } = {},
) {
  const headers = new Headers();
  if (opts.cookie) headers.set("cookie", COOKIE);
  return new Request(`https://alph.land${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

describe("GET /api/users/:id and /api/users/username/:username", () => {
  for (const path of ["/api/users/victim", "/api/users/username/victim"]) {
    it(`${path} hides email and wallet from anonymous callers`, async () => {
      const { env } = makeEnv({});
      const res = await worker.fetch(req(path), env, {});
      const { user } = (await res.json()) as any;
      expect(res.status).toBe(200);
      expect(user.username).toBe("victim");
      expect(user).not.toHaveProperty("email");
      expect(user).not.toHaveProperty("wallet_address");
    });

    it(`${path} hides both from an unrelated logged-in user`, async () => {
      const { env } = makeEnv({ sessionUserId: "stranger" });
      const res = await worker.fetch(req(path, { cookie: true }), env, {});
      const { user } = (await res.json()) as any;
      expect(user).not.toHaveProperty("email");
      expect(user).not.toHaveProperty("wallet_address");
    });

    it(`${path} shows the wallet, not the email, to the user's sponsor`, async () => {
      const { env } = makeEnv({
        sessionUserId: "sponsor",
        sponsorOfTarget: true,
      });
      const res = await worker.fetch(req(path, { cookie: true }), env, {});
      const { user } = (await res.json()) as any;
      expect(user.wallet_address).toBe("1VictimWallet");
      expect(user).not.toHaveProperty("email");
    });

    it(`${path} shows everything to the owner`, async () => {
      const { env } = makeEnv({ sessionUserId: "victim" });
      const res = await worker.fetch(req(path, { cookie: true }), env, {});
      const { user } = (await res.json()) as any;
      expect(user.email).toBe("victim@example.com");
      expect(user.wallet_address).toBe("1VictimWallet");
    });
  }

  it("returns 404 for an unknown id instead of creating a profile", async () => {
    const { env, writes } = makeEnv({});
    const res = await worker.fetch(req("/api/users/missing"), env, {});
    expect(res.status).toBe(404);
    expect(writes).toHaveLength(0);
  });
});

describe("PUT /api/users/:id", () => {
  const put = (cookie: boolean) =>
    req("/api/users/victim", {
      method: "PUT",
      cookie,
      body: { wallet_address: "1AttackerWallet" },
    });

  it("rejects an anonymous caller without writing", async () => {
    const { env, writes } = makeEnv({});
    const res = await worker.fetch(put(false), env, {});
    expect(res.status).toBe(401);
    expect(writes).toHaveLength(0);
  });

  it("rejects another user without writing", async () => {
    // The payout-redirect case: an attacker swapping a winner's wallet.
    const { env, writes } = makeEnv({ sessionUserId: "attacker" });
    const res = await worker.fetch(put(true), env, {});
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it("lets the owner update their own profile", async () => {
    const { env, writes } = makeEnv({ sessionUserId: "victim" });
    const res = await worker.fetch(put(true), env, {});
    expect(res.status).toBe(200);
    expect(writes.some((w) => w.sql.includes("UPDATE user_profiles"))).toBe(
      true,
    );
  });
});

describe("/api/notifications/* ownership", () => {
  it("GET another user's notifications -> 401 anonymous, 403 logged in", async () => {
    const path = "/api/notifications/user/victim";
    expect((await worker.fetch(req(path), makeEnv({}).env, {})).status).toBe(
      401,
    );
    expect(
      (
        await worker.fetch(
          req(path, { cookie: true }),
          makeEnv({ sessionUserId: "stranger" }).env,
          {},
        )
      ).status,
    ).toBe(403);
  });

  it("GET own notifications -> 200", async () => {
    const { env } = makeEnv({ sessionUserId: "victim" });
    const res = await worker.fetch(
      req("/api/notifications/user/victim", { cookie: true }),
      env,
      {},
    );
    expect(res.status).toBe(200);
  });

  it("read-all on another user -> 403 without writing", async () => {
    const { env, writes } = makeEnv({ sessionUserId: "stranger" });
    const res = await worker.fetch(
      req("/api/notifications/user/victim/read-all", {
        method: "PUT",
        cookie: true,
      }),
      env,
      {},
    );
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it("mark-read and delete by id are scoped to the caller", async () => {
    const { env, writes } = makeEnv({ sessionUserId: "stranger" });
    await worker.fetch(
      req("/api/notifications/n1/read", { method: "PUT", cookie: true }),
      env,
      {},
    );
    await worker.fetch(
      req("/api/notifications/n1", { method: "DELETE", cookie: true }),
      env,
      {},
    );
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w.sql).toContain("AND user_id = ?");
      expect(w.args.at(-1)).toBe("stranger");
    }
  });

  it("anonymous mark-read and delete -> 401 without writing", async () => {
    const { env, writes } = makeEnv({});
    for (const [path, method] of [
      ["/api/notifications/n1/read", "PUT"],
      ["/api/notifications/n1", "DELETE"],
    ]) {
      const res = await worker.fetch(req(path, { method }), env, {});
      expect(res.status).toBe(401);
    }
    expect(writes).toHaveLength(0);
  });
});
