import { describe, it, expect } from "vitest";
import worker, { type Env } from "@/worker/index";

const env = {
  APP_URL: "https://alph.land",
  DB: {
    prepare() {
      const b = {
        bind: () => b,
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      };
      return b;
    },
  },
} as unknown as Env;

const fetchFrom = (path: string, origin: string, method = "GET") =>
  worker.fetch(
    new Request(`https://alph.land${path}`, {
      method,
      headers: { Origin: origin },
    }),
    env,
    {},
  );

// The worker-level headers (preflight) and handleUsersAPI build CORS
// separately, so both are covered.
const ROUTES: [string, string][] = [
  ["/api/users/me", "OPTIONS"],
  ["/api/users/username/someone", "GET"],
];

describe("credentialed CORS only trusts our own origins", () => {
  for (const [path, method] of ROUTES) {
    it(`${method} ${path} does not reflect a foreign Origin`, async () => {
      const res = await fetchFrom(path, "https://evil.example", method);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://alph.land",
      );
      expect(res.headers.get("Vary")).toContain("Origin");
    });

    it(`${method} ${path} echoes a trusted Origin`, async () => {
      const res = await fetchFrom(path, "https://www.alph.land", method);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://www.alph.land",
      );
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    });
  }
});
