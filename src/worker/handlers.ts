/**
 * API Handler Functions for Cloudflare Worker
 * Separate file for better organization
 */
import { Env } from "./index";
import {
  notifyUserSubmissionApproved,
  notifyUserSubmissionRejected,
  notifySponsorNewSubmission,
  notifyUserRevisionRequested,
  notifySponsorSubmissionResubmitted,
  verifyUnsubscribe,
  EMAIL_CATEGORIES,
} from "./email";
import { isAcceptingSubmissions } from "@/features/bounty/utils/bountyStatus";
import {
  notifySubmissionReviewed,
  notifyNewSubmission as notifySponsorOfSubmission,
  notifySponsorStatusChanged,
  notifyCommentReply,
  notifyNewComment,
  notifyCommentLike,
  notify,
} from "./notifications";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

/** Returns true if the user with the given ID has the 'god' superadmin role. */
export async function isGodUser(env: Env, userId: string): Promise<boolean> {
  try {
    const result = (await env.DB.prepare("SELECT role FROM user WHERE id = ?")
      .bind(userId)
      .first()) as { role: string | null } | null;
    return result?.role === "god";
  } catch {
    return false;
  }
}

/**
 * Resolves the requester's userId from the better-auth session cookie.
 * Returns null if there's no cookie, the token doesn't match a live
 * session, or the session has expired. This is the single source of truth
 * for "who is actually making this request" — never trust a client-supplied
 * user_id for authorization decisions, only for authorization *targets*.
 */
export async function getSessionUserId(
  env: Env,
  request: Request,
): Promise<string | null> {
  try {
    const cookieHeader = request.headers.get("cookie") || "";
    // better-auth stores the token in "better-auth.session_token"
    const match = cookieHeader.match(/better-auth\.session_token=([^;]+)/);
    if (!match) return null;
    const token = decodeURIComponent(match[1]);
    const session = (await env.DB.prepare(
      "SELECT userId FROM session WHERE token = ? AND expiresAt > ?",
    )
      .bind(token, Date.now())
      .first()) as { userId: string } | null;
    return session?.userId ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves the god role of the requester directly from the session cookie,
 * without needing the full auth instance. Returns true if the session belongs
 * to a god user.
 */
async function requestIsFromGod(env: Env, request: Request): Promise<boolean> {
  const userId = await getSessionUserId(env, request);
  if (!userId) return false;
  return isGodUser(env, userId);
}

/**
 * Rejects dangerous URL schemes (javascript:, data:, vbscript:, etc.) that
 * would execute in a viewer's session if rendered as a raw <a href>. Only
 * http/https links are considered safe to store and render.
 */
function isSafeSubmissionUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Canonical form of a sponsor's public URL segment.
 *
 * `/bounty/sponsor/:slug` resolves a sponsor by matching the slug against
 * either `username` or the punctuation-stripped, lowercased `name`, so both
 * must be compared in the same normalised space — otherwise "Alephium",
 * "alephium" and "aleph-ium" look distinct to a uniqueness check while
 * colliding at lookup time.
 */
export function normalizeSponsorSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Whether `slug` is already taken by a sponsor other than `excludeSponsorId`.
 *
 * A courtesy check so the form can say so before submitting; the UNIQUE index
 * on sponsors(slug) is what actually guarantees it, closing the race between
 * this read and the write that follows.
 */
export async function isSponsorSlugTaken(
  env: Env,
  slug: string,
  excludeSponsorId?: string,
): Promise<boolean> {
  const normalized = normalizeSponsorSlug(slug);
  if (!normalized) return false;

  const row = await env.DB.prepare(
    `SELECT id FROM sponsors WHERE slug = ? AND id IS NOT ?`,
  )
    .bind(normalized, excludeSponsorId ?? null)
    .first();

  return row !== null;
}

/**
 * Transform bounty object to include computed reward field for backwards compatibility
 */
function transformBounty(bounty: any) {
  if (!bounty) return bounty;
  return {
    ...bounty,
    // "cancelled" is the DB-level value for frontend "closed" (CHECK constraint workaround)
    status: bounty.status === "cancelled" ? "closed" : bounty.status,
    reward: {
      amount: bounty.reward_amount || 0,
      token: bounty.reward_currency || "ALPH",
      usd_equivalent: bounty.reward_usd_value || 0,
    },
  };
}

/**
 * Handle Submissions API requests
 */
export async function handleSubmissionsAPI(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const pathname = url.pathname;

  // POST /api/submissions - Create submission
  if (request.method === "POST" && pathname === "/api/submissions") {
    try {
      const sessionUserId = await getSessionUserId(env, request);
      if (!sessionUserId) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const body = (await request.json()) as any;

      console.log("Creating submission:", {
        bounty_id: body.bounty_id,
        user_id: sessionUserId,
        submission_url: body.submission_url,
        description: body.description,
      });

      // Validate required fields
      if (!body.bounty_id || !body.submission_url) {
        console.log("Missing required fields:", {
          bounty_id: !!body.bounty_id,
          submission_url: !!body.submission_url,
        });
        return new Response(
          JSON.stringify({ error: "Missing required fields" }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      if (!isSafeSubmissionUrl(body.submission_url)) {
        return new Response(
          JSON.stringify({ error: "submission_url must be an http(s) URL" }),
          { status: 400, headers: corsHeaders },
        );
      }

      // A submitter must be reachable and payable before they can enter.
      // Checked here rather than in the form: the form can be bypassed, and
      // the cost of finding out at payout time is a winner nobody can pay.
      const profile = (await env.DB.prepare(
        `SELECT username, wallet_address FROM user_profiles WHERE user_id = ?`,
      )
        .bind(sessionUserId)
        .first()) as {
        username: string | null;
        wallet_address: string | null;
      } | null;

      const missing = [
        !profile?.username?.trim() && "a username",
        !profile?.wallet_address?.trim() && "a wallet address",
      ].filter(Boolean) as string[];

      if (missing.length > 0) {
        return new Response(
          JSON.stringify({
            error: `Add ${missing.join(" and ")} to your profile before submitting.`,
            missing_profile_fields: missing,
          }),
          { status: 403, headers: corsHeaders },
        );
      }

      // Only accept submissions to bounties that are actually live.
      //
      // The check used to be `status !== 'open'`, which 032 turned into a
      // hole: a draft also carries status 'open', so an unpublished bounty
      // would have accepted submissions. It also never looked at the
      // deadline, so a closed bounty stayed open to submissions. Both are
      // covered by the shared derivation.
      const bounty = (await env.DB.prepare(
        `SELECT status, is_published, published_at, is_winners_announced, end_date
           FROM bounties WHERE id = ?`,
      )
        .bind(body.bounty_id)
        .first()) as {
        status: string;
        is_published: number;
        published_at: number | null;
        is_winners_announced: number;
        end_date: number | null;
      } | null;

      if (!bounty || !bounty.is_published) {
        // A draft's existence is not something a stranger should be able to
        // confirm, so this is 404 rather than "not accepting".
        return new Response(JSON.stringify({ error: "Bounty not found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }
      if (!isAcceptingSubmissions(bounty)) {
        return new Response(
          JSON.stringify({ error: "This bounty is not accepting submissions" }),
          { status: 400, headers: corsHeaders },
        );
      }

      // Identity always comes from the session, never from the request body.
      const existing = await env.DB.prepare(
        `SELECT id FROM bounty_submissions WHERE bounty_id = ? AND user_id = ?`,
      )
        .bind(body.bounty_id, sessionUserId)
        .first();

      if (existing) {
        return new Response(
          JSON.stringify({
            error: "Already submitted to this bounty",
            submission_id: (existing as any).id,
          }),
          { status: 409, headers: corsHeaders },
        );
      }

      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);

      await env.DB.prepare(
        `INSERT INTO bounty_submissions (
          id, bounty_id, user_id, submission_url, description,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
        .bind(
          id,
          body.bounty_id,
          sessionUserId,
          body.submission_url,
          body.description || null,
          now,
          now,
        )
        .run();

      const submission = await env.DB.prepare(
        `SELECT * FROM bounty_submissions WHERE id = ?`,
      )
        .bind(id)
        .first();

      const forSponsor = (await env.DB.prepare(
        `SELECT sp.user_id AS sponsor_user_id,
                b.title    AS bounty_title,
                COALESCE(up.username, u.name, u.email) AS submitter_name
           FROM bounties b
           JOIN sponsors sp ON b.sponsor_id = sp.id
           LEFT JOIN user u ON u.id = ?
           LEFT JOIN user_profiles up ON up.user_id = u.id
          WHERE b.id = ?`,
      )
        .bind(sessionUserId, body.bounty_id)
        .first()) as {
        sponsor_user_id: string;
        bounty_title: string;
        submitter_name: string;
      } | null;

      if (forSponsor) {
        await notifySponsorOfSubmission(env, {
          sponsorUserId: forSponsor.sponsor_user_id,
          actorUserId: sessionUserId,
          bountyId: body.bounty_id,
          submissionId: id,
          bountyTitle: forSponsor.bounty_title,
          submitterName: forSponsor.submitter_name || "Someone",
        });
      }

      notifySponsorNewSubmission(env, id).catch((e) =>
        console.error("[email] notifySponsorNewSubmission failed:", e),
      );

      return new Response(JSON.stringify({ submission }), {
        status: 201,
        headers: corsHeaders,
      });
    } catch (error: any) {
      console.error("Error creating submission:", error);
      // Race-safe backstop for the SELECT-then-INSERT duplicate check above:
      // a UNIQUE constraint violation means another request already inserted
      // a submission for this (bounty_id, user_id) pair concurrently.
      if (String(error?.message || "").includes("UNIQUE constraint failed")) {
        return new Response(
          JSON.stringify({ error: "Already submitted to this bounty" }),
          { status: 409, headers: corsHeaders },
        );
      }
      return new Response(
        JSON.stringify({
          error: "Failed to create submission",
          details: error.message,
        }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // GET /api/submissions/check - Check if user has submitted to a bounty
  // NOTE: This must come BEFORE /api/submissions/:id to avoid "check" matching as an ID
  if (request.method === "GET" && pathname === "/api/submissions/check") {
    const userId = url.searchParams.get("user_id");
    const bountyId = url.searchParams.get("bounty_id");

    if (!userId || !bountyId) {
      return new Response(
        JSON.stringify({ error: "user_id and bounty_id are required" }),
        {
          status: 400,
          headers: corsHeaders,
        },
      );
    }

    const submission = await env.DB.prepare(
      `SELECT s.*, b.title as bounty_title
       FROM bounty_submissions s
       JOIN bounties b ON s.bounty_id = b.id
       WHERE s.user_id = ? AND s.bounty_id = ?
       ORDER BY s.created_at DESC
       LIMIT 1`,
    )
      .bind(userId, bountyId)
      .first();

    return new Response(
      JSON.stringify({
        hasSubmitted: !!submission,
        submission: submission || null,
      }),
      {
        headers: corsHeaders,
      },
    );
  }

  // GET /api/submissions/user/:userId - Get user's submissions
  if (
    request.method === "GET" &&
    pathname.match(/^\/api\/submissions\/user\/[^/]+$/)
  ) {
    const userId = pathname.split("/").pop();

    const { results } = await env.DB.prepare(
      `SELECT s.*, b.title as bounty_title
       FROM bounty_submissions s
       JOIN bounties b ON s.bounty_id = b.id
       WHERE s.user_id = ?
       ORDER BY s.created_at DESC`,
    )
      .bind(userId)
      .all();

    return new Response(JSON.stringify({ submissions: results }), {
      headers: corsHeaders,
    });
  }

  // GET /api/submissions/:id - Get submission
  // NOTE: This must come AFTER specific routes like /check, /user/:id, /bounty/:id
  if (
    request.method === "GET" &&
    pathname.match(/^\/api\/submissions\/[^/]+$/)
  ) {
    const id = pathname.split("/").pop();

    const submission = await env.DB.prepare(
      `SELECT s.*,
              COALESCE(up.username, u.name, u.email) as user_username,
              u.name as user_full_name,
              u.image as user_avatar_url
       FROM bounty_submissions s
       LEFT JOIN user u ON s.user_id = u.id
       LEFT JOIN user_profiles up ON s.user_id = up.user_id
       WHERE s.id = ?`,
    )
      .bind(id)
      .first();

    if (!submission) {
      return new Response(JSON.stringify({ error: "Submission not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    return new Response(JSON.stringify({ submission }), {
      headers: corsHeaders,
    });
  }

  // GET /api/submissions/bounty/:bountyId - Get bounty's submissions
  if (
    request.method === "GET" &&
    pathname.match(/^\/api\/submissions\/bounty\/[^/]+$/)
  ) {
    const bountyId = pathname.split("/").pop();

    const { results } = await env.DB.prepare(
      `SELECT s.*,
              COALESCE(up.username, u.name, u.email) as user_username,
              u.name as user_full_name,
              u.image as user_avatar_url
       FROM bounty_submissions s
       LEFT JOIN user u ON s.user_id = u.id
       LEFT JOIN user_profiles up ON s.user_id = up.user_id
       WHERE s.bounty_id = ?
       ORDER BY s.created_at DESC`,
    )
      .bind(bountyId)
      .all();

    return new Response(JSON.stringify({ submissions: results }), {
      headers: corsHeaders,
    });
  }

  // GET /api/submissions/sponsor/:sponsorId - Get sponsor's submissions
  if (
    request.method === "GET" &&
    pathname.match(/^\/api\/submissions\/sponsor\/[^/]+$/)
  ) {
    const sponsorId = pathname.split("/").pop();

    const { results } = await env.DB.prepare(
      `SELECT s.*,
              b.title as bounty_title,
              b.sponsor_id,
              sp.name as sponsor_name,
              sp.logo_url as sponsor_logo_url,
              COALESCE(up.username, u.name, u.email) as user_username,
              u.name as user_full_name,
              u.image as user_avatar_url
       FROM bounty_submissions s
       JOIN bounties b ON s.bounty_id = b.id
       LEFT JOIN sponsors sp ON b.sponsor_id = sp.id
       LEFT JOIN user u ON s.user_id = u.id
       LEFT JOIN user_profiles up ON s.user_id = up.user_id
       WHERE b.sponsor_id = ?
       ORDER BY s.created_at DESC`,
    )
      .bind(sponsorId)
      .all();

    return new Response(JSON.stringify({ submissions: results }), {
      headers: corsHeaders,
    });
  }

  // PUT /api/submissions/:id - Update submission
  if (
    request.method === "PUT" &&
    pathname.match(/^\/api\/submissions\/[^/]+$/)
  ) {
    const id = pathname.split("/").pop();
    const body = (await request.json()) as any;
    const now = Math.floor(Date.now() / 1000);

    const ALLOWED_REVIEW_STATUSES = [
      "approved",
      "rejected",
      "revision_requested",
    ];
    if (!ALLOWED_REVIEW_STATUSES.includes(body.status)) {
      return new Response(
        JSON.stringify({
          error: `status must be one of: ${ALLOWED_REVIEW_STATUSES.join(", ")}`,
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    const sessionUserId = await getSessionUserId(env, request);
    if (!sessionUserId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    // Only the sponsor who owns this submission's bounty (or a god user)
    // may approve/reject/request revision on it.
    const owningSponsor = (await env.DB.prepare(
      `SELECT s.user_id
       FROM bounty_submissions bs
       JOIN bounties b ON bs.bounty_id = b.id
       JOIN sponsors s ON b.sponsor_id = s.id
       WHERE bs.id = ?`,
    )
      .bind(id)
      .first()) as { user_id: string } | null;

    if (!owningSponsor) {
      return new Response(JSON.stringify({ error: "Submission not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    if (owningSponsor.user_id !== sessionUserId) {
      const isGod = await isGodUser(env, sessionUserId);
      if (!isGod) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: corsHeaders,
        });
      }
    }

    // God users can approve directly without transaction verification
    const godOverride =
      body.status === "approved" && (await isGodUser(env, sessionUserId));

    // Verify transaction on Alephium if transaction_hash is provided (skipped for god users)
    if (!godOverride && body.transaction_hash && body.status === "approved") {
      // Fetch submission + winner wallet address in one query
      const submissionWithWallet = (await env.DB.prepare(
        `SELECT bs.user_id, bs.bounty_id, up.wallet_address
         FROM bounty_submissions bs
         LEFT JOIN user_profiles up ON bs.user_id = up.user_id
         WHERE bs.id = ?`,
      )
        .bind(id)
        .first()) as {
        user_id: string;
        bounty_id: string;
        wallet_address: string | null;
      } | null;

      if (!submissionWithWallet?.wallet_address) {
        return new Response(
          JSON.stringify({
            error:
              "Winner has no wallet address on file. Cannot verify payment.",
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      // Call Alephium Explorer API to verify the transaction
      let txData: any;
      try {
        const txRes = await fetch(
          `https://backend.mainnet.alephium.org/transactions/${body.transaction_hash}`,
          { headers: { Accept: "application/json" } },
        );
        if (!txRes.ok) {
          return new Response(
            JSON.stringify({
              error:
                "Transaction not found on Alephium. Please check the tx hash.",
            }),
            { status: 400, headers: corsHeaders },
          );
        }
        txData = await txRes.json();
      } catch {
        return new Response(
          JSON.stringify({
            error: "Failed to reach Alephium Explorer. Please try again.",
          }),
          { status: 502, headers: corsHeaders },
        );
      }

      // Must be confirmed (has a blockHash)
      if (!txData.blockHash) {
        return new Response(
          JSON.stringify({
            error:
              "Transaction is not confirmed yet. Please wait for it to be included in a block.",
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      // Find output matching the winner's wallet address (exact match first)
      const outputs: any[] = txData.outputs || [];
      let matchingOutput = outputs.find(
        (o: any) => o.address === submissionWithWallet.wallet_address,
      );

      // Fallback: groupless addresses (type 4) may resolve to a different
      // group-specific address in the Explorer output. Verify via the
      // address transaction history instead.
      if (!matchingOutput) {
        let addressContainsTx = false;
        try {
          const addrTxRes = await fetch(
            `https://backend.mainnet.alephium.org/addresses/${encodeURIComponent(submissionWithWallet.wallet_address)}/transactions?page=1&limit=20`,
            { headers: { Accept: "application/json" } },
          );
          if (addrTxRes.ok) {
            const addrTxData: any[] = await addrTxRes.json();
            addressContainsTx =
              Array.isArray(addrTxData) &&
              addrTxData.some((tx: any) => tx.hash === body.transaction_hash);
          }
        } catch {
          // ignore — fall through to error below
        }

        if (!addressContainsTx) {
          return new Response(
            JSON.stringify({
              error: `Transaction does not contain a payment to the winner's address (${submissionWithWallet.wallet_address}).`,
            }),
            { status: 400, headers: corsHeaders },
          );
        }

        // Find the output with the largest amount as the matching output for
        // amount verification (groupless address resolved to a different form)
        matchingOutput = outputs.reduce((best: any, o: any) => {
          if (!best) return o;
          return BigInt(o.attoAlphAmount || "0") >
            BigInt(best.attoAlphAmount || "0")
            ? o
            : best;
        }, null);
      }

      // Verify amount if reward_amount is provided (1 ALPH = 10^18 attoALPH)
      if (body.reward_amount) {
        const expectedAtto = BigInt(
          Math.round(parseFloat(body.reward_amount) * 1e18),
        );
        const actualAtto = BigInt(matchingOutput.attoAlphAmount || "0");
        if (actualAtto < expectedAtto) {
          const actualAlph = (Number(actualAtto) / 1e18).toFixed(4);
          return new Response(
            JSON.stringify({
              error: `Payment amount mismatch. Expected ${body.reward_amount} ALPH but transaction only sent ${actualAlph} ALPH to the winner.`,
            }),
            { status: 400, headers: corsHeaders },
          );
        }
      }
    }

    // Structured outcome. Callers send winner_position / reward_amount /
    // reward_usd as numbers; they used to be prose inside reviewer_notes and
    // read back out with a regex, which meant rewording a note could change
    // someone's lifetime earnings.
    const isApproved = body.status === "approved";

    const winnerPosition =
      body.winner_position === undefined || body.winner_position === null
        ? null
        : Number(body.winner_position);
    if (
      winnerPosition !== null &&
      (!Number.isInteger(winnerPosition) || winnerPosition < 1)
    ) {
      return new Response(
        JSON.stringify({ error: "winner_position must be a positive integer" }),
        { status: 400, headers: corsHeaders },
      );
    }

    const numeric = (v: unknown, field: string): number | null => {
      if (v === undefined || v === null || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`${field} must be a non-negative number`);
      }
      return n;
    };

    let rewardAmount: number | null;
    let rewardUsd: number | null;
    try {
      rewardAmount = numeric(body.reward_amount, "reward_amount");
      rewardUsd = numeric(body.reward_usd, "reward_usd");
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    try {
      await env.DB.prepare(
        `UPDATE bounty_submissions
       SET status = ?,
           reviewer_notes = ?,
           transaction_hash = ?,
           reviewed_at = ?,
           updated_at = ?,
           is_winner = ?,
           winner_position = ?,
           reward_amount = ?,
           reward_currency = ?,
           reward_usd = ?,
           is_paid = ?,
           paid_at = ?,
           label = 'reviewed'
       WHERE id = ?`,
      )
        .bind(
          body.status,
          body.reviewer_notes || null,
          // Only an approval records a payment. Writing a stale hash from the
          // form onto a rejected submission would consume it against the
          // unique index, and the real winner could then never be approved
          // with that transaction.
          isApproved ? body.transaction_hash || null : null,
          body.status === "approved" || body.status === "rejected" ? now : null,
          now,
          isApproved ? 1 : 0,
          isApproved ? winnerPosition : null,
          isApproved ? rewardAmount : null,
          isApproved ? body.reward_currency || "ALPH" : null,
          isApproved ? rewardUsd : null,
          // Paid is a separate fact from the verdict, but this flow only
          // approves once a verified transaction hash is supplied.
          isApproved && body.transaction_hash ? 1 : 0,
          isApproved && body.transaction_hash ? now : null,
          id,
        )
        .run();
    } catch (error: any) {
      // A transaction hash may only pay one submission. The on-chain checks
      // above confirm the transaction is real and large enough, but not that
      // it has already been spent on someone else -- that is what the unique
      // index catches.
      if (String(error?.message || "").includes("UNIQUE constraint failed")) {
        return new Response(
          JSON.stringify({
            error:
              "That transaction hash has already been used to pay another " +
              "submission. Each winner needs their own payment.",
          }),
          { status: 409, headers: corsHeaders },
        );
      }
      throw error;
    }

    const submission = await env.DB.prepare(
      `SELECT * FROM bounty_submissions WHERE id = ?`,
    )
      .bind(id)
      .first();

    // In-app notification, written here rather than by the browser so the
    // submitter is told even if the reviewer closes the tab straight after.
    const reviewed = (await env.DB.prepare(
      `SELECT bs.user_id, bs.bounty_id, b.title AS bounty_title
         FROM bounty_submissions bs
         JOIN bounties b ON bs.bounty_id = b.id
        WHERE bs.id = ?`,
    )
      .bind(id)
      .first()) as {
      user_id: string;
      bounty_id: string;
      bounty_title: string;
    } | null;

    if (reviewed) {
      await notifySubmissionReviewed(env, {
        submitterUserId: reviewed.user_id,
        bountyId: reviewed.bounty_id,
        submissionId: id as string,
        bountyTitle: reviewed.bounty_title,
        status: body.status,
        reviewerNotes: body.reviewer_notes,
      });
    }

    if (body.status === "approved") {
      notifyUserSubmissionApproved(env, id as string).catch((e) =>
        console.error("[email] notifyUserSubmissionApproved failed:", e),
      );
    } else if (body.status === "rejected") {
      notifyUserSubmissionRejected(env, id as string).catch((e) =>
        console.error("[email] notifyUserSubmissionRejected failed:", e),
      );
    } else if (body.status === "revision_requested") {
      notifyUserRevisionRequested(env, id as string).catch((e) =>
        console.error("[email] notifyUserRevisionRequested failed:", e),
      );
    }

    return new Response(JSON.stringify({ submission }), {
      headers: corsHeaders,
    });
  }

  // PATCH /api/submissions/:id — user edits their own submission and resubmits
  if (
    request.method === "PATCH" &&
    pathname.match(/^\/api\/submissions\/[^/]+$/)
  ) {
    const sessionUserId = await getSessionUserId(env, request);
    if (!sessionUserId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const id = pathname.split("/").pop();
    const body = (await request.json()) as any;
    const now = Math.floor(Date.now() / 1000);

    if (!body.submission_url) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: corsHeaders },
      );
    }

    if (!isSafeSubmissionUrl(body.submission_url)) {
      return new Response(
        JSON.stringify({ error: "submission_url must be an http(s) URL" }),
        { status: 400, headers: corsHeaders },
      );
    }

    // Verify the submission belongs to this user and check bounty is still open
    const existing = (await env.DB.prepare(
      `SELECT bs.id, bs.user_id, bs.status, b.status as bounty_status, b.end_date
       FROM bounty_submissions bs
       JOIN bounties b ON bs.bounty_id = b.id
       WHERE bs.id = ?`,
    )
      .bind(id)
      .first()) as {
      id: string;
      user_id: string;
      status: string;
      bounty_status: string;
      end_date: number;
    } | null;

    if (!existing) {
      return new Response(JSON.stringify({ error: "Submission not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    if (existing.user_id !== sessionUserId) {
      const isGod = await requestIsFromGod(env, request);
      if (!isGod) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 403,
          headers: corsHeaders,
        });
      }
    }

    if (existing.status === "approved" || existing.status === "rejected") {
      return new Response(
        JSON.stringify({ error: "Cannot edit a finalized submission" }),
        { status: 400, headers: corsHeaders },
      );
    }

    const isExpired = existing.end_date && existing.end_date < now;
    if (existing.bounty_status === "completed" || isExpired) {
      return new Response(
        JSON.stringify({ error: "Cannot edit submission for a closed bounty" }),
        { status: 400, headers: corsHeaders },
      );
    }

    await env.DB.prepare(
      `UPDATE bounty_submissions
       SET submission_url = ?, description = ?, status = 'submitted', updated_at = ?
       WHERE id = ?`,
    )
      .bind(body.submission_url, body.description || null, now, id)
      .run();

    const submission = await env.DB.prepare(
      `SELECT * FROM bounty_submissions WHERE id = ?`,
    )
      .bind(id)
      .first();

    notifySponsorSubmissionResubmitted(env, id as string).catch((e) =>
      console.error("[email] notifySponsorSubmissionResubmitted failed:", e),
    );

    return new Response(JSON.stringify({ submission }), {
      headers: corsHeaders,
    });
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: corsHeaders,
  });
}

/**
 * Handle Comments API requests
 */
export async function handleCommentsAPI(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const pathname = url.pathname;

  // GET /api/comments/bounty/:bountyId - Get bounty's comments with like counts
  if (
    request.method === "GET" &&
    pathname.match(/^\/api\/comments\/bounty\/[^/]+$/)
  ) {
    const bountyId = pathname.split("/").pop();
    const userId = url.searchParams.get("user_id");

    // Get comments with like counts and user info
    const { results } = await env.DB.prepare(
      `SELECT
        c.*,
        COALESCE(up.username, usr.name, usr.email) as user_username,
        usr.image as user_avatar
       FROM bounty_comments c
       LEFT JOIN user usr ON c.user_id = usr.id
       LEFT JOIN user_profiles up ON c.user_id = up.user_id
       WHERE c.bounty_id = ? AND c.deleted_at IS NULL
       ORDER BY c.created_at ASC`,
    )
      .bind(bountyId)
      .all();

    // Process liked_by field and calculate like_count, user_liked
    const processedComments = results.map((comment: any) => {
      let likedBy: string[] = [];
      try {
        if (
          comment.liked_by &&
          typeof comment.liked_by === "string" &&
          comment.liked_by.trim() !== ""
        ) {
          likedBy = JSON.parse(comment.liked_by);
        }
      } catch (e) {
        console.error("Failed to parse liked_by JSON:", e);
        likedBy = [];
      }

      if (!Array.isArray(likedBy)) {
        likedBy = [];
      }

      return {
        ...comment,
        like_count: likedBy.length,
        user_liked: userId ? (likedBy.includes(userId) ? 1 : 0) : 0,
      };
    });

    return new Response(JSON.stringify({ comments: processedComments }), {
      headers: corsHeaders,
    });
  }

  // POST /api/comments - Create comment
  if (request.method === "POST" && pathname === "/api/comments") {
    const sessionUserId = await getSessionUserId(env, request);
    if (!sessionUserId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const body = (await request.json()) as any;

    if (!body.bounty_id || !body.content?.trim()) {
      return new Response(
        JSON.stringify({ error: "bounty_id and content are required" }),
        { status: 400, headers: corsHeaders },
      );
    }

    // A reply must point at a parent comment that actually belongs to the
    // same bounty — otherwise replies can be misattached across bounties.
    if (body.parent_comment_id) {
      const parent = await env.DB.prepare(
        `SELECT id FROM bounty_comments WHERE id = ? AND bounty_id = ?`,
      )
        .bind(body.parent_comment_id, body.bounty_id)
        .first();
      if (!parent) {
        return new Response(
          JSON.stringify({
            error: "parent_comment_id does not belong to this bounty",
          }),
          { status: 400, headers: corsHeaders },
        );
      }
    }

    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(
      `INSERT INTO bounty_comments (
        id, bounty_id, user_id, content, parent_comment_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        body.bounty_id,
        sessionUserId,
        body.content,
        body.parent_comment_id || null,
        now,
        now,
      )
      .run();

    const comment = (await env.DB.prepare(
      `SELECT c.*,
        COALESCE(up.username, usr.name, usr.email) as user_username,
        usr.image as user_avatar
       FROM bounty_comments c
       LEFT JOIN user usr ON c.user_id = usr.id
       LEFT JOIN user_profiles up ON c.user_id = up.user_id
       WHERE c.id = ?`,
    )
      .bind(id)
      .first()) as any;

    // Notify server-side. A reply pings the parent author; a top-level comment
    // pings the bounty's sponsor. Both go through notify(), which skips muted
    // bounties -- the old client-side code only checked mutes on the top-level
    // path, so a muted bounty still delivered replies.
    const ctx = (await env.DB.prepare(
      `SELECT b.title AS bounty_title, sp.user_id AS sponsor_user_id
         FROM bounties b
         LEFT JOIN sponsors sp ON b.sponsor_id = sp.id
        WHERE b.id = ?`,
    )
      .bind(body.bounty_id)
      .first()) as {
      bounty_title: string;
      sponsor_user_id: string | null;
    } | null;

    const commenterName = comment?.user_username || "Someone";

    if (body.parent_comment_id) {
      const parent = (await env.DB.prepare(
        `SELECT user_id FROM bounty_comments WHERE id = ?`,
      )
        .bind(body.parent_comment_id)
        .first()) as { user_id: string } | null;

      if (parent) {
        await notifyCommentReply(env, {
          parentAuthorUserId: parent.user_id,
          actorUserId: sessionUserId,
          bountyId: body.bounty_id,
          replierName: commenterName,
        });
      }
    } else if (ctx?.sponsor_user_id) {
      await notifyNewComment(env, {
        sponsorUserId: ctx.sponsor_user_id,
        actorUserId: sessionUserId,
        bountyId: body.bounty_id,
        bountyTitle: ctx.bounty_title,
        commenterName,
      });
    }

    return new Response(JSON.stringify({ comment }), {
      status: 201,
      headers: corsHeaders,
    });
  }

  // PUT /api/comments/:id - Edit comment
  if (request.method === "PUT" && pathname.match(/^\/api\/comments\/[^/]+$/)) {
    const sessionUserId = await getSessionUserId(env, request);
    if (!sessionUserId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const id = pathname.split("/").pop();
    const body = (await request.json()) as any;
    const now = Math.floor(Date.now() / 1000);

    const existingComment = (await env.DB.prepare(
      `SELECT user_id FROM bounty_comments WHERE id = ?`,
    )
      .bind(id)
      .first()) as { user_id: string } | null;

    if (!existingComment) {
      return new Response(JSON.stringify({ error: "Comment not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    if (existingComment.user_id !== sessionUserId) {
      const isGod = await isGodUser(env, sessionUserId);
      if (!isGod) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: corsHeaders,
        });
      }
    }

    await env.DB.prepare(
      `UPDATE bounty_comments SET content = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(body.content, now, id)
      .run();

    const comment = await env.DB.prepare(
      `SELECT c.*,
        COALESCE(up.username, usr.name, usr.email) as user_username,
        usr.image as user_avatar
       FROM bounty_comments c
       LEFT JOIN user usr ON c.user_id = usr.id
       LEFT JOIN user_profiles up ON c.user_id = up.user_id
       WHERE c.id = ?`,
    )
      .bind(id)
      .first();

    // Process liked_by field
    let likedBy: string[] = [];
    try {
      if (
        comment.liked_by &&
        typeof comment.liked_by === "string" &&
        comment.liked_by.trim() !== ""
      ) {
        likedBy = JSON.parse(comment.liked_by);
      }
    } catch (e) {
      console.error("Failed to parse liked_by JSON:", e);
      likedBy = [];
    }

    if (!Array.isArray(likedBy)) {
      likedBy = [];
    }

    const processedComment = {
      ...comment,
      like_count: likedBy.length,
    };

    return new Response(JSON.stringify({ comment: processedComment }), {
      headers: corsHeaders,
    });
  }

  // DELETE /api/comments/:id - Delete comment (soft delete)
  if (
    request.method === "DELETE" &&
    pathname.match(/^\/api\/comments\/[^/]+$/)
  ) {
    const sessionUserId = await getSessionUserId(env, request);
    if (!sessionUserId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const id = pathname.split("/").pop();
    const now = Math.floor(Date.now() / 1000);

    const existingComment = (await env.DB.prepare(
      `SELECT user_id FROM bounty_comments WHERE id = ?`,
    )
      .bind(id)
      .first()) as { user_id: string } | null;

    if (!existingComment) {
      return new Response(JSON.stringify({ error: "Comment not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    if (existingComment.user_id !== sessionUserId) {
      const isGod = await isGodUser(env, sessionUserId);
      if (!isGod) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: corsHeaders,
        });
      }
    }

    await env.DB.prepare(
      `UPDATE bounty_comments SET deleted_at = ? WHERE id = ?`,
    )
      .bind(now, id)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      headers: corsHeaders,
    });
  }

  // POST /api/comments/:id/like - Like a comment
  if (
    request.method === "POST" &&
    pathname.match(/^\/api\/comments\/[^/]+\/like$/)
  ) {
    const commentId = pathname.split("/").slice(-2)[0];
    const body = (await request.json()) as any;
    const now = Math.floor(Date.now() / 1000);

    if (!body.user_id) {
      return new Response(JSON.stringify({ error: "user_id is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Get current comment with liked_by field
    const comment = await env.DB.prepare(
      `SELECT liked_by FROM bounty_comments WHERE id = ?`,
    )
      .bind(commentId)
      .first();

    if (!comment) {
      return new Response(JSON.stringify({ error: "Comment not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    // Parse liked_by array - handle null, empty string, or invalid JSON
    let likedBy: string[] = [];
    try {
      if (
        comment.liked_by &&
        typeof comment.liked_by === "string" &&
        comment.liked_by.trim() !== ""
      ) {
        likedBy = JSON.parse(comment.liked_by);
      }
    } catch (e) {
      console.error("Failed to parse liked_by JSON:", e);
      likedBy = [];
    }

    // Ensure likedBy is an array
    if (!Array.isArray(likedBy)) {
      likedBy = [];
    }

    // Check if already liked
    if (likedBy.includes(body.user_id)) {
      return new Response(
        JSON.stringify({ error: "Already liked", like_count: likedBy.length }),
        {
          status: 400,
          headers: corsHeaders,
        },
      );
    }

    // Add user to liked_by array
    likedBy.push(body.user_id);

    // liked_by is the single source of truth; the count is derived on read.
    // The like_count column was dropped in 033 -- it was written here and
    // never read back, so it could only ever drift.
    await env.DB.prepare(
      `UPDATE bounty_comments
       SET liked_by = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(JSON.stringify(likedBy), now, commentId)
      .run();

    const liked = (await env.DB.prepare(
      `SELECT c.user_id, c.bounty_id,
              COALESCE(up.username, u.name, u.email) AS liker_name
         FROM bounty_comments c
         LEFT JOIN user u ON u.id = ?
         LEFT JOIN user_profiles up ON up.user_id = u.id
        WHERE c.id = ?`,
    )
      .bind(body.user_id, commentId)
      .first()) as {
      user_id: string;
      bounty_id: string;
      liker_name: string;
    } | null;

    if (liked) {
      await notifyCommentLike(env, {
        commentAuthorUserId: liked.user_id,
        actorUserId: body.user_id,
        bountyId: liked.bounty_id,
        likerName: liked.liker_name || "Someone",
      });
    }

    return new Response(
      JSON.stringify({ success: true, like_count: likedBy.length }),
      {
        status: 201,
        headers: corsHeaders,
      },
    );
  }

  // DELETE /api/comments/:id/like - Unlike a comment
  if (
    request.method === "DELETE" &&
    pathname.match(/^\/api\/comments\/[^/]+\/like$/)
  ) {
    const commentId = pathname.split("/").slice(-2)[0];
    const userId = url.searchParams.get("user_id");
    const now = Math.floor(Date.now() / 1000);

    if (!userId) {
      return new Response(JSON.stringify({ error: "user_id is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Get current comment with liked_by field
    const comment = await env.DB.prepare(
      `SELECT liked_by FROM bounty_comments WHERE id = ?`,
    )
      .bind(commentId)
      .first();

    if (!comment) {
      return new Response(JSON.stringify({ error: "Comment not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    // Parse liked_by array - handle null, empty string, or invalid JSON
    let likedBy: string[] = [];
    try {
      if (
        comment.liked_by &&
        typeof comment.liked_by === "string" &&
        comment.liked_by.trim() !== ""
      ) {
        likedBy = JSON.parse(comment.liked_by);
      }
    } catch (e) {
      console.error("Failed to parse liked_by JSON:", e);
      likedBy = [];
    }

    // Ensure likedBy is an array
    if (!Array.isArray(likedBy)) {
      likedBy = [];
    }

    // Remove user from liked_by array
    const newLikedBy = likedBy.filter((id: string) => id !== userId);

    await env.DB.prepare(
      `UPDATE bounty_comments
       SET liked_by = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(JSON.stringify(newLikedBy), now, commentId)
      .run();

    return new Response(
      JSON.stringify({ success: true, like_count: newLikedBy.length }),
      {
        headers: corsHeaders,
      },
    );
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: corsHeaders,
  });
}

/**
 * Handle Sponsors API requests
 */
export async function handleSponsorsAPI(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const pathname = url.pathname;

  // GET /api/sponsors/check-slug?u=xxx[&exclude=<sponsorId>]
  // Live availability check for the sign-up / edit forms, mirroring the
  // server-side rule so the user finds out before submitting rather than
  // through a 409. Must be matched before /api/sponsors/:id below, which
  // would otherwise swallow "check-slug" as an id.
  if (request.method === "GET" && pathname === "/api/sponsors/check-slug") {
    const url = new URL(request.url);
    const raw = url.searchParams.get("u") || "";
    const normalized = normalizeSponsorSlug(raw);

    if (!normalized) {
      return new Response(
        JSON.stringify({
          available: false,
          normalized,
          reason: "Profile URL must contain at least one letter or number",
        }),
        { status: 200, headers: corsHeaders },
      );
    }

    const taken = await isSponsorSlugTaken(
      env,
      normalized,
      url.searchParams.get("exclude") || undefined,
    );

    return new Response(JSON.stringify({ available: !taken, normalized }), {
      headers: corsHeaders,
    });
  }

  // GET /api/sponsors/:id - Get sponsor
  if (request.method === "GET" && pathname.match(/^\/api\/sponsors\/[^/]+$/)) {
    const id = pathname.split("/").pop();

    const sponsor = await env.DB.prepare(`SELECT * FROM sponsors WHERE id = ?`)
      .bind(id)
      .first();

    if (!sponsor) {
      return new Response(JSON.stringify({ error: "Sponsor not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    return new Response(JSON.stringify({ sponsor }), {
      headers: corsHeaders,
    });
  }

  // GET /api/sponsors/name/:slug - Get sponsor by username or slugified company name
  if (
    request.method === "GET" &&
    pathname.match(/^\/api\/sponsors\/name\/[^/]+$/)
  ) {
    const slug = normalizeSponsorSlug(
      decodeURIComponent(pathname.split("/").pop()!),
    );

    // Single-column exact match against a UNIQUE index. The previous query
    // ORed `username` against a normalised `name`, which meant one slug could
    // match two rows and LIMIT 1 returned whichever the planner reached first.
    const sponsor = await env.DB.prepare(
      `SELECT * FROM sponsors WHERE slug = ?`,
    )
      .bind(slug)
      .first();

    if (!sponsor) {
      return new Response(JSON.stringify({ error: "Sponsor not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    return new Response(JSON.stringify({ sponsor }), {
      headers: corsHeaders,
    });
  }

  // GET /api/sponsors/user/:userId - Get sponsor by user ID
  if (
    request.method === "GET" &&
    pathname.match(/^\/api\/sponsors\/user\/[^/]+$/)
  ) {
    const userId = pathname.split("/").pop()!;

    const sponsor = await env.DB.prepare(
      `SELECT * FROM sponsors WHERE user_id = ?`,
    )
      .bind(userId)
      .first();

    const god = await isGodUser(env, userId);
    if (god) {
      let allSponsors: any[] = [];
      try {
        const { results } = await env.DB.prepare(
          `SELECT id, name, slug, logo_url, is_verified, is_banned, created_at FROM sponsors ORDER BY name ASC`,
        ).all();
        allSponsors = results;
      } catch {
        // Fallback: is_verified/is_banned columns may not exist yet
        try {
          const { results } = await env.DB.prepare(
            `SELECT id, name, slug, logo_url, created_at FROM sponsors ORDER BY name ASC`,
          ).all();
          allSponsors = results;
        } catch {
          // ignore
        }
      }
      return new Response(
        JSON.stringify({
          sponsor: sponsor || null,
          is_god: true,
          all_sponsors: allSponsors,
        }),
        { headers: corsHeaders },
      );
    }

    // Return 200 with null sponsor instead of 404 to avoid console errors
    return new Response(JSON.stringify({ sponsor: sponsor || null }), {
      headers: corsHeaders,
    });
  }

  // POST /api/sponsors - Create sponsor (auto-approved)
  if (request.method === "POST" && pathname === "/api/sponsors") {
    const sessionUserId = await getSessionUserId(env, request);
    if (!sessionUserId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const existingSponsor = await env.DB.prepare(
      `SELECT id FROM sponsors WHERE user_id = ?`,
    )
      .bind(sessionUserId)
      .first();
    if (existingSponsor) {
      return new Response(
        JSON.stringify({ error: "This user already has a sponsor profile" }),
        { status: 409, headers: corsHeaders },
      );
    }

    const body = (await request.json()) as any;
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    // Same slug rules as the update path — a sponsor must not be able to
    // claim another's public URL at sign-up either. The form has only ever
    // sent `name`; the `username` branch that used to sit here read a field no
    // client sends, against a column dropped in 034.
    const desiredSlug = normalizeSponsorSlug(String(body.name || ""));

    // The slug is the profile URL and cannot be derived later, so a name that
    // normalises to nothing (e.g. all punctuation) has to be rejected here
    // rather than silently producing an unreachable profile.
    if (!desiredSlug) {
      return new Response(
        JSON.stringify({
          error: "Sponsor name must contain at least one letter or number",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    if (await isSponsorSlugTaken(env, desiredSlug)) {
      return new Response(
        JSON.stringify({
          error: `The URL /bounty/sponsor/${desiredSlug} is already taken`,
        }),
        { status: 409, headers: corsHeaders },
      );
    }

    await env.DB.prepare(
      `INSERT INTO sponsors (
        id, user_id, name, slug, description, entity_name, industry,
        logo_url, banner_url, website, twitter, discord, telegram, wallet_address,
        contact_first_name, contact_last_name, contact_username, contact_telegram, contact_email,
        status, approved_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)`,
    )
      .bind(
        id,
        sessionUserId,
        body.name,
        desiredSlug,
        body.description || null,
        body.entity_name || null,
        body.industry || null,
        body.logo_url || null,
        body.banner_url || null,
        body.website || null,
        body.twitter || null,
        body.discord || null,
        body.telegram || null,
        body.wallet_address || null,
        body.contact_first_name || null,
        body.contact_last_name || null,
        body.contact_username || null,
        body.contact_telegram || null,
        body.contact_email || null,
        now, // approved_at
        now, // created_at
        now, // updated_at
      )
      .run();

    // Try to update user's is_sponsor flag (may fail if columns don't exist)
    try {
      await env.DB.prepare(
        `UPDATE user SET is_sponsor = 1, sponsor_id = ? WHERE id = ?`,
      )
        .bind(id, sessionUserId)
        .run();
    } catch {
      // Columns don't exist yet, skip
    }

    const sponsor = await env.DB.prepare(`SELECT * FROM sponsors WHERE id = ?`)
      .bind(id)
      .first();

    return new Response(JSON.stringify({ sponsor }), {
      status: 201,
      headers: corsHeaders,
    });
  }

  // GET /api/sponsors/:id/dashboard - Get sponsor dashboard data
  if (
    request.method === "GET" &&
    pathname.match(/^\/api\/sponsors\/[^/]+\/dashboard$/)
  ) {
    const id = pathname.replace("/dashboard", "").split("/").pop();

    // Get sponsor info
    const sponsor = (await env.DB.prepare(`SELECT * FROM sponsors WHERE id = ?`)
      .bind(id)
      .first()) as { user_id: string } | null;

    if (!sponsor) {
      return new Response(JSON.stringify({ error: "Sponsor not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    // This endpoint serves two audiences: the sponsor's own dashboard, and
    // the public sponsor profile page (SponsorProfile.tsx fetches it from
    // getServerSideProps). It had no authorization at all, so anyone who knew
    // a sponsor id could read every submission -- including
    // user_wallet_address and the submitter's identity -- and, once drafts
    // existed, their unpublished bounties too.
    //
    // Rather than lock the whole route and break the public page, the owner
    // gets everything and everyone else gets only what that page actually
    // reads: the sponsor record and the published bounties.
    const sessionUserId = await getSessionUserId(env, request);
    const isOwner =
      !!sessionUserId &&
      (sponsor.user_id === sessionUserId ||
        (await isGodUser(env, sessionUserId)));

    const { results: bounties } = await env.DB.prepare(
      isOwner
        ? `SELECT * FROM bounties
            WHERE sponsor_id = ?
            ORDER BY created_at DESC`
        : `SELECT * FROM bounties
            WHERE sponsor_id = ? AND is_published = 1 AND status != 'deleted'
            ORDER BY created_at DESC`,
    )
      .bind(id)
      .all();

    if (!isOwner) {
      return new Response(
        JSON.stringify({ sponsor, bounties, submissions: [] }),
        { headers: corsHeaders },
      );
    }

    // Get submissions for all bounties by this sponsor (with user info)
    const { results: submissions } = await env.DB.prepare(
      `SELECT bs.*,
              b.title as bounty_title,
              COALESCE(up.username, u.name, u.email) as user_username,
              u.name as user_full_name,
              u.image as user_avatar_url,
              up.wallet_address as user_wallet_address
       FROM bounty_submissions bs
       JOIN bounties b ON bs.bounty_id = b.id
       LEFT JOIN user u ON bs.user_id = u.id
       LEFT JOIN user_profiles up ON bs.user_id = up.user_id
       WHERE b.sponsor_id = ?
       ORDER BY bs.created_at DESC`,
    )
      .bind(id)
      .all();

    // Calculate stats
    const total_bounties_count = bounties.length;
    const total_projects_count = 0; // TODO: Implement projects
    const total_reward_amount = bounties.reduce((sum: number, b: any) => {
      // Since 025 reward_usd is the one USD figure, kept current by the daily
      // revaluation. The branch that used to stand here predates it: it read
      // reward_currency='USD' to mean "reward_amount is dollars" and otherwise
      // fell back to the hand-typed reward_usd_value, so a post-025 bounty --
      // reward_currency always 'ALPH', reward_usd_value always 0 -- summed its
      // ALPH count as if it were dollars.
      return sum + (parseFloat(b.reward_usd) || 0);
    }, 0);

    return new Response(
      JSON.stringify({
        sponsor: {
          ...sponsor,
          total_bounties_count,
          total_projects_count,
          total_reward_amount,
        },
        bounties: bounties.map(transformBounty),
        submissions,
      }),
      {
        headers: corsHeaders,
      },
    );
  }

  // PUT /api/sponsors/:id - Update sponsor
  if (request.method === "PUT" && pathname.match(/^\/api\/sponsors\/[^/]+$/)) {
    const sessionUserId = await getSessionUserId(env, request);
    if (!sessionUserId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const id = pathname.split("/").pop();

    const targetSponsor = (await env.DB.prepare(
      `SELECT user_id FROM sponsors WHERE id = ?`,
    )
      .bind(id)
      .first()) as { user_id: string } | null;

    if (!targetSponsor) {
      return new Response(JSON.stringify({ error: "Sponsor not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    if (targetSponsor.user_id !== sessionUserId) {
      const isGod = await isGodUser(env, sessionUserId);
      if (!isGod) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: corsHeaders,
        });
      }
    }

    const body = (await request.json()) as any;
    const now = Math.floor(Date.now() / 1000);

    // Build dynamic update query to handle explicit null values
    // If a field is in the body (even as null), update it
    // If a field is undefined/not present, keep existing value
    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) {
      updates.push("name = ?");
      values.push(body.name || null);
    }
    if (body.description !== undefined) {
      updates.push("description = ?");
      values.push(body.description || null);
    }
    if (body.logo_url !== undefined) {
      updates.push("logo_url = ?");
      values.push(body.logo_url || null);
    }
    // Handle banner_url - if explicitly set to null, remove it
    if ("banner_url" in body) {
      updates.push("banner_url = ?");
      values.push(body.banner_url);
    }
    if (body.website !== undefined) {
      updates.push("website = ?");
      values.push(body.website || null);
    }
    if (body.twitter !== undefined) {
      updates.push("twitter = ?");
      values.push(body.twitter || null);
    }
    if (body.discord !== undefined) {
      updates.push("discord = ?");
      values.push(body.discord || null);
    }
    if (body.telegram !== undefined) {
      updates.push("telegram = ?");
      values.push(body.telegram || null);
    }
    if (body.wallet_address !== undefined) {
      updates.push("wallet_address = ?");
      values.push(body.wallet_address || null);
    }
    if (body.contact_email !== undefined) {
      updates.push("contact_email = ?");
      values.push(body.contact_email || null);
    }
    if (body.contact_telegram !== undefined) {
      updates.push("contact_telegram = ?");
      values.push(body.contact_telegram || null);
    }
    // `slug` is only ever changed when explicitly asked for. Renaming a
    // sponsor deliberately leaves it alone -- that stability is the point of
    // storing it, since links previously derived from the name at render time
    // and every one of them broke on a rename.
    if (body.slug !== undefined) {
      const desired = normalizeSponsorSlug(String(body.slug || ""));

      if (!desired) {
        return new Response(
          JSON.stringify({
            error: "Profile URL must contain at least one letter or number",
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      if (await isSponsorSlugTaken(env, desired, id)) {
        return new Response(
          JSON.stringify({
            error: `The URL /bounty/sponsor/${desired} is already taken`,
          }),
          { status: 409, headers: corsHeaders },
        );
      }

      updates.push("slug = ?");
      values.push(desired);
    }
    if (body.entity_name !== undefined) {
      updates.push("entity_name = ?");
      values.push(body.entity_name || null);
    }
    if (body.industry !== undefined) {
      updates.push("industry = ?");
      values.push(body.industry || null);
    }
    if (body.contact_first_name !== undefined) {
      updates.push("contact_first_name = ?");
      values.push(body.contact_first_name || null);
    }
    if (body.contact_last_name !== undefined) {
      updates.push("contact_last_name = ?");
      values.push(body.contact_last_name || null);
    }
    if (body.contact_username !== undefined) {
      updates.push("contact_username = ?");
      values.push(body.contact_username || null);
    }

    // Always update updated_at
    updates.push("updated_at = ?");
    values.push(now);
    values.push(id);

    if (updates.length > 1) {
      await env.DB.prepare(
        `UPDATE sponsors SET ${updates.join(", ")} WHERE id = ?`,
      )
        .bind(...values)
        .run();
    }

    const sponsor = await env.DB.prepare(`SELECT * FROM sponsors WHERE id = ?`)
      .bind(id)
      .first();

    return new Response(JSON.stringify({ sponsor }), {
      headers: corsHeaders,
    });
  }

  // GET /api/sponsors - List all sponsors (for admin)
  if (request.method === "GET" && pathname === "/api/sponsors") {
    const isBanned = url.searchParams.get("is_banned");
    const statusParam = url.searchParams.get("status");

    const baseQuery = `SELECT s.*, b.bounty_count,
                              u.email as user_email, u.name as user_name, u.image as user_image
                       FROM sponsors s
                       LEFT JOIN (
                         SELECT sponsor_id, COUNT(*) as bounty_count
                         FROM bounties
                         GROUP BY sponsor_id
                       ) b ON s.id = b.sponsor_id
                       LEFT JOIN user u ON s.user_id = u.id`;

    let where = "";
    if (isBanned === "true") {
      where = ` WHERE s.is_banned = 1`;
    } else if (statusParam === "pending") {
      where = ` WHERE s.status = 'pending'`;
    } else if (statusParam === "approved") {
      where = ` WHERE s.status = 'approved'`;
    }

    const query = baseQuery + where + ` ORDER BY s.created_at DESC`;

    try {
      const { results } = await env.DB.prepare(query).all();
      return new Response(JSON.stringify({ sponsors: results }), {
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Sponsors query failed:", error);
      return new Response(JSON.stringify({ sponsors: [] }), {
        headers: corsHeaders,
      });
    }
  }

  // PUT /api/sponsors/:id/verify - Verify sponsor (god only)
  if (
    request.method === "PUT" &&
    pathname.match(/^\/api\/sponsors\/[^/]+\/verify$/)
  ) {
    if (!(await requestIsFromGod(env, request))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: corsHeaders,
      });
    }
    const id = pathname.split("/")[3];
    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(
      `UPDATE sponsors SET is_verified = 1, updated_at = ? WHERE id = ?`,
    )
      .bind(now, id)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      headers: corsHeaders,
    });
  }

  // PUT /api/sponsors/:id/unverify - Unverify sponsor (god only)
  if (
    request.method === "PUT" &&
    pathname.match(/^\/api\/sponsors\/[^/]+\/unverify$/)
  ) {
    if (!(await requestIsFromGod(env, request))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: corsHeaders,
      });
    }
    const id = pathname.split("/")[3];
    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(
      `UPDATE sponsors SET is_verified = 0, updated_at = ? WHERE id = ?`,
    )
      .bind(now, id)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      headers: corsHeaders,
    });
  }

  // PUT /api/sponsors/:id/ban - Ban sponsor (god only)
  if (
    request.method === "PUT" &&
    pathname.match(/^\/api\/sponsors\/[^/]+\/ban$/)
  ) {
    if (!(await requestIsFromGod(env, request))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: corsHeaders,
      });
    }
    const id = pathname.split("/")[3];
    const now = Math.floor(Date.now() / 1000);

    try {
      // Get sponsor to find user_id
      const sponsor = await env.DB.prepare(
        `SELECT user_id FROM sponsors WHERE id = ?`,
      )
        .bind(id)
        .first();

      if (sponsor) {
        await env.DB.prepare(
          `UPDATE sponsors SET is_banned = 1, banned_at = ?, updated_at = ? WHERE id = ?`,
        )
          .bind(now, now, id)
          .run();

        await env.DB.prepare(
          `UPDATE user SET is_banned = 1, updatedAt = ? WHERE id = ?`,
        )
          .bind(now * 1000, sponsor.user_id)
          .run();
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Failed to ban sponsor:", error);
      return new Response(JSON.stringify({ error: "Failed to ban sponsor." }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }

  // POST /api/sponsors/:id/transfer - Transfer sponsor ownership to another user
  if (
    request.method === "POST" &&
    pathname.match(/^\/api\/sponsors\/[^/]+\/transfer$/)
  ) {
    const currentUserId = await getSessionUserId(env, request);

    if (!currentUserId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const id = pathname.split("/")[3];
    const now = Math.floor(Date.now() / 1000);

    // Verify requester is the current owner
    const sponsor = (await env.DB.prepare(
      `SELECT id, user_id, name FROM sponsors WHERE id = ?`,
    )
      .bind(id)
      .first()) as {
      id: string;
      user_id: string;
      name: string;
    } | null;

    if (!sponsor) {
      return new Response(JSON.stringify({ error: "Sponsor not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    const isGod = await isGodUser(env, currentUserId);
    if (sponsor.user_id !== currentUserId && !isGod) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    const body = (await request.json()) as { new_owner_username: string };
    if (!body.new_owner_username?.trim()) {
      return new Response(
        JSON.stringify({ error: "new_owner_username is required" }),
        { status: 400, headers: corsHeaders },
      );
    }

    // Look up new owner by username in user_profiles
    const newOwnerProfile = (await env.DB.prepare(
      `SELECT user_id FROM user_profiles WHERE username = ?`,
    )
      .bind(body.new_owner_username.trim())
      .first()) as { user_id: string } | null;

    if (!newOwnerProfile) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    const newOwnerId = newOwnerProfile.user_id;

    if (newOwnerId === sponsor.user_id) {
      return new Response(
        JSON.stringify({ error: "New owner is the same as current owner" }),
        { status: 400, headers: corsHeaders },
      );
    }

    // Check new owner doesn't already have a sponsor
    const existingSponsor = await env.DB.prepare(
      `SELECT id FROM sponsors WHERE user_id = ?`,
    )
      .bind(newOwnerId)
      .first();

    if (existingSponsor) {
      return new Response(
        JSON.stringify({ error: "This user already owns a sponsor account" }),
        { status: 409, headers: corsHeaders },
      );
    }

    try {
      // Transfer: update sponsor user_id
      await env.DB.prepare(
        `UPDATE sponsors SET user_id = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(newOwnerId, now, id)
        .run();

      // Clear old owner's sponsor flags
      await env.DB.prepare(
        `UPDATE user SET is_sponsor = 0, sponsor_id = NULL, updatedAt = ? WHERE id = ?`,
      )
        .bind(now * 1000, sponsor.user_id)
        .run();

      // Set new owner's sponsor flags
      await env.DB.prepare(
        `UPDATE user SET is_sponsor = 1, sponsor_id = ?, updatedAt = ? WHERE id = ?`,
      )
        .bind(id, now * 1000, newOwnerId)
        .run();

      return new Response(JSON.stringify({ success: true }), {
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Failed to transfer sponsor ownership:", error);
      return new Response(
        JSON.stringify({ error: "Failed to transfer ownership" }),
        { status: 500, headers: corsHeaders },
      );
    }
  }

  // PUT /api/sponsors/:id/unban - Unban sponsor (god only)
  if (
    request.method === "PUT" &&
    pathname.match(/^\/api\/sponsors\/[^/]+\/unban$/)
  ) {
    if (!(await requestIsFromGod(env, request))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: corsHeaders,
      });
    }
    const id = pathname.split("/")[3];
    const now = Math.floor(Date.now() / 1000);

    try {
      // Get sponsor to find user_id
      const sponsor = await env.DB.prepare(
        `SELECT user_id FROM sponsors WHERE id = ?`,
      )
        .bind(id)
        .first();

      if (sponsor) {
        await env.DB.prepare(
          `UPDATE sponsors SET is_banned = 0, banned_at = NULL, updated_at = ? WHERE id = ?`,
        )
          .bind(now, id)
          .run();

        await env.DB.prepare(
          `UPDATE user SET is_banned = 0, updatedAt = ? WHERE id = ?`,
        )
          .bind(now * 1000, sponsor.user_id)
          .run();
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Failed to unban sponsor:", error);
      return new Response(
        JSON.stringify({ error: "Failed to unban sponsor." }),
        { status: 500, headers: corsHeaders },
      );
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: corsHeaders,
  });
}

/**
 * Handle Notifications API requests
 */
export async function handleNotificationsAPI(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const pathname = url.pathname;

  // Every route here reads or changes one user's notifications, so all of
  // them need a session; POST additionally requires god (checked below).
  const sessionUserId = await getSessionUserId(env, request);
  if (!sessionUserId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }
  const forbidden = () =>
    new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: corsHeaders,
    });

  // GET /api/notifications/user/:userId - Get user's notifications
  if (
    request.method === "GET" &&
    pathname.match(/^\/api\/notifications\/user\/[^/]+$/)
  ) {
    const userId = pathname.split("/").pop();
    if (userId !== sessionUserId) return forbidden();
    const limit = parseInt(url.searchParams.get("limit") || "20");
    const unreadOnly = url.searchParams.get("unread_only") === "true";

    let query = `SELECT * FROM notifications WHERE user_id = ?`;
    if (unreadOnly) {
      query += ` AND read = 0`;
    }
    query += ` ORDER BY created_at DESC LIMIT ?`;

    const { results } = await env.DB.prepare(query).bind(userId, limit).all();

    // Get unread count
    const unreadCount = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0`,
    )
      .bind(userId)
      .first();

    return new Response(
      JSON.stringify({
        notifications: results,
        unread_count: unreadCount?.count || 0,
      }),
      {
        headers: corsHeaders,
      },
    );
  }

  // POST /api/notifications - Create notification
  if (request.method === "POST" && pathname === "/api/notifications") {
    // Notifications are created by the worker in the same handler as the state
    // change they describe (see notifications.ts). This endpoint used to accept
    // an arbitrary user_id/title/message/link from anyone, which made it a
    // ready-made phishing channel; it is now god-only and kept for admin use.
    if (!(await isGodUser(env, sessionUserId))) return forbidden();

    const body = (await request.json()) as any;

    // Validate required fields
    if (!body.user_id || !body.type || !body.title || !body.message) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields",
          details: {
            user_id: body.user_id ? "ok" : "missing",
            type: body.type ? "ok" : "missing",
            title: body.title ? "ok" : "missing",
            message: body.message ? "ok" : "missing",
          },
        }),
        {
          status: 400,
          headers: corsHeaders,
        },
      );
    }

    // Routed through notify() rather than inserting directly, so this path
    // honours notification_mutes like every other one. A direct INSERT here
    // meant an admin-authored notice about a bounty reached users who had
    // explicitly muted that bounty. Mutes are bounty-scoped, so a
    // notification with no bounty attached is unaffected.
    const created = await notify(env, {
      userId: body.user_id,
      type: body.type,
      title: body.title,
      message: body.message,
      link: body.link || null,
      bountyId: body.related_bounty_id || null,
      submissionId: body.related_submission_id || null,
    });

    if (!created) {
      return new Response(
        JSON.stringify({
          suppressed: true,
          reason: "recipient muted this bounty",
        }),
        { status: 200, headers: corsHeaders },
      );
    }

    const notification = await env.DB.prepare(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(body.user_id)
      .first();

    return new Response(JSON.stringify({ notification }), {
      status: 201,
      headers: corsHeaders,
    });
  }

  // PUT /api/notifications/:id/read - Mark notification as read
  if (
    request.method === "PUT" &&
    pathname.match(/^\/api\/notifications\/[^/]+\/read$/)
  ) {
    const id = pathname.split("/").slice(-2)[0];

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `UPDATE notifications SET read = 1, read_at = ? WHERE id = ? AND user_id = ?`,
    )
      .bind(now, id, sessionUserId)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      headers: corsHeaders,
    });
  }

  // PUT /api/notifications/user/:userId/read-all - Mark all notifications as read
  if (
    request.method === "PUT" &&
    pathname.match(/^\/api\/notifications\/user\/[^/]+\/read-all$/)
  ) {
    const userId = pathname.split("/").slice(-2)[0];
    if (userId !== sessionUserId) return forbidden();

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `UPDATE notifications SET read = 1, read_at = ? WHERE user_id = ?`,
    )
      .bind(now, userId)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      headers: corsHeaders,
    });
  }

  // DELETE /api/notifications/:id - Delete notification
  if (
    request.method === "DELETE" &&
    pathname.match(/^\/api\/notifications\/[^/]+$/)
  ) {
    const id = pathname.split("/").pop();

    await env.DB.prepare(
      `DELETE FROM notifications WHERE id = ? AND user_id = ?`,
    )
      .bind(id, sessionUserId)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      headers: corsHeaders,
    });
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: corsHeaders,
  });
}

/**
 * Handle Notification Mutes API requests (simplified replacement for preferences)
 */
export async function handleNotificationPreferencesAPI(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const pathname = url.pathname;

  // GET /api/notification-mutes/check - Check if notifications are muted
  if (
    request.method === "GET" &&
    pathname === "/api/notification-mutes/check"
  ) {
    const bountyId = url.searchParams.get("bounty_id");
    const userId = url.searchParams.get("user_id");

    if (!bountyId || !userId) {
      return new Response(
        JSON.stringify({ error: "bounty_id and user_id are required" }),
        {
          status: 400,
          headers: corsHeaders,
        },
      );
    }

    const mute = await env.DB.prepare(
      `SELECT id FROM notification_mutes WHERE user_id = ? AND bounty_id = ?`,
    )
      .bind(userId, bountyId)
      .first();

    return new Response(JSON.stringify({ muted: !!mute }), {
      headers: corsHeaders,
    });
  }

  // POST /api/notification-mutes - Mute notifications for a bounty
  if (request.method === "POST" && pathname === "/api/notification-mutes") {
    const body = (await request.json()) as any;
    const now = Math.floor(Date.now() / 1000);

    // Check if already muted
    const existing = await env.DB.prepare(
      `SELECT id FROM notification_mutes WHERE user_id = ? AND bounty_id = ?`,
    )
      .bind(body.user_id, body.bounty_id)
      .first();

    if (existing) {
      return new Response(
        JSON.stringify({ error: "Already muted", mute: existing }),
        {
          status: 400,
          headers: corsHeaders,
        },
      );
    }

    // Create mute
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO notification_mutes (id, user_id, bounty_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(id, body.user_id, body.bounty_id, now)
      .run();

    const mute = await env.DB.prepare(
      `SELECT * FROM notification_mutes WHERE id = ?`,
    )
      .bind(id)
      .first();

    return new Response(JSON.stringify({ mute }), {
      status: 201,
      headers: corsHeaders,
    });
  }

  // DELETE /api/notification-mutes - Unmute notifications
  if (request.method === "DELETE" && pathname === "/api/notification-mutes") {
    const bountyId = url.searchParams.get("bounty_id");
    const userId = url.searchParams.get("user_id");

    if (!bountyId || !userId) {
      return new Response(
        JSON.stringify({ error: "bounty_id and user_id are required" }),
        {
          status: 400,
          headers: corsHeaders,
        },
      );
    }

    await env.DB.prepare(
      `DELETE FROM notification_mutes WHERE user_id = ? AND bounty_id = ?`,
    )
      .bind(userId, bountyId)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      headers: corsHeaders,
    });
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: corsHeaders,
  });
}

/**
 * Helper to check if notifications are muted for a bounty
 * Updated to use notification_mutes table (simpler approach)
 */
export async function isNotificationMuted(
  env: Env,
  userId: string,
  bountyId: string,
  _type: "comments" | "submissions",
): Promise<boolean> {
  const mute = await env.DB.prepare(
    `SELECT id FROM notification_mutes WHERE user_id = ? AND bounty_id = ?`,
  )
    .bind(userId, bountyId)
    .first();

  // If a mute record exists, notifications are muted (for all types)
  return !!mute;
}

/**
 * Handle User Account Deletion API requests
 */
export async function handleUserDeletionAPI(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const pathname = url.pathname;

  // DELETE /api/user/:userId - Delete user account and related data
  if (request.method === "DELETE" && pathname.match(/^\/api\/user\/[^/]+$/)) {
    const userId = pathname.split("/").pop();

    if (!userId) {
      return new Response(JSON.stringify({ error: "User ID is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    try {
      // Begin deletion process
      // 1. Delete user profile
      await env.DB.prepare(`DELETE FROM user_profiles WHERE user_id = ?`)
        .bind(userId)
        .run();

      // 2. Delete sessions
      await env.DB.prepare(`DELETE FROM session WHERE userId = ?`)
        .bind(userId)
        .run();

      // 3. Delete accounts (OAuth connections)
      await env.DB.prepare(`DELETE FROM account WHERE userId = ?`)
        .bind(userId)
        .run();

      // 4. Delete notifications
      await env.DB.prepare(`DELETE FROM notifications WHERE user_id = ?`)
        .bind(userId)
        .run();

      // 5. Delete notification mutes
      await env.DB.prepare(`DELETE FROM notification_mutes WHERE user_id = ?`)
        .bind(userId)
        .run();

      // 6. Soft delete comments (anonymize instead of hard delete)
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `UPDATE bounty_comments
         SET content = '[deleted]', deleted_at = ?
         WHERE user_id = ? AND deleted_at IS NULL`,
      )
        .bind(now, userId)
        .run();

      // 7. Keep submissions but anonymize the user (for bounty integrity)
      // We keep submission records for sponsor's reference but anonymize the user
      await env.DB.prepare(
        `UPDATE bounty_submissions
         SET user_id = 'deleted-user'
         WHERE user_id = ?`,
      )
        .bind(userId)
        .run();

      // 8. Delete sponsor profile if exists
      await env.DB.prepare(`DELETE FROM sponsors WHERE user_id = ?`)
        .bind(userId)
        .run();

      // 9. Delete the main user record
      await env.DB.prepare(`DELETE FROM user WHERE id = ?`).bind(userId).run();

      return new Response(
        JSON.stringify({
          success: true,
          message:
            "User account and related data have been deleted successfully",
        }),
        {
          status: 200,
          headers: corsHeaders,
        },
      );
    } catch (error) {
      console.error("Error deleting user account:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to delete user account",
          details: error instanceof Error ? error.message : "Unknown error",
        }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: corsHeaders,
  });
}

/**
 * Handle Bookmarks API requests
 */
export async function handleBookmarksAPI(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const pathname = url.pathname;

  // GET /api/bookmarks - Get user's bookmarks
  if (request.method === "GET" && pathname === "/api/bookmarks") {
    const sessionUserId = await getSessionUserId(env, request);
    if (!sessionUserId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    // Ignore any user_id query param for identity — only the session owner's
    // own bookmarks can be listed this way.
    const userId = sessionUserId;

    try {
      const bookmarks = await env.DB.prepare(
        `SELECT
          b.id,
          b.bounty_id,
          b.created_at,
          bo.title,
          bo.reward_amount,
          bo.reward_currency,
          bo.reward_type,
          bo.reward_usd_value,
          bo.status,
          bo.end_date,
          bo.sponsor_id,
          s.name as sponsor_name,
          s.slug as sponsor_slug,
          s.logo_url as sponsor_logo_url
        FROM bookmarks b
        LEFT JOIN bounties bo ON b.bounty_id = bo.id
        LEFT JOIN sponsors s ON bo.sponsor_id = s.id
        WHERE b.user_id = ?
        ORDER BY b.created_at DESC`,
      )
        .bind(userId)
        .all();

      // Transform bookmarks to include computed reward field
      const transformedBookmarks = (bookmarks.results || []).map((b: any) => ({
        ...b,
        reward: {
          amount: b.reward_amount || 0,
          token: b.reward_currency || "ALPH",
          usd_equivalent: b.reward_usd_value || 0,
        },
      }));

      return new Response(JSON.stringify({ bookmarks: transformedBookmarks }), {
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error fetching bookmarks:", error);
      return new Response(
        JSON.stringify({ error: "Failed to fetch bookmarks" }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // GET /api/bookmarks/check - Check if bounty is bookmarked
  if (request.method === "GET" && pathname === "/api/bookmarks/check") {
    const sessionUserId = await getSessionUserId(env, request);
    if (!sessionUserId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    const userId = sessionUserId;
    const bountyId = url.searchParams.get("bounty_id");

    if (!bountyId) {
      return new Response(JSON.stringify({ error: "bounty_id is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    try {
      const bookmark = await env.DB.prepare(
        `SELECT id FROM bookmarks WHERE user_id = ? AND bounty_id = ?`,
      )
        .bind(userId, bountyId)
        .first();

      return new Response(JSON.stringify({ bookmarked: !!bookmark }), {
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error checking bookmark:", error);
      return new Response(
        JSON.stringify({ error: "Failed to check bookmark" }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // POST /api/bookmarks - Create bookmark
  if (request.method === "POST" && pathname === "/api/bookmarks") {
    try {
      const sessionUserId = await getSessionUserId(env, request);
      if (!sessionUserId) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const body = (await request.json()) as any;
      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);

      // Check if already bookmarked
      const existing = await env.DB.prepare(
        `SELECT id FROM bookmarks WHERE user_id = ? AND bounty_id = ?`,
      )
        .bind(sessionUserId, body.bounty_id)
        .first();

      if (existing) {
        return new Response(
          JSON.stringify({ error: "Already bookmarked", bookmark: existing }),
          {
            status: 409,
            headers: corsHeaders,
          },
        );
      }

      await env.DB.prepare(
        `INSERT INTO bookmarks (id, user_id, bounty_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
        .bind(id, sessionUserId, body.bounty_id, now)
        .run();

      const bookmark = await env.DB.prepare(
        `SELECT * FROM bookmarks WHERE id = ?`,
      )
        .bind(id)
        .first();

      return new Response(JSON.stringify({ bookmark }), {
        status: 201,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error creating bookmark:", error);
      return new Response(
        JSON.stringify({ error: "Failed to create bookmark" }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // DELETE /api/bookmarks - Delete bookmark
  if (request.method === "DELETE" && pathname === "/api/bookmarks") {
    const sessionUserId = await getSessionUserId(env, request);
    if (!sessionUserId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    const userId = sessionUserId;
    const bountyId = url.searchParams.get("bounty_id");

    if (!bountyId) {
      return new Response(JSON.stringify({ error: "bounty_id is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    try {
      await env.DB.prepare(
        `DELETE FROM bookmarks WHERE user_id = ? AND bounty_id = ?`,
      )
        .bind(userId, bountyId)
        .run();

      return new Response(JSON.stringify({ success: true }), {
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error deleting bookmark:", error);
      return new Response(
        JSON.stringify({ error: "Failed to delete bookmark" }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: corsHeaders,
  });
}

/**
 * Handle Account Linking API requests
 */
export async function handleAccountLinkingAPI(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const pathname = url.pathname;
  const {
    checkAccountConflict,
    createAccountLinkRequest,
    getAccountLinkRequest,
    linkAccounts,
    rejectAccountLinkRequest,
    getUserConnectedAccounts,
    disconnectAccount,
  } = await import("./account-linking");

  // POST /api/account-linking/check - Check if email has account conflict
  if (request.method === "POST" && pathname === "/api/account-linking/check") {
    try {
      const body = (await request.json()) as any;
      const { email, providerId } = body;

      if (!email || !providerId) {
        return new Response(
          JSON.stringify({ error: "email and providerId are required" }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      const result = await checkAccountConflict(env.DB, email, providerId);

      return new Response(JSON.stringify(result), {
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error checking account conflict:", error);
      return new Response(
        JSON.stringify({ error: "Failed to check account conflict" }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // POST /api/account-linking/request - Create account link request
  if (
    request.method === "POST" &&
    pathname === "/api/account-linking/request"
  ) {
    try {
      const body = (await request.json()) as any;
      const { existingUserId, email, providerId, accountId, providerData } =
        body;

      if (!existingUserId || !email || !providerId || !accountId) {
        return new Response(
          JSON.stringify({
            error:
              "existingUserId, email, providerId, and accountId are required",
          }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      const linkRequest = await createAccountLinkRequest(
        env.DB,
        existingUserId,
        email,
        providerId,
        accountId,
        providerData,
      );

      return new Response(JSON.stringify({ linkRequest }), {
        status: 201,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error creating account link request:", error);
      return new Response(
        JSON.stringify({ error: "Failed to create account link request" }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // GET /api/account-linking/request/:token - Get account link request
  if (
    request.method === "GET" &&
    pathname.match(/^\/api\/account-linking\/request\/[^/]+$/)
  ) {
    try {
      const token = pathname.split("/").pop();

      if (!token) {
        return new Response(JSON.stringify({ error: "Token is required" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const linkRequest = await getAccountLinkRequest(env.DB, token);

      if (!linkRequest) {
        return new Response(
          JSON.stringify({ error: "Link request not found or expired" }),
          {
            status: 404,
            headers: corsHeaders,
          },
        );
      }

      return new Response(JSON.stringify({ linkRequest }), {
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error getting account link request:", error);
      return new Response(
        JSON.stringify({ error: "Failed to get account link request" }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // POST /api/account-linking/confirm - Confirm and link accounts
  if (
    request.method === "POST" &&
    pathname === "/api/account-linking/confirm"
  ) {
    try {
      const body = (await request.json()) as any;
      const { token } = body;

      if (!token) {
        return new Response(JSON.stringify({ error: "Token is required" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const linkRequest = await getAccountLinkRequest(env.DB, token);

      if (!linkRequest) {
        return new Response(
          JSON.stringify({ error: "Link request not found or expired" }),
          {
            status: 404,
            headers: corsHeaders,
          },
        );
      }

      const result = await linkAccounts(env.DB, linkRequest);

      if (!result.success) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: "Accounts linked successfully",
        }),
        {
          headers: corsHeaders,
        },
      );
    } catch (error) {
      console.error("Error confirming account link:", error);
      return new Response(
        JSON.stringify({ error: "Failed to link accounts" }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // POST /api/account-linking/reject - Reject account link request
  if (request.method === "POST" && pathname === "/api/account-linking/reject") {
    try {
      const body = (await request.json()) as any;
      const { token } = body;

      if (!token) {
        return new Response(JSON.stringify({ error: "Token is required" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      await rejectAccountLinkRequest(env.DB, token);

      return new Response(
        JSON.stringify({ success: true, message: "Link request rejected" }),
        {
          headers: corsHeaders,
        },
      );
    } catch (error) {
      console.error("Error rejecting account link:", error);
      return new Response(
        JSON.stringify({ error: "Failed to reject link request" }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // GET /api/account-linking/connected/:userId - Get connected accounts
  if (
    request.method === "GET" &&
    pathname.match(/^\/api\/account-linking\/connected\/[^/]+$/)
  ) {
    try {
      const userId = pathname.split("/").pop();

      if (!userId) {
        return new Response(JSON.stringify({ error: "User ID is required" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const accounts = await getUserConnectedAccounts(env.DB, userId);

      return new Response(JSON.stringify({ accounts }), {
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error getting connected accounts:", error);
      return new Response(
        JSON.stringify({ error: "Failed to get connected accounts" }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // DELETE /api/account-linking/disconnect - Disconnect account
  if (
    request.method === "DELETE" &&
    pathname === "/api/account-linking/disconnect"
  ) {
    try {
      const body = (await request.json()) as any;
      const { userId, accountId } = body;

      if (!userId || !accountId) {
        return new Response(
          JSON.stringify({ error: "userId and accountId are required" }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      const result = await disconnectAccount(env.DB, userId, accountId);

      if (!result.success) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: "Account disconnected successfully",
        }),
        {
          headers: corsHeaders,
        },
      );
    } catch (error) {
      console.error("Error disconnecting account:", error);
      return new Response(
        JSON.stringify({ error: "Failed to disconnect account" }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: corsHeaders,
  });
}

/**
 * Handle Image Upload API requests
 * Upload images to R2 bucket
 */
export async function handleImageUploadAPI(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  const pathname = url.pathname;

  // POST /api/upload/image - Upload image to R2
  if (request.method === "POST" && pathname === "/api/upload/image") {
    try {
      const contentType = request.headers.get("content-type") || "";

      if (!contentType.includes("application/json")) {
        return new Response(
          JSON.stringify({ error: "Content-Type must be application/json" }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      const body = (await request.json()) as any;

      // Validate required fields
      if (!body.image) {
        return new Response(
          JSON.stringify({ error: "Image data is required" }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      if (!body.fileName) {
        return new Response(
          JSON.stringify({ error: "File name is required" }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      // Extract base64 data from data URL
      let base64Data = body.image;
      let mimeType = "image/png"; // default

      console.log(
        `Received image data, starts with: ${base64Data.substring(0, 100)}`,
      );

      // Check if it's a data URL (data:image/png;base64,...)
      if (base64Data.startsWith("data:")) {
        // Find the base64 data after "base64,"
        const base64Index = base64Data.indexOf("base64,");
        if (base64Index === -1) {
          return new Response(
            JSON.stringify({
              error: "Invalid image data format - no base64 marker found",
            }),
            {
              status: 400,
              headers: corsHeaders,
            },
          );
        }

        // Extract MIME type
        const mimeMatch = base64Data.match(/^data:([^;]+);/);
        if (mimeMatch) {
          mimeType = mimeMatch[1];
        }

        // Get base64 data after "base64,"
        base64Data = base64Data.substring(base64Index + 7);
      }

      // Clean up base64 string - remove any whitespace, newlines, etc.
      base64Data = base64Data.replace(/\s/g, "");

      // Validate base64 string contains only valid characters
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64Data)) {
        console.error("Base64 contains invalid characters");
        // Find first invalid character for debugging
        const firstInvalid = base64Data
          .split("")
          .findIndex((c: string) => !/[A-Za-z0-9+/=]/.test(c));
        console.error(
          `First invalid char at position ${firstInvalid}: ${base64Data[firstInvalid]}`,
        );
        return new Response(
          JSON.stringify({
            error: "Invalid base64 data",
            details: `Base64 string contains invalid characters at position ${firstInvalid}`,
          }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      console.log(
        `Base64 length: ${base64Data.length}, MIME type: ${mimeType}`,
      );

      // Convert base64 to binary
      let binaryString;
      try {
        binaryString = atob(base64Data);
        console.log(
          `Successfully decoded base64, binary length: ${binaryString.length}`,
        );
      } catch (error) {
        console.error("Failed to decode base64:", error);
        return new Response(
          JSON.stringify({
            error: "Invalid base64 data",
            details: error instanceof Error ? error.message : "Unknown error",
          }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Generate unique file name
      const timestamp = Date.now();
      const randomStr = crypto.randomUUID().substring(0, 8);
      const fileExtension = mimeType.split("/")[1] || "png";
      const uniqueFileName = `${timestamp}-${randomStr}-${body.fileName.replace(/[^a-zA-Z0-9.-]/g, "_")}.${fileExtension}`;

      // Determine folder based on type
      const folder = body.type === "sponsor" ? "sponsors" : "users";
      const key = `${folder}/${uniqueFileName}`;

      // Upload to R2
      await env.IMAGES.put(key, bytes, {
        httpMetadata: {
          contentType: mimeType,
        },
      });

      // Generate public URL
      // Note: You'll need to configure R2 public access or use a custom domain
      // For now, we'll return a path that can be served through the worker
      const imageUrl = `/api/images/${key}`;

      return new Response(
        JSON.stringify({
          success: true,
          url: imageUrl,
          key: key,
        }),
        {
          status: 201,
          headers: corsHeaders,
        },
      );
    } catch (error) {
      console.error("Error uploading image:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to upload image",
          details: error instanceof Error ? error.message : "Unknown error",
        }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: corsHeaders,
  });
}

/**
 * Handle Image Serving API requests
 * Serve images from R2 bucket
 */
export async function handleImageServingAPI(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const pathname = url.pathname;

  // GET /api/images/* - Serve image from R2
  if (request.method === "GET" && pathname.startsWith("/api/images/")) {
    try {
      // Extract key from pathname (remove /api/images/ prefix)
      const key = pathname.replace("/api/images/", "");

      if (!key) {
        return new Response("Image not found", { status: 404 });
      }

      // Get image from R2
      const object = await env.IMAGES.get(key);

      if (!object) {
        return new Response("Image not found", { status: 404 });
      }

      // Return image with proper headers
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Cache-Control", "public, max-age=31536000"); // Cache for 1 year
      headers.set("Access-Control-Allow-Origin", "*");

      return new Response(object.body, {
        headers,
      });
    } catch (error) {
      console.error("Error serving image:", error);
      return new Response("Internal server error", { status: 500 });
    }
  }

  return new Response("Not found", { status: 404 });
}

/**
 * Handle Proof of Work API requests
 */
export async function handleProofOfWorkAPI(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const pathname = url.pathname;

  // GET /api/proof-of-work/:username - Get all proof of work for a user
  if (
    request.method === "GET" &&
    pathname.match(/^\/api\/proof-of-work\/[^/]+$/)
  ) {
    const username = pathname.split("/").pop();

    // First, find user_id from username
    const userProfile = await env.DB.prepare(
      `SELECT user_id FROM user_profiles WHERE username = ?`,
    )
      .bind(username)
      .first();

    if (!userProfile) {
      return new Response(JSON.stringify({ works: [] }), {
        headers: corsHeaders,
      });
    }

    const { results } = await env.DB.prepare(
      `SELECT * FROM proof_of_work WHERE user_id = ? ORDER BY created_at DESC`,
    )
      .bind(userProfile.user_id)
      .all();

    // Parse skills JSON
    const works = results.map((work: any) => ({
      ...work,
      skills: work.skills ? JSON.parse(work.skills) : [],
    }));

    return new Response(JSON.stringify({ works }), {
      headers: corsHeaders,
    });
  }

  // POST /api/proof-of-work - Create new proof of work
  if (request.method === "POST" && pathname === "/api/proof-of-work") {
    try {
      const body = (await request.json()) as any;

      console.log("Received proof of work data:", {
        user_id: body.user_id,
        username: body.username,
        title: body.title,
        description: body.description,
        skills: body.skills,
        link: body.link,
      });

      // Validate required fields
      if (
        !body.user_id ||
        !body.username ||
        !body.title ||
        !body.description ||
        !body.skills ||
        !body.link
      ) {
        console.log("Validation failed:", {
          user_id: !!body.user_id,
          username: !!body.username,
          title: !!body.title,
          description: !!body.description,
          skills: !!body.skills,
          link: !!body.link,
        });
        return new Response(
          JSON.stringify({ error: "Missing required fields" }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);

      await env.DB.prepare(
        `INSERT INTO proof_of_work (
          id, user_id, username, title, description, skills, link, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          body.user_id,
          body.username,
          body.title,
          body.description,
          JSON.stringify(body.skills),
          body.link,
          now,
          now,
        )
        .run();

      const work = await env.DB.prepare(
        `SELECT * FROM proof_of_work WHERE id = ?`,
      )
        .bind(id)
        .first();

      return new Response(
        JSON.stringify({
          work: {
            ...work,
            skills: work ? JSON.parse((work as any).skills) : [],
          },
        }),
        {
          status: 201,
          headers: corsHeaders,
        },
      );
    } catch (error: any) {
      console.error("Error creating proof of work:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to create proof of work",
          details: error.message,
        }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // PUT /api/proof-of-work/:id - Update proof of work
  if (
    request.method === "PUT" &&
    pathname.match(/^\/api\/proof-of-work\/[^/]+$/)
  ) {
    try {
      const id = pathname.split("/").pop();
      const body = (await request.json()) as any;
      const now = Math.floor(Date.now() / 1000);

      // Build update query dynamically
      const updates: string[] = [];
      const values: any[] = [];

      if (body.title !== undefined) {
        updates.push("title = ?");
        values.push(body.title);
      }
      if (body.description !== undefined) {
        updates.push("description = ?");
        values.push(body.description);
      }
      if (body.skills !== undefined) {
        updates.push("skills = ?");
        values.push(JSON.stringify(body.skills));
      }
      if (body.link !== undefined) {
        updates.push("link = ?");
        values.push(body.link);
      }

      updates.push("updated_at = ?");
      values.push(now);
      values.push(id);

      if (updates.length > 1) {
        await env.DB.prepare(
          `UPDATE proof_of_work SET ${updates.join(", ")} WHERE id = ?`,
        )
          .bind(...values)
          .run();
      }

      const work = await env.DB.prepare(
        `SELECT * FROM proof_of_work WHERE id = ?`,
      )
        .bind(id)
        .first();

      return new Response(
        JSON.stringify({
          work: work
            ? { ...work, skills: JSON.parse((work as any).skills) }
            : null,
        }),
        {
          headers: corsHeaders,
        },
      );
    } catch (error: any) {
      console.error("Error updating proof of work:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to update proof of work",
          details: error.message,
        }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // DELETE /api/proof-of-work/:id - Delete proof of work
  if (
    request.method === "DELETE" &&
    pathname.match(/^\/api\/proof-of-work\/[^/]+$/)
  ) {
    try {
      const id = pathname.split("/").pop();

      await env.DB.prepare(`DELETE FROM proof_of_work WHERE id = ?`)
        .bind(id)
        .run();

      return new Response(
        JSON.stringify({ success: true, message: "Proof of work deleted" }),
        {
          headers: corsHeaders,
        },
      );
    } catch (error: any) {
      console.error("Error deleting proof of work:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to delete proof of work",
          details: error.message,
        }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: corsHeaders,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// dApp submission — creates a branch + files + PR via GitHub bot token
// ─────────────────────────────────────────────────────────────────────────────

interface SubmitDappBody {
  name: string;
  description: string;
  short_description: string;
  tags: string[];
  links: {
    website: string;
    careers?: string;
    twitter?: string;
    telegram?: string;
    discord?: string;
    docs?: string;
    github?: string;
    youtube?: string;
    medium?: string;
    mirror?: string;
    linkedin?: string;
  };
  twitterName?: string;
  teamInfo?: {
    contactEmail?: string;
    founded?: string;
    anonymous?: boolean;
  };
  logoImage: string; // base64 data URL
  bannerImage: string; // base64 data URL
  previewImage: string; // base64 data URL
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function stripDataUrl(dataUrl: string): string {
  return dataUrl.replace(/^data:[^;]+;base64,/, "");
}

async function githubApiFetch(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "User-Agent": "alphland-submit-bot",
      ...(options.headers || {}),
    },
  });
  const data = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(
      `GitHub API ${res.status} on ${path}: ${JSON.stringify(data.message ?? data)}`,
    );
  }
  return data;
}

async function putRepoFile(
  repo: string,
  branch: string,
  token: string,
  filePath: string,
  base64Content: string,
  message: string,
): Promise<void> {
  await githubApiFetch(`/repos/${repo}/contents/${filePath}`, token, {
    method: "PUT",
    body: JSON.stringify({ message, content: base64Content, branch }),
  });
}

export async function handleSubmitDappAPI(
  request: Request,
  env: Env,
  _url: URL,
): Promise<Response> {
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });

  if (!env.GITHUB_ISSUES_TOKEN) {
    return json({ error: "GitHub bot token not configured" }, 500);
  }

  let body: SubmitDappBody;
  try {
    body = (await request.json()) as SubmitDappBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const missing: string[] = [];
  if (!body.name?.trim()) missing.push("name");
  if (!body.description?.trim()) missing.push("description");
  if (!body.short_description?.trim()) missing.push("short_description");
  if (!body.tags?.length) missing.push("tags");
  if (!body.links?.website?.trim()) missing.push("links.website");
  if (!body.logoImage) missing.push("logo image");
  if (!body.bannerImage) missing.push("banner image");
  if (!body.previewImage) missing.push("preview image");
  if (missing.length)
    return json(
      { error: `Missing required fields: ${missing.join(", ")}` },
      400,
    );

  if (body.short_description.trim().length > 60) {
    return json({ error: "short_description exceeds 60 characters" }, 400);
  }

  try {
    const token = env.GITHUB_ISSUES_TOKEN;
    const repo = "alph-land/alphland";
    const baseBranch = "develop";
    const slug = slugify(body.name.trim());
    const branchName = `submit/dapp-${slug}-${Date.now()}`;
    const folder = `public/dapps/${slug}`;
    const links = body.links ?? {};
    const teamInfo = body.teamInfo ?? {};

    // 1. Get base branch SHA
    const baseRef = await githubApiFetch(
      `/repos/${repo}/git/ref/heads/${baseBranch}`,
      token,
    );
    const baseSha = baseRef.object.sha;

    // 2. Create new branch
    await githubApiFetch(`/repos/${repo}/git/refs`, token, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
    });

    // 3. Upload images
    await putRepoFile(
      repo,
      branchName,
      token,
      `${folder}/${slug}-logo.webp`,
      stripDataUrl(body.logoImage),
      `chore: add ${body.name} logo`,
    );
    await putRepoFile(
      repo,
      branchName,
      token,
      `${folder}/${slug}-banner.webp`,
      stripDataUrl(body.bannerImage),
      `chore: add ${body.name} banner`,
    );
    await putRepoFile(
      repo,
      branchName,
      token,
      `${folder}/${slug}-preview.webp`,
      stripDataUrl(body.previewImage),
      `chore: add ${body.name} preview`,
    );

    // 4. Build and upload dApp JSON
    const foundedRaw = teamInfo.founded?.trim() ?? "";
    const dappJson = {
      name: body.name.trim(),
      description: body.description.trim(),
      short_description: body.short_description.trim(),
      tags: body.tags,
      verified: false,
      dotw: false,
      councils_choice: false,
      links: {
        website: links.website?.trim() ?? "",
        careers: links.careers?.trim() ?? "",
        twitter: links.twitter?.trim() ?? "",
        telegram: links.telegram?.trim() ?? "",
        discord: links.discord?.trim() ?? "",
        docs: links.docs?.trim() ?? "",
        github: links.github?.trim() ?? "",
        youtube: links.youtube?.trim() ?? "",
        medium: links.medium?.trim() ?? "",
        mirror: links.mirror?.trim() ?? "",
        linkedin: links.linkedin?.trim() ?? "",
      },
      twitterName: body.twitterName?.trim() ?? "",
      teamInfo: {
        // The PR and data file are public; never commit the submitter's email.
        contactEmail: "",
        founded: foundedRaw ? `${foundedRaw}T00:00:00.000Z` : "",
        anonymous: teamInfo.anonymous ?? false,
      },
      media: {
        logoUrl: `/dapps/${slug}/${slug}-logo.webp`,
        bannerUrl: `/dapps/${slug}/${slug}-banner.webp`,
        previewUrl: `/dapps/${slug}/${slug}-preview.webp`,
      },
      contracts: [],
      audits: [],
      tokens: [],
    };

    const jsonBase64 = btoa(
      unescape(encodeURIComponent(JSON.stringify(dappJson, null, 2))),
    );
    await putRepoFile(
      repo,
      branchName,
      token,
      `data/${slug}.json`,
      jsonBase64,
      `feat: add dApp ${body.name}`,
    );

    // 5. Open PR → develop
    const prBody = `## New dApp Submission

**Name:** ${body.name}

**Short Description:** ${body.short_description}

**Description:**
${body.description}

**Tags:** ${body.tags.join(", ")}

**Website:** ${links.website}

### Links
| Platform | URL |
|----------|-----|
| Twitter | ${links.twitter || "-"} |
| Discord | ${links.discord || "-"} |
| Telegram | ${links.telegram || "-"} |
| GitHub | ${links.github || "-"} |
| Docs | ${links.docs || "-"} |

### Team Info
- **Contact Email:** ${teamInfo.contactEmail?.trim() ? "Provided (withheld from public PR)" : "Not provided"}
- **Anonymous Team:** ${teamInfo.anonymous ? "Yes" : "No"}

---
*Submitted via [Alphland Submit Form](https://alph.land/submit)*`;

    const pr = await githubApiFetch(`/repos/${repo}/pulls`, token, {
      method: "POST",
      body: JSON.stringify({
        title: `Add dApp: ${body.name}`,
        body: prBody,
        head: branchName,
        base: baseBranch,
      }),
    });

    return json({ prUrl: pr.html_url, prNumber: pr.number });
  } catch (err) {
    console.error("[submit-dapp] error:", err);
    return json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      500,
    );
  }
}

/**
 * Email preferences and one-click unsubscribe.
 *
 *   GET  /api/email/preferences        -> { unsubscribed: string[] }   (session)
 *   PUT  /api/email/preferences        <- { unsubscribed: string[] }   (session)
 *   GET  /api/email/unsubscribe?u&c&t  -> HTML confirmation            (signed)
 *   POST /api/email/unsubscribe?u&c&t  -> 200                          (signed)
 *
 * The unsubscribe routes take no session on purpose: the link is followed
 * from a mail client, often on a device that is not logged in, and RFC 8058
 * one-click requires an unauthenticated POST. Authorization comes from the
 * HMAC over (userId, category) instead — a bare user id in the URL would let
 * anyone unsubscribe anyone.
 */
export async function handleEmailAPI(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: corsHeaders });

  try {
    if (url.pathname === "/api/email/unsubscribe") {
      const userId = url.searchParams.get("u") || "";
      const category = url.searchParams.get("c") || "";
      const token = url.searchParams.get("t") || "";

      if (!userId || !category || !token) {
        return json({ error: "Missing parameters" }, 400);
      }
      if (category !== "all" && !EMAIL_CATEGORIES.includes(category as any)) {
        return json({ error: "Unknown category" }, 400);
      }
      if (!(await verifyUnsubscribe(env, userId, category, token))) {
        return json({ error: "Invalid or expired link" }, 403);
      }

      await env.DB.prepare(
        `INSERT INTO email_unsubscribes (user_id, category) VALUES (?, ?)
         ON CONFLICT(user_id, category) DO NOTHING`,
      )
        .bind(userId, category)
        .run();

      // One-click clients want a bare 200, not a page.
      if (request.method === "POST") return json({ ok: true });

      return new Response(
        `<!doctype html><meta charset="utf-8">
         <title>Unsubscribed – Alphland</title>
         <div style="font-family:Arial,sans-serif;max-width:520px;margin:80px auto;color:#111;text-align:center;">
           <h2 style="color:#E05C2A;">You're unsubscribed</h2>
           <p>You will no longer receive <strong>${category}</strong> emails from Alphland.</p>
           <p style="color:#888;font-size:14px;">Changed your mind? Turn them back on in your account settings.</p>
           <a href="https://alph.land/bounty/profile" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:6px;margin-top:16px;">Account settings</a>
         </div>`,
        {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    }

    if (url.pathname === "/api/email/preferences") {
      const sessionUserId = await getSessionUserId(env, request);
      if (!sessionUserId) return json({ error: "Unauthorized" }, 401);

      if (request.method === "GET") {
        const rows = (await env.DB.prepare(
          `SELECT category FROM email_unsubscribes WHERE user_id = ?`,
        )
          .bind(sessionUserId)
          .all()) as { results?: { category: string }[] };

        return json({
          categories: EMAIL_CATEGORIES,
          unsubscribed: (rows.results ?? []).map((r) => r.category),
        });
      }

      if (request.method === "PUT") {
        const body = (await request.json()) as { unsubscribed?: unknown };
        const list = Array.isArray(body.unsubscribed) ? body.unsubscribed : [];

        const valid = list.filter(
          (c): c is string =>
            typeof c === "string" &&
            (c === "all" || EMAIL_CATEGORIES.includes(c as any)),
        );
        if (valid.length !== list.length) {
          return json({ error: "Unknown category" }, 400);
        }

        // Replace the whole set: the settings page always sends the full
        // state, so a removed entry means "resubscribe".
        await env.DB.prepare(`DELETE FROM email_unsubscribes WHERE user_id = ?`)
          .bind(sessionUserId)
          .run();

        for (const category of valid) {
          await env.DB.prepare(
            `INSERT INTO email_unsubscribes (user_id, category) VALUES (?, ?)
             ON CONFLICT(user_id, category) DO NOTHING`,
          )
            .bind(sessionUserId, category)
            .run();
        }

        return json({ ok: true, unsubscribed: valid });
      }

      return json({ error: "Method not allowed" }, 405);
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error("[email-api] error:", err);
    return json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      500,
    );
  }
}
