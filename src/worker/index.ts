/**
 * Cloudflare Worker for Alphland API
 * This worker handles API requests and connects to D1 database
 */
import { createAuth, corsOriginFor } from "./auth";
import { notifySponsorAccountChange } from "./email";
import { notifySponsorStatusChanged } from "./notifications";
import { verifySignedMessage } from "@alephium/web3";
import { DAPP_LIST } from "./dappList";
import {
  handleSubmissionsAPI,
  handleCommentsAPI,
  handleSponsorsAPI,
  handleNotificationsAPI,
  handleEmailAPI,
  handleNotificationPreferencesAPI,
  handleUserDeletionAPI,
  handleBookmarksAPI,
  handleAccountLinkingAPI,
  handleImageUploadAPI,
  handleImageServingAPI,
  handleProofOfWorkAPI,
  handleSubmitDappAPI,
  getSessionUserId,
  isGodUser,
} from "./handlers";
import {
  getAlphPrice,
  maybeRefreshDailyPrice,
  refreshAlphPrice,
  resolveRewardInput,
  RateUnavailableError,
} from "./price";
// Shared with the frontend on purpose — one derivation of display status for
// both sides. The module is dependency-free so it bundles into the Worker.
import { getBountyDisplayStatus } from "@/features/bounty/utils/bountyStatus";
import { bountySlug } from "@/features/bounty/utils/validators";
import { runBountyReminders } from "./reminders";

// Type definition for D1Database (fallback for when @cloudflare/workers-types is not available)
type D1Database = any;
type R2Bucket = any;

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket; // R2 bucket for image storage
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string; // Frontend URL (e.g., http://localhost:3000)
  APP_URL?: string; // Same as BETTER_AUTH_URL
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  GITHUB_ISSUES_TOKEN?: string; // GitHub token for creating issues
  GITHUB_BOT_TOKEN?: string; // unused — dApp submissions use GITHUB_ISSUES_TOKEN
  INTERNAL_SECRET?: string; // shared secret for internal Vercel → Worker calls
  COINGECKO_API_KEY?: string; // optional demo key; keyless works at 1 call/day
}

// Note: Do NOT cache auth instance globally
// D1 binding is only available within request context

const worker = {
  async fetch(request: Request, env: Env, _ctx: any): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers - must allow credentials for cookie-based auth, so the
    // origin is one of ours, never whatever the request claims
    const corsHeaders = {
      "Access-Control-Allow-Origin": corsOriginFor(request, env),
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie",
      "Access-Control-Allow-Credentials": "true", // Required for cookies
    };

    // Handle preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Route handling
    try {
      // Handle auth routes - create fresh auth instance per request
      // D1 binding is only available within request context
      if (url.pathname.startsWith("/api/auth/")) {
        console.log(`[AUTH] ${request.method} ${url.pathname}${url.search}`);
        console.log(
          `[AUTH] GOOGLE_CLIENT_ID: ${env.GOOGLE_CLIENT_ID ? "SET" : "NOT SET"}`,
        );
        console.log(
          `[AUTH] GOOGLE_CLIENT_SECRET: ${env.GOOGLE_CLIENT_SECRET ? "SET" : "NOT SET"}`,
        );
        console.log(`[AUTH] BETTER_AUTH_URL: ${env.BETTER_AUTH_URL}`);

        try {
          const auth = createAuth(
            env.DB,
            {
              GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
              GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
              BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
              BETTER_AUTH_URL: env.BETTER_AUTH_URL,
              APP_URL: env.APP_URL,
              RESEND_API_KEY: env.RESEND_API_KEY,
              FROM_EMAIL: env.FROM_EMAIL,
            },
            _ctx, // Pass ExecutionContext for background email sending
          );

          console.log("[AUTH] Auth instance created successfully");

          // Handle auth endpoints using better-auth
          const response = await auth.handler(request);
          console.log(`[AUTH] Response status: ${response.status}`);
          console.log(
            `[AUTH] Response headers:`,
            Object.fromEntries(response.headers),
          );

          const responseText = await response.text();
          console.log(`[AUTH] Response body:`, responseText.substring(0, 200));

          // Add CORS headers to auth responses (for non-redirect responses)
          if (response.status < 300 || response.status >= 400) {
            const newHeaders = new Headers(response.headers);
            Object.entries(corsHeaders).forEach(([key, value]) => {
              newHeaders.set(key, value);
            });
            return new Response(responseText, {
              status: response.status,
              statusText: response.statusText,
              headers: newHeaders,
            });
          }

          // Return response with original body for redirects
          return new Response(responseText, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch (authError) {
          console.error("[AUTH] Error handling auth request:", authError);
          const errorMessage =
            authError instanceof Error ? authError.message : "Unknown error";
          return new Response(
            JSON.stringify({
              error: "Auth handler error",
              details: errorMessage,
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }
      }

      // Health check endpoint
      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({ status: "ok", timestamp: Date.now() }),
          {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          },
        );
      }

      // Database test endpoint
      if (url.pathname === "/api/db-test") {
        const result = await env.DB.prepare("SELECT 1 as test").first();
        return new Response(JSON.stringify({ success: true, result }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // ==========================================
      // Admin Analytics APIs
      // ==========================================

      // All /api/admin/* routes require a god-user session
      if (url.pathname.startsWith("/api/admin/")) {
        const sessionUserId = await getSessionUserId(env, request);
        const isGod = sessionUserId
          ? await isGodUser(env, sessionUserId)
          : false;
        if (!isGod) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: sessionUserId ? 403 : 401,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
      }

      // GET /api/admin/user-stats - User statistics overview
      if (url.pathname === "/api/admin/user-stats") {
        const nowMs = Date.now();
        // better-auth stores createdAt as ISO strings — compare using ISO format
        const todayStartIso = new Date(
          nowMs - (nowMs % (86400 * 1000)),
        ).toISOString();
        const weekAgoIso = new Date(nowMs - 7 * 86400 * 1000).toISOString();
        const monthAgoIso = new Date(nowMs - 30 * 86400 * 1000).toISOString();
        const twoWeeksAgoIso = new Date(
          nowMs - 14 * 86400 * 1000,
        ).toISOString();

        // Total users
        const totalUsers = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM user`,
        ).first();

        // New users today
        const newToday = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM user WHERE createdAt >= ?`,
        )
          .bind(todayStartIso)
          .first();

        // New users this week
        const newThisWeek = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM user WHERE createdAt >= ?`,
        )
          .bind(weekAgoIso)
          .first();

        // New users this month
        const newThisMonth = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM user WHERE createdAt >= ?`,
        )
          .bind(monthAgoIso)
          .first();

        // WAU - users with sessions in last 7 days
        const wau = await env.DB.prepare(
          `SELECT COUNT(DISTINCT userId) as count FROM session WHERE createdAt >= ?`,
        )
          .bind(weekAgoIso)
          .first();

        // MAU - users with sessions in last 30 days
        const mau = await env.DB.prepare(
          `SELECT COUNT(DISTINCT userId) as count FROM session WHERE createdAt >= ?`,
        )
          .bind(monthAgoIso)
          .first();

        // Daily new users for last 14 days (for trend chart)
        const { results: dailyTrend } = await env.DB.prepare(
          `SELECT
            DATE(createdAt) as date,
            COUNT(*) as count
          FROM user
          WHERE createdAt >= ?
          GROUP BY DATE(createdAt)
          ORDER BY date ASC`,
        )
          .bind(twoWeeksAgoIso)
          .all();

        return new Response(
          JSON.stringify({
            total_users: totalUsers?.count || 0,
            new_today: newToday?.count || 0,
            new_this_week: newThisWeek?.count || 0,
            new_this_month: newThisMonth?.count || 0,
            wau: wau?.count || 0,
            mau: mau?.count || 0,
            daily_trend: dailyTrend || [],
          }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }

      // GET /api/admin/users - User list with search
      if (url.pathname === "/api/admin/users") {
        const search = url.searchParams.get("search") || "";
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const offset = parseInt(url.searchParams.get("offset") || "0");

        // Try query with is_banned column first, fallback without it
        let query = `
          SELECT
            u.id, u.email, u.name, u.image, COALESCE(u.is_banned, 0) as is_banned, u.createdAt,
            COALESCE(u.role, NULL) as role,
            up.username, up.wallet_address,
            (SELECT COUNT(*) FROM bounty_submissions WHERE user_id = u.id) as submission_count,
            (SELECT COUNT(*) FROM bounty_submissions WHERE user_id = u.id AND status = 'approved') as approved_count,
            (SELECT COUNT(*) FROM bookmarks WHERE user_id = u.id) as bookmark_count
          FROM user u
          LEFT JOIN user_profiles up ON u.id = up.user_id
        `;

        const params: any[] = [];
        if (search) {
          query += ` WHERE u.email LIKE ? OR u.name LIKE ? OR up.username LIKE ?`;
          params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        query += ` ORDER BY u.createdAt DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        let results;
        try {
          const response = await env.DB.prepare(query)
            .bind(...params)
            .all();
          results = response.results;
        } catch (error) {
          // Fallback query without is_banned if column doesn't exist
          console.error(
            "Admin users query failed, trying without is_banned:",
            error,
          );
          let fallbackQuery = `
            SELECT
              u.id, u.email, u.name, u.image, 0 as is_banned, u.createdAt,
              NULL as role,
              up.username, up.wallet_address,
              (SELECT COUNT(*) FROM bounty_submissions WHERE user_id = u.id) as submission_count,
              (SELECT COUNT(*) FROM bounty_submissions WHERE user_id = u.id AND status = 'approved') as approved_count,
              (SELECT COUNT(*) FROM bookmarks WHERE user_id = u.id) as bookmark_count
            FROM user u
            LEFT JOIN user_profiles up ON u.id = up.user_id
          `;
          const fallbackParams: any[] = [];
          if (search) {
            fallbackQuery += ` WHERE u.email LIKE ? OR u.name LIKE ? OR up.username LIKE ?`;
            fallbackParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
          }
          fallbackQuery += ` ORDER BY u.createdAt DESC LIMIT ? OFFSET ?`;
          fallbackParams.push(limit, offset);
          const response = await env.DB.prepare(fallbackQuery)
            .bind(...fallbackParams)
            .all();
          results = response.results;
        }

        // Get total count
        let countQuery = `SELECT COUNT(*) as count FROM user u LEFT JOIN user_profiles up ON u.id = up.user_id`;
        if (search) {
          countQuery += ` WHERE u.email LIKE ? OR u.name LIKE ? OR up.username LIKE ?`;
          const countResult = await env.DB.prepare(countQuery)
            .bind(`%${search}%`, `%${search}%`, `%${search}%`)
            .first();
          return new Response(
            JSON.stringify({ users: results, total: countResult?.count || 0 }),
            { headers: { "Content-Type": "application/json", ...corsHeaders } },
          );
        }

        const countResult = await env.DB.prepare(countQuery).first();
        return new Response(
          JSON.stringify({ users: results, total: countResult?.count || 0 }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }

      // GET /api/admin/users/:id - User details
      if (url.pathname.match(/^\/api\/admin\/users\/[^/]+$/)) {
        const userId = url.pathname.split("/").pop();

        const user = await env.DB.prepare(
          `SELECT u.*, up.username, up.bio, up.wallet_address, up.location
           FROM user u
           LEFT JOIN user_profiles up ON u.id = up.user_id
           WHERE u.id = ?`,
        )
          .bind(userId)
          .first();

        if (!user) {
          return new Response(JSON.stringify({ error: "User not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // Recent sessions (last 10)
        const { results: sessions } = await env.DB.prepare(
          `SELECT ipAddress, userAgent, createdAt
           FROM session
           WHERE userId = ?
           ORDER BY createdAt DESC
           LIMIT 10`,
        )
          .bind(userId)
          .all();

        // User submissions
        const { results: submissions } = await env.DB.prepare(
          `SELECT s.*, b.title as bounty_title
           FROM bounty_submissions s
           JOIN bounties b ON s.bounty_id = b.id
           WHERE s.user_id = ?
           ORDER BY s.created_at DESC
           LIMIT 20`,
        )
          .bind(userId)
          .all();

        // User bookmarks
        const { results: bookmarks } = await env.DB.prepare(
          `SELECT bm.*, b.title, b.status
           FROM bookmarks bm
           JOIN bounties b ON bm.bounty_id = b.id
           WHERE bm.user_id = ?
           ORDER BY bm.created_at DESC
           LIMIT 20`,
        )
          .bind(userId)
          .all();

        return new Response(
          JSON.stringify({ user, sessions, submissions, bookmarks }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }

      // PUT /api/admin/users/:id/ban - Ban user
      if (
        request.method === "PUT" &&
        url.pathname.match(/^\/api\/admin\/users\/[^/]+\/ban$/)
      ) {
        const userId = url.pathname.split("/")[4];
        const now = Date.now();

        try {
          await env.DB.prepare(
            `UPDATE user SET is_banned = 1, updatedAt = ? WHERE id = ?`,
          )
            .bind(now, userId)
            .run();

          // Also ban their sponsor if they have one (ignore errors if columns don't exist)
          try {
            await env.DB.prepare(
              `UPDATE sponsors SET is_banned = 1, banned_at = ?, updated_at = ? WHERE user_id = ?`,
            )
              .bind(Math.floor(now / 1000), Math.floor(now / 1000), userId)
              .run();
          } catch {
            // Sponsor ban columns may not exist yet
          }

          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        } catch (error) {
          console.error("Failed to ban user:", error);
          return new Response(
            JSON.stringify({
              error:
                "Failed to ban user. Please run migration 020_add_user_is_banned.sql first.",
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }
      }

      // PUT /api/admin/users/:id/unban - Unban user
      if (
        request.method === "PUT" &&
        url.pathname.match(/^\/api\/admin\/users\/[^/]+\/unban$/)
      ) {
        const userId = url.pathname.split("/")[4];
        const now = Date.now();

        try {
          await env.DB.prepare(
            `UPDATE user SET is_banned = 0, updatedAt = ? WHERE id = ?`,
          )
            .bind(now, userId)
            .run();

          // Also unban their sponsor if they have one (ignore errors if columns don't exist)
          try {
            await env.DB.prepare(
              `UPDATE sponsors SET is_banned = 0, banned_at = NULL, updated_at = ? WHERE user_id = ?`,
            )
              .bind(Math.floor(now / 1000), userId)
              .run();
          } catch {
            // Sponsor ban columns may not exist yet
          }

          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        } catch (error) {
          console.error("Failed to unban user:", error);
          return new Response(
            JSON.stringify({
              error:
                "Failed to unban user. Please run migration 020_add_user_is_banned.sql first.",
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }
      }

      // PUT /api/admin/sponsors/:id/ban
      if (
        request.method === "PUT" &&
        url.pathname.match(/^\/api\/admin\/sponsors\/[^/]+\/ban$/)
      ) {
        const id = url.pathname.split("/")[4];
        const now = Math.floor(Date.now() / 1000);
        try {
          const sponsor = (await env.DB.prepare(
            `SELECT user_id FROM sponsors WHERE id = ?`,
          )
            .bind(id)
            .first()) as { user_id: string } | null;
          if (sponsor) {
            await env.DB.prepare(
              `UPDATE sponsors SET is_banned = 1, banned_at = ?, updated_at = ? WHERE id = ?`,
            )
              .bind(now, now, id)
              .run();

            await notifySponsorNotice(env, id, "banned");
            await env.DB.prepare(
              `UPDATE user SET is_banned = 1, updatedAt = ? WHERE id = ?`,
            )
              .bind(now * 1000, sponsor.user_id)
              .run();
          }
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        } catch (error) {
          console.error("Failed to ban sponsor:", error);
          return new Response(
            JSON.stringify({ error: "Failed to ban sponsor" }),
            {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }
      }

      // PUT /api/admin/sponsors/:id/unban
      if (
        request.method === "PUT" &&
        url.pathname.match(/^\/api\/admin\/sponsors\/[^/]+\/unban$/)
      ) {
        const id = url.pathname.split("/")[4];
        const now = Math.floor(Date.now() / 1000);
        try {
          const sponsor = (await env.DB.prepare(
            `SELECT user_id FROM sponsors WHERE id = ?`,
          )
            .bind(id)
            .first()) as { user_id: string } | null;
          if (sponsor) {
            await env.DB.prepare(
              `UPDATE sponsors SET is_banned = 0, banned_at = NULL, updated_at = ? WHERE id = ?`,
            )
              .bind(now, id)
              .run();

            await notifySponsorNotice(env, id, "unbanned");
            await env.DB.prepare(
              `UPDATE user SET is_banned = 0, updatedAt = ? WHERE id = ?`,
            )
              .bind(now * 1000, sponsor.user_id)
              .run();
          }
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        } catch (error) {
          console.error("Failed to unban sponsor:", error);
          return new Response(
            JSON.stringify({ error: "Failed to unban sponsor" }),
            {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }
      }

      // PUT /api/admin/sponsors/:id/verify
      if (
        request.method === "PUT" &&
        url.pathname.match(/^\/api\/admin\/sponsors\/[^/]+\/verify$/)
      ) {
        const id = url.pathname.split("/")[4];
        const now = Math.floor(Date.now() / 1000);
        try {
          await env.DB.prepare(
            `UPDATE sponsors SET is_verified = 1, status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?`,
          )
            .bind(now, now, id)
            .run();

          // Both the in-app notice and the approval email come from here now.
          await notifySponsorNotice(env, id, "verified");

          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        } catch (error) {
          console.error("Failed to verify sponsor:", error);
          return new Response(
            JSON.stringify({ error: "Failed to verify sponsor" }),
            {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }
      }

      // PUT /api/admin/sponsors/:id/unverify
      if (
        request.method === "PUT" &&
        url.pathname.match(/^\/api\/admin\/sponsors\/[^/]+\/unverify$/)
      ) {
        const id = url.pathname.split("/")[4];
        const now = Math.floor(Date.now() / 1000);
        try {
          await env.DB.prepare(
            `UPDATE sponsors SET is_verified = 0, status = 'pending', approved_at = NULL, updated_at = ? WHERE id = ?`,
          )
            .bind(now, id)
            .run();

          await notifySponsorNotice(env, id, "unverified");
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        } catch (error) {
          console.error("Failed to unverify sponsor:", error);
          return new Response(
            JSON.stringify({ error: "Failed to unverify sponsor" }),
            {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }
      }

      // GET /api/admin/submission-stats - Submission analysis
      if (url.pathname === "/api/admin/submission-stats") {
        // Total submissions and approved
        const totals = await env.DB.prepare(
          `SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved
          FROM bounty_submissions`,
        ).first();

        // Users who have submitted
        const usersWithSubmissions = await env.DB.prepare(
          `SELECT COUNT(DISTINCT user_id) as count FROM bounty_submissions`,
        ).first();

        // Average submissions per user (who submitted)
        const avgSubmissions = usersWithSubmissions?.count
          ? (totals?.total || 0) / (usersWithSubmissions.count as number)
          : 0;

        // Global acceptance rate
        const acceptanceRate = totals?.total
          ? ((totals.approved as number) / (totals.total as number)) * 100
          : 0;

        // Top success rate users (min 2 submissions)
        const { results: topUsers } = await env.DB.prepare(
          `SELECT
            s.user_id,
            u.name,
            u.email,
            up.username,
            COUNT(*) as total_submissions,
            SUM(CASE WHEN s.status = 'approved' THEN 1 ELSE 0 END) as approved,
            ROUND(SUM(CASE WHEN s.status = 'approved' THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) as success_rate
          FROM bounty_submissions s
          JOIN user u ON s.user_id = u.id
          LEFT JOIN user_profiles up ON s.user_id = up.user_id
          GROUP BY s.user_id
          HAVING COUNT(*) >= 2
          ORDER BY success_rate DESC, approved DESC
          LIMIT 10`,
        ).all();

        // Average reward for approved submissions
        // Get reward from bounties table, not submissions
        const avgReward = await env.DB.prepare(
          `SELECT AVG(COALESCE(b.reward_usd, 0)) as avg_amount
           FROM bounty_submissions s
           JOIN bounties b ON s.bounty_id = b.id
           WHERE s.status = 'approved'`,
        ).first();

        return new Response(
          JSON.stringify({
            total_submissions: totals?.total || 0,
            approved_submissions: totals?.approved || 0,
            users_with_submissions: usersWithSubmissions?.count || 0,
            avg_submissions_per_user: Math.round(avgSubmissions * 10) / 10,
            acceptance_rate: Math.round(acceptanceRate * 10) / 10,
            avg_reward: avgReward?.avg_amount || 0,
            top_users: topUsers || [],
          }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }

      // GET /api/admin/bounty-popularity - Bounty popularity stats
      if (url.pathname === "/api/admin/bounty-popularity") {
        // Most bookmarked bounties
        const { results: mostBookmarked } = await env.DB.prepare(
          `SELECT
            b.id, b.title, b.status,
            COALESCE(sp.name, 'Unknown') as sponsor_name,
            COUNT(bm.id) as bookmark_count
          FROM bounties b
          LEFT JOIN sponsors sp ON b.sponsor_id = sp.id
          LEFT JOIN bookmarks bm ON b.id = bm.bounty_id
          WHERE b.status != 'deleted'
          GROUP BY b.id
          ORDER BY bookmark_count DESC
          LIMIT 10`,
        ).all();

        // Most submissions bounties
        const { results: mostSubmissions } = await env.DB.prepare(
          `SELECT
            b.id, b.title, b.status,
            COALESCE(sp.name, 'Unknown') as sponsor_name,
            COUNT(s.id) as submission_count
          FROM bounties b
          LEFT JOIN sponsors sp ON b.sponsor_id = sp.id
          LEFT JOIN bounty_submissions s ON b.id = s.bounty_id
          WHERE b.status != 'deleted'
          GROUP BY b.id
          ORDER BY submission_count DESC
          LIMIT 10`,
        ).all();

        // Most comments bounties
        const { results: mostComments } = await env.DB.prepare(
          `SELECT
            b.id, b.title, b.status,
            COALESCE(sp.name, 'Unknown') as sponsor_name,
            COUNT(c.id) as comment_count
          FROM bounties b
          LEFT JOIN sponsors sp ON b.sponsor_id = sp.id
          LEFT JOIN bounty_comments c ON b.id = c.bounty_id AND c.deleted_at IS NULL
          WHERE b.status != 'deleted'
          GROUP BY b.id
          ORDER BY comment_count DESC
          LIMIT 10`,
        ).all();

        return new Response(
          JSON.stringify({
            most_bookmarked: mostBookmarked || [],
            most_submissions: mostSubmissions || [],
            most_comments: mostComments || [],
          }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }

      // GET /api/admin/email-logs - Resend email send history
      if (url.pathname === "/api/admin/email-logs") {
        const page = parseInt(url.searchParams.get("page") || "1", 10);
        const limit = 50;
        const offset = (page - 1) * limit;
        const type = url.searchParams.get("type") || "";

        const whereClause = type ? "WHERE type = ?" : "";
        const bindings = type ? [limit, offset, type] : [limit, offset];

        const query = type
          ? `SELECT * FROM email_logs WHERE type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
          : `SELECT * FROM email_logs ORDER BY created_at DESC LIMIT ? OFFSET ?`;

        const countQuery = type
          ? `SELECT COUNT(*) as count FROM email_logs WHERE type = ?`
          : `SELECT COUNT(*) as count FROM email_logs`;

        try {
          const [logs, total] = await Promise.all([
            type
              ? env.DB.prepare(query).bind(type, limit, offset).all()
              : env.DB.prepare(query).bind(limit, offset).all(),
            type
              ? env.DB.prepare(countQuery).bind(type).first()
              : env.DB.prepare(countQuery).first(),
          ]);

          const stats = await env.DB.prepare(
            `SELECT type, COUNT(*) as count, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed FROM email_logs GROUP BY type`,
          ).all();

          return new Response(
            JSON.stringify({
              logs: logs?.results || [],
              total: total?.count || 0,
              page,
              stats: stats?.results || [],
            }),
            { headers: { "Content-Type": "application/json", ...corsHeaders } },
          );
        } catch (e) {
          console.error("email-logs error:", e);
          return new Response(
            JSON.stringify({ logs: [], total: 0, page: 1, stats: [] }),
            { headers: { "Content-Type": "application/json", ...corsHeaders } },
          );
        }
      }

      // ==========================================
      // End Admin Analytics APIs
      // ==========================================

      // ALPH/USD rate — public read. Frontend uses this for the "≈ $X"
      // secondary figure next to every ALPH amount.
      if (url.pathname === "/api/price/alph" && request.method === "GET") {
        const price = await getAlphPrice(env);

        if (!price) {
          return new Response(
            JSON.stringify({ error: "No ALPH price available yet" }),
            { status: 503, headers: corsHeaders },
          );
        }

        return new Response(
          JSON.stringify({
            usd: price.usd,
            fetched_at: price.fetched_at,
            source_updated_at: price.source_updated_at,
            source: price.source,
            // Age lets the UI grey out or hide the USD figure if the feed
            // has been stuck (e.g. several failed daily runs in a row).
            age_seconds: Math.floor(Date.now() / 1000) - price.fetched_at,
          }),
          {
            headers: {
              ...corsHeaders,
              // Rate changes at most once a day; let the edge hold it.
              "Cache-Control": "public, max-age=300",
            },
          },
        );
      }

      // Manual refresh — god users only. For testing and for recovering
      // after a failed daily run without waiting for the next 08:00.
      if (
        url.pathname === "/api/price/alph/refresh" &&
        request.method === "POST"
      ) {
        const sessionUserId = await getSessionUserId(env, request);
        if (!sessionUserId) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: corsHeaders,
          });
        }
        if (!(await isGodUser(env, sessionUserId))) {
          return new Response(JSON.stringify({ error: "Forbidden" }), {
            status: 403,
            headers: corsHeaders,
          });
        }

        try {
          const price = await refreshAlphPrice(env);
          return new Response(JSON.stringify({ price }), {
            headers: corsHeaders,
          });
        } catch (err: any) {
          return new Response(
            JSON.stringify({ error: err?.message ?? "Refresh failed" }),
            { status: 502, headers: corsHeaders },
          );
        }
      }

      // Bounty overview stats endpoint - compute dynamically
      if (url.pathname === "/api/bounty-overview") {
        // Get bounty stats
        // reward_amount is ALPH and reward_usd is USD for every row regardless
        // of denomination, so both totals are now real totals covering all
        // bounties — not the two disjoint piles the old CASE expressions
        // produced (an ALPH bounty contributed nothing to the USD figure and
        // vice versa, so neither number described the whole programme).
        const bountyStats = await env.DB.prepare(
          `SELECT
            COUNT(*) as list_number,
            COALESCE(SUM(reward_usd), 0) as total_value_usd,
            COALESCE(SUM(reward_amount), 0) as total_value_alph
          FROM bounties
          WHERE status != 'deleted'`,
        ).first();

        // Get user count
        const userCount = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM user`,
        ).first();

        // Get sponsor count (non-banned if column exists, otherwise all)
        let sponsorCount;
        try {
          sponsorCount = await env.DB.prepare(
            `SELECT COUNT(*) as count FROM sponsors WHERE is_banned = 0 OR is_banned IS NULL`,
          ).first();
        } catch {
          // Fallback if is_banned column doesn't exist yet
          sponsorCount = await env.DB.prepare(
            `SELECT COUNT(*) as count FROM sponsors`,
          ).first();
        }

        const overview = {
          id: 1,
          total_value_usd: bountyStats?.total_value_usd || 0,
          total_value_alph: bountyStats?.total_value_alph || 0,
          list_number: bountyStats?.list_number || 0,
          user_number: userCount?.count || 0,
          sponsor_number: sponsorCount?.count || 0,
          updated_at: Math.floor(Date.now() / 1000),
        };

        return new Response(JSON.stringify({ overview }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Recent earners endpoint - users with submissions in past week
      if (url.pathname === "/api/recent-earners") {
        try {
          const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

          const { results } = await env.DB.prepare(
            `SELECT
              u.id,
              u.name,
              u.image,
              up.username,
              u.image as avatar_url,
              COUNT(s.id) as submission_count
            FROM bounty_submissions s
            JOIN user u ON s.user_id = u.id
            LEFT JOIN user_profiles up ON u.id = up.user_id
            WHERE s.created_at >= ?
            GROUP BY u.id, u.name, u.image, up.username
            HAVING COUNT(s.id) >= 1
            ORDER BY submission_count DESC
            LIMIT 10`,
          )
            .bind(oneWeekAgo)
            .all();

          return new Response(
            JSON.stringify({
              earners: results || [],
            }),
            {
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        } catch (error) {
          console.error("Error fetching recent earners:", error);
          return new Response(
            JSON.stringify({
              error: "Internal server error",
              message: error instanceof Error ? error.message : "Unknown error",
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }
      }

      // Bounties API endpoints
      if (url.pathname.startsWith("/api/bounties")) {
        return handleBountiesAPI(request, env, url);
      }

      // User profile endpoints
      if (url.pathname.startsWith("/api/users")) {
        return handleUsersAPI(request, env, url, _ctx);
      }

      // Wallet endpoints
      if (url.pathname.startsWith("/api/wallet")) {
        return handleUsersAPI(request, env, url, _ctx);
      }

      // Internal endpoints (active-addresses counts, etc.)
      if (url.pathname.startsWith("/api/internal")) {
        return handleUsersAPI(request, env, url, _ctx);
      }

      // Submission endpoints
      if (url.pathname.startsWith("/api/submissions")) {
        return handleSubmissionsAPI(request, env, url);
      }

      // Comments endpoints
      if (url.pathname.startsWith("/api/comments")) {
        return handleCommentsAPI(request, env, url);
      }

      // Sponsors endpoints
      if (url.pathname.startsWith("/api/sponsors")) {
        return handleSponsorsAPI(request, env, url);
      }

      // Notifications endpoints
      if (url.pathname.startsWith("/api/notifications")) {
        return handleNotificationsAPI(request, env, url);
      }

      // Email preferences + one-click unsubscribe (the latter is unauthenticated
      // by design — see handleEmailAPI)
      if (url.pathname.startsWith("/api/email/")) {
        return handleEmailAPI(request, env, url);
      }

      // Notification preferences and mutes endpoints
      if (
        url.pathname.startsWith("/api/notification-preferences") ||
        url.pathname.startsWith("/api/notification-mutes")
      ) {
        return handleNotificationPreferencesAPI(request, env, url);
      }

      // Bookmarks endpoints
      if (url.pathname.startsWith("/api/bookmarks")) {
        return handleBookmarksAPI(request, env, url);
      }

      // Account linking endpoints
      if (url.pathname.startsWith("/api/account-linking")) {
        return handleAccountLinkingAPI(request, env, url);
      }

      // User deletion endpoint
      if (url.pathname.match(/^\/api\/user\/[^/]+$/)) {
        return handleUserDeletionAPI(request, env, url);
      }

      // Image upload endpoint
      if (url.pathname.startsWith("/api/upload/image")) {
        return handleImageUploadAPI(request, env, url);
      }

      // Image serving endpoint
      if (url.pathname.startsWith("/api/images/")) {
        return handleImageServingAPI(request, env, url);
      }

      // Proof of Work endpoints
      if (url.pathname.startsWith("/api/proof-of-work")) {
        return handleProofOfWorkAPI(request, env, url);
      }

      // GitHub Issues API - for report submissions
      if (url.pathname === "/api/github/issues" && request.method === "POST") {
        if (!env.GITHUB_ISSUES_TOKEN) {
          return new Response(
            JSON.stringify({ error: "GitHub token not configured" }),
            {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }

        try {
          const body = (await request.json()) as {
            title: string;
            body: string;
            labels?: string[];
          };

          if (!body.title || !body.body) {
            return new Response(
              JSON.stringify({ error: "Title and body are required" }),
              {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders },
              },
            );
          }

          const githubResponse = await fetch(
            "https://api.github.com/repos/alph-land/alphland/issues",
            {
              method: "POST",
              headers: {
                Authorization: `token ${env.GITHUB_ISSUES_TOKEN}`,
                Accept: "application/vnd.github.v3+json",
                "Content-Type": "application/json",
                "User-Agent": "Alphland-Report-Bot",
              },
              body: JSON.stringify({
                title: body.title,
                body: body.body,
                labels: body.labels || ["report"],
              }),
            },
          );

          if (!githubResponse.ok) {
            const errorData = await githubResponse.text();
            console.error("GitHub API error:", errorData);
            return new Response(
              JSON.stringify({
                error: "Failed to create issue",
                details: errorData,
              }),
              {
                status: githubResponse.status,
                headers: { "Content-Type": "application/json", ...corsHeaders },
              },
            );
          }

          const issue = (await githubResponse.json()) as {
            html_url: string;
            number: number;
          };
          return new Response(
            JSON.stringify({
              success: true,
              issue_url: issue.html_url,
              issue_number: issue.number,
            }),
            {
              status: 201,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        } catch (error) {
          console.error("Error creating GitHub issue:", error);
          return new Response(
            JSON.stringify({
              error: "Failed to create issue",
              message: error instanceof Error ? error.message : "Unknown error",
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }
      }

      // dApp submission endpoint
      if (url.pathname === "/api/submit-dapp" && request.method === "POST") {
        return handleSubmitDappAPI(request, env, url);
      }

      // Apple App Store compliance list: name, developer, url only
      if (url.pathname === "/api/dapp-list" && request.method === "GET") {
        return new Response(JSON.stringify(DAPP_LIST), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            ...corsHeaders,
          },
        });
      }

      // Default 404
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Worker error:", error);
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error instanceof Error ? error.message : "Unknown error",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    }
  },

  // ── Scheduled: index active addresses from Alephium Explorer ──────────────
  // Runs every hour via cron trigger. Reads the cursor from indexer_state,
  // fetches blocks since last run, extracts sender addresses, and upserts into
  // active_addresses. After 7 days the dashboard will show real data.
  async scheduled(_event: any, env: Env, ctx: any): Promise<void> {
    // Daily ALPH/USD refresh at 08:00 Europe/Berlin. The cron fires hourly;
    // this is a no-op on the other 23 runs. Never throws, so a price-feed
    // outage cannot stop the address indexer below.
    await maybeRefreshDailyPrice(env);

    // Deadline and overdue-review reminders. Also never throws — each stage
    // is isolated inside runBountyReminders, so a reminder failure cannot
    // stop the indexer either. Deduplicated against email_logs, not by the
    // schedule: this handler fires hourly.
    await runBountyReminders(env);

    const EXPLORER = "https://lb-fullnode-alephium.notrustverify.ch";
    const MAX_WINDOW_MS = 2 * 60 * 60_000; // process at most 2 hours per run
    const now = Date.now();

    try {
      // Read cursor — if missing, start 1 hour ago (collect forward from now)
      const cursorRow = (await env.DB.prepare(
        `SELECT value FROM indexer_state WHERE key = 'active_addr_cursor'`,
      ).first()) as { value: string } | null;

      const fromTs = cursorRow?.value
        ? Math.min(Number(cursorRow.value), now - 60_000)
        : now - 60 * 60_000;

      const toTs = Math.min(now, fromTs + MAX_WINDOW_MS);

      // Fetch blocks in the time window
      const res = await fetch(
        `${EXPLORER}/blockflow/blocks?fromTs=${fromTs}&toTs=${toTs}`,
        { headers: { Accept: "application/json" } },
      );

      if (!res.ok) {
        console.error(`[active-addr] blocks fetch failed: ${res.status}`);
        return;
      }

      type AlphOutput = { address?: string };
      type AlphTx = {
        unsigned?: { inputs?: unknown[]; fixedOutputs?: AlphOutput[] };
      };
      type AlphBlock = { timestamp?: number; transactions?: AlphTx[] };
      const data = (await res.json()) as { blocks?: AlphBlock[][] };

      if (!Array.isArray(data?.blocks)) {
        console.warn("[active-addr] unexpected blocks response shape");
        return;
      }

      // Collect address → max timestamp seen (from fixedOutputs; skip coinbase txs)
      const addrMap = new Map<string, number>();
      for (const shardBlocks of data.blocks) {
        for (const block of shardBlocks) {
          const ts = block.timestamp ?? toTs;
          for (const tx of block.transactions ?? []) {
            // Skip coinbase transactions (no inputs)
            if (
              !Array.isArray(tx.unsigned?.inputs) ||
              tx.unsigned.inputs.length === 0
            )
              continue;
            for (const output of tx.unsigned?.fixedOutputs ?? []) {
              if (output.address) {
                const prev = addrMap.get(output.address) ?? 0;
                addrMap.set(output.address, Math.max(prev, ts));
              }
            }
          }
        }
      }

      console.log(
        `[active-addr] window ${new Date(fromTs).toISOString()} → ${new Date(toTs).toISOString()}: ${addrMap.size} unique senders`,
      );

      // Batch upsert in chunks of 100 to stay within D1 batch limits
      if (addrMap.size > 0) {
        const stmt = env.DB.prepare(
          `INSERT INTO active_addresses (address, last_seen_at) VALUES (?, ?)
           ON CONFLICT(address) DO UPDATE
             SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
        );
        const entries = Array.from(addrMap.entries());
        for (let i = 0; i < entries.length; i += 100) {
          const chunk = entries.slice(i, i + 100);
          await env.DB.batch(
            chunk.map(([addr, ts]: [string, number]) => stmt.bind(addr, ts)),
          );
        }
      }

      // Advance cursor
      await env.DB.prepare(
        `INSERT INTO indexer_state (key, value) VALUES ('active_addr_cursor', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
        .bind(String(toTs))
        .run();

      // Cleanup in background — don't block the scheduled handler
      ctx.waitUntil(
        env.DB.prepare(`DELETE FROM active_addresses WHERE last_seen_at < ?`)
          .bind(now - 31 * 24 * 3600_000)
          .run(),
      );
    } catch (err: any) {
      console.error("[active-addr] scheduled error:", err?.message ?? err);
    }
  },
};

/**
 * In-app notice for an admin-driven sponsor status change.
 *
 * These four routes previously only sent email (and only on verify), so a
 * sponsor whose account was suspended or whose verification was pulled had no
 * way to find out in the product.
 */
async function notifySponsorNotice(
  env: Env,
  sponsorId: string,
  change: "verified" | "unverified" | "banned" | "unbanned",
): Promise<void> {
  try {
    const sponsor = (await env.DB.prepare(
      `SELECT user_id, name FROM sponsors WHERE id = ?`,
    )
      .bind(sponsorId)
      .first()) as { user_id: string; name: string } | null;
    if (!sponsor) return;

    await notifySponsorStatusChanged(env, {
      sponsorUserId: sponsor.user_id,
      sponsorName: sponsor.name,
      change,
    });

    // Email from the same place as the in-app notice. Previously only
    // `verified` sent one, from its own call site, so the two channels could
    // — and did — disagree about which changes are worth telling someone.
    await notifySponsorAccountChange(env, sponsorId, change);
  } catch (err: any) {
    console.error(
      "[notify] sponsor status notice failed:",
      err?.message ?? err,
    );
  }
}

export default worker;

/**
 * Transform bounty object to include computed reward field for backwards compatibility
 */
function transformBounty(bounty: any) {
  if (!bounty) return bounty;
  return {
    ...bounty,
    reward: {
      // Always ALPH. For a USD-denominated bounty this is the derived figure
      // at the last daily valuation, not a promise — the UI should lead with
      // usd_equivalent for those and label the ALPH figure as approximate.
      amount: bounty.reward_amount || 0,
      token: bounty.reward_currency || "ALPH",
      // Always USD, and populated for both denominations now.
      usd_equivalent: bounty.reward_usd || 0,
    },
    // Which side the sponsor fixed. Drives whether the UI shows
    // "500 ALPH (≈ $19)" or "$100 (≈ 2,565 ALPH)".
    denomination: bounty.denomination || "alph",
    // Derived server-side from the same function the client uses, so a list
    // rendered from this payload and a page that recomputes it can never
    // disagree. Payment counts are not in scope here, so an announced bounty
    // reports "Payment Pending" rather than guessing "Completed".
    display_status: getBountyDisplayStatus(bounty),
  };
}

/**
 * Pick a free slug for a title.
 *
 * The UNIQUE index is what actually guarantees uniqueness; this just avoids
 * losing the insert to an avoidable collision. Two bounties named the same
 * thing become "…-2", "…-3". Returns null when the title yields no usable
 * slug (all punctuation, or non-Latin script) — the row then keeps NULL and
 * stays reachable by id, which is why the index is partial.
 */
async function pickBountySlug(
  env: Env,
  title: string,
  excludeId?: string,
): Promise<string | null> {
  const base = bountySlug(title);
  if (!base) return null;

  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const taken = (await env.DB.prepare(
      `SELECT id FROM bounties WHERE slug = ? AND id IS NOT ? LIMIT 1`,
    )
      .bind(candidate, excludeId ?? null)
      .first()) as { id: string } | null;
    if (!taken) return candidate;
  }

  // Twenty identical titles is not a real case; fall back to id-only routing
  // rather than looping forever or throwing away the whole create.
  return null;
}

/** A bare UUID, i.e. the pre-slug URL form that must keep resolving. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a bounty must have before it can be public.
 *
 * Returns an error message, or null when it is publishable. Used by both
 * POST /api/bounties (creating as published) and POST /api/bounties/:id/publish
 * (promoting a draft) — the gate has to be the same on both paths, or a draft
 * becomes a way to publish a bounty that direct creation would have rejected.
 *
 * Takes a plain object so it works on a request body and on a database row.
 */
function publishRequirements(b: {
  title?: unknown;
  description?: unknown;
  start_date?: unknown;
  end_date?: unknown;
}): string | null {
  const filled = (v: unknown) =>
    typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined;

  const missing = [
    !filled(b.title) && "title",
    !filled(b.description) && "description",
    !filled(b.start_date) && "start_date",
    !filled(b.end_date) && "end_date",
  ].filter(Boolean) as string[];

  if (missing.length === 0) return null;
  return `Cannot publish without: ${missing.join(", ")}`;
}

/**
 * Handle Bounties API requests
 */
async function handleBountiesAPI(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  const pathname = url.pathname;

  // GET /api/bounties - List all bounties (with optional dapp_name filter)
  if (request.method === "GET" && pathname === "/api/bounties") {
    const dappName = url.searchParams.get("dapp_name");
    // The sponsor dashboard needs its own drafts back; nothing else does.
    // Scoped to one sponsor and checked against the session below, so this
    // cannot be used to read someone else's unpublished work.
    const includeDrafts = url.searchParams.get("include_drafts") === "1";
    const sponsorId = url.searchParams.get("sponsor_id");

    let showDrafts = false;
    if (includeDrafts && sponsorId) {
      const sessionUserId = await getSessionUserId(env, request);
      if (sessionUserId) {
        const owner = (await env.DB.prepare(
          "SELECT user_id FROM sponsors WHERE id = ?",
        )
          .bind(sponsorId)
          .first()) as { user_id: string } | null;
        showDrafts =
          owner?.user_id === sessionUserId ||
          (await isGodUser(env, sessionUserId));
      }
    }

    let query = `
      SELECT b.*, s.name as sponsor_name, s.slug as sponsor_slug,
             s.logo_url as sponsor_logo_url,
             s.is_verified as sponsor_is_verified,
             (SELECT COUNT(*) FROM bounty_submissions WHERE bounty_id = b.id) as submission_count
      FROM bounties b
      LEFT JOIN sponsors s ON b.sponsor_id = s.id
      WHERE b.status != 'deleted'
    `;

    const params: string[] = [];

    if (showDrafts) {
      query += ` AND b.sponsor_id = ?`;
      params.push(sponsorId!);
    } else {
      // A draft has never been public. Filtering here rather than in each
      // caller means a new consumer of this endpoint cannot leak them.
      query += ` AND b.is_published = 1`;
    }

    // Filter by dapp_name if provided (case-insensitive)
    if (dappName) {
      query += ` AND LOWER(b.dapp_name) = LOWER(?)`;
      params.push(dappName);
    }

    query += ` ORDER BY b.created_at DESC`;

    const { results } =
      params.length > 0
        ? await env.DB.prepare(query)
            .bind(...params)
            .all()
        : await env.DB.prepare(query).all();

    return new Response(
      JSON.stringify({ bounties: results.map(transformBounty) }),
      {
        headers: corsHeaders,
      },
    );
  }

  // GET /api/bounties/:idOrSlug - Get single bounty
  //
  // Accepts either form. Every /bounty/<uuid> link already shared publicly
  // predates slugs, so dropping id lookup would 404 them; matching on both
  // keeps those alive permanently. A bare UUID is matched against id only, so
  // a slug can never shadow an id (and vice versa).
  if (request.method === "GET" && pathname.match(/^\/api\/bounties\/[^/]+$/)) {
    const key = decodeURIComponent(pathname.split("/").pop() || "");
    const bounty = await env.DB.prepare(
      `
      SELECT b.*,
             s.name as sponsor_name,
             s.slug as sponsor_slug,
             s.logo_url as sponsor_logo_url,
             s.is_verified as sponsor_is_verified,
             (SELECT COUNT(*) FROM bounty_submissions WHERE bounty_id = b.id) as submission_count
      FROM bounties b
      LEFT JOIN sponsors s ON b.sponsor_id = s.id
      WHERE b.id = ? OR (? = 0 AND b.slug = ?)
      LIMIT 1
    `,
    )
      .bind(key, UUID_RE.test(key) ? 1 : 0, key)
      .first();

    if (!bounty) {
      return new Response(JSON.stringify({ error: "Bounty not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    // A draft is visible only to its own sponsor (so they can preview it) and
    // to god. 404 rather than 403 — the id of an unpublished bounty is not
    // something a stranger should be able to confirm exists.
    if ((bounty as any).is_published === 0) {
      const sessionUserId = await getSessionUserId(env, request);
      const owner = (bounty as any).created_by;
      const allowed =
        !!sessionUserId &&
        (sessionUserId === owner || (await isGodUser(env, sessionUserId)));
      if (!allowed) {
        return new Response(JSON.stringify({ error: "Bounty not found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }
    }

    return new Response(JSON.stringify({ bounty: transformBounty(bounty) }), {
      headers: corsHeaders,
    });
  }

  // POST /api/bounties - Create new bounty
  if (request.method === "POST" && pathname === "/api/bounties") {
    try {
      const created_by = await getSessionUserId(env, request);
      if (!created_by) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const body = (await request.json()) as any;

      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);

      if (!body.sponsor_id) {
        return new Response(
          JSON.stringify({
            error: "Sponsor ID is required",
          }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      // Verify sponsor exists, is verified, and is not banned
      const sponsor = (await env.DB.prepare(
        "SELECT id, user_id, is_verified, is_banned FROM sponsors WHERE id = ?",
      )
        .bind(body.sponsor_id)
        .first()) as {
        id: string;
        user_id: string;
        is_verified: number;
        is_banned: number;
      } | null;

      if (!sponsor) {
        return new Response(
          JSON.stringify({
            error: "Sponsor not found",
          }),
          {
            status: 404,
            headers: corsHeaders,
          },
        );
      }

      if (sponsor.is_banned) {
        return new Response(
          JSON.stringify({
            error: "Sponsor account is banned and cannot create bounties.",
          }),
          {
            status: 403,
            headers: corsHeaders,
          },
        );
      }

      // God users bypass the is_verified check and the sponsor-ownership check
      const creatorRole = (await env.DB.prepare(
        "SELECT role FROM user WHERE id = ?",
      )
        .bind(created_by)
        .first()) as { role: string | null } | null;
      const creatorIsGod = creatorRole?.role === "god";

      // Only the sponsor's own owner (or a god user) may create bounties
      // under that sponsor's identity.
      if (sponsor.user_id !== created_by && !creatorIsGod) {
        return new Response(
          JSON.stringify({
            error:
              "You do not have permission to create bounties for this sponsor.",
          }),
          {
            status: 403,
            headers: corsHeaders,
          },
        );
      }

      if (!sponsor.is_verified && !creatorIsGod) {
        return new Response(
          JSON.stringify({
            error:
              "Sponsor account is pending review. Please wait for admin approval before creating bounties.",
          }),
          {
            status: 403,
            headers: corsHeaders,
          },
        );
      }

      // Draft vs publish. Absent means publish, so every existing client that
      // does not know about drafts keeps working exactly as before.
      const isPublished = body.is_published === false ? 0 : 1;

      // A draft is unfinished by definition — refusing to save one because
      // the deadline is still blank defeats the point of the button. Only a
      // title is required, so the dashboard has something to list it under.
      // Everything else is enforced at publish time, in one place: the
      // publishRequirements() check used by both this endpoint and
      // POST /api/bounties/:id/publish.
      if (!body.title?.trim()) {
        return new Response(JSON.stringify({ error: "title is required" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      if (isPublished) {
        const missing = publishRequirements(body);
        if (missing) {
          return new Response(JSON.stringify({ error: missing }), {
            status: 400,
            headers: corsHeaders,
          });
        }
      }

      // reward_amount is always ALPH; target_usd is always USD. Which one the
      // caller must supply depends on `denomination`, and the other side is
      // derived from the daily rate.
      let reward: Awaited<ReturnType<typeof resolveRewardInput>>;
      try {
        reward = await resolveRewardInput(env, body);
      } catch (err: any) {
        // A missing rate is a server-side outage, not bad input.
        const status = err instanceof RateUnavailableError ? 503 : 400;
        return new Response(JSON.stringify({ error: err.message }), {
          status,
          headers: corsHeaders,
        });
      }

      const rewardType = body.reward_type || "fixed";
      if (rewardType !== "fixed" && rewardType !== "tiered") {
        return new Response(
          JSON.stringify({ error: "reward_type must be 'fixed' or 'tiered'" }),
          { status: 400, headers: corsHeaders },
        );
      }

      const tierCount = body.tier_count ?? 5;
      if (![3, 5, 10].includes(Number(tierCount))) {
        return new Response(
          JSON.stringify({ error: "tier_count must be 3, 5, or 10" }),
          { status: 400, headers: corsHeaders },
        );
      }

      // Only meaningful once both dates exist — a draft may have neither.
      if (
        body.start_date &&
        body.end_date &&
        new Date(body.end_date) <= new Date(body.start_date)
      ) {
        return new Response(
          JSON.stringify({ error: "end_date must be after start_date" }),
          { status: 400, headers: corsHeaders },
        );
      }

      // Convert arrays to JSON strings
      const requirements = JSON.stringify(body.requirements || []);
      const deliverables = JSON.stringify(body.deliverables || []);
      const skills = JSON.stringify(body.skills || []);
      const tags = JSON.stringify(body.tags || []);

      // Normalize category and difficulty to lowercase for CHECK constraint
      const category = body.category ? body.category.toLowerCase() : null;
      const difficulty =
        body.difficulty || body.difficulty_level
          ? (body.difficulty || body.difficulty_level).toLowerCase()
          : null;

      await env.DB.prepare(
        `
        INSERT INTO bounties (
          id, sponsor_id, title, description,
          requirements, deliverables, skills, tags,
          reward_amount, reward_currency, reward_type, tier_count,
          denomination, target_usd, reward_usd, token_usd_at_valuation,
          valuation_updated_at,
          category, difficulty, dapp_name,
          start_date, end_date,
          is_published, published_at, slug,
          status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
        .bind(
          id,
          body.sponsor_id,
          body.title,
          // NOT NULL in the schema, and a draft may not have one yet.
          body.description ?? "",
          requirements,
          deliverables,
          skills,
          tags,
          reward.reward_amount,
          "ALPH", // settlement token
          rewardType,
          Number(tierCount),
          reward.denomination,
          reward.target_usd,
          reward.reward_usd,
          reward.token_usd_at_valuation,
          reward.token_usd_at_valuation ? now : null,
          category,
          difficulty,
          body.dapp_name || null,
          body.start_date || null,
          body.end_date || null,
          isPublished,
          isPublished ? now : null,
          await pickBountySlug(env, body.title),
          "open",
          created_by,
          now,
          now,
        )
        .run();

      const bounty = await env.DB.prepare("SELECT * FROM bounties WHERE id = ?")
        .bind(id)
        .first();

      // The bounty_overview table used to be incremented here with the old
      // split total_value_usd / total_value_alph counters. Nothing reads that
      // table — /api/bounty-overview computes its numbers live — and those two
      // counters could not be added together anyway. Dropped rather than
      // ported onto the new columns.

      return new Response(JSON.stringify({ bounty: transformBounty(bounty) }), {
        status: 201,
        headers: corsHeaders,
      });
    } catch (error: any) {
      console.error("Error creating bounty:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to create bounty",
          details: error.message,
        }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // POST /api/bounties/:id/publish - Take a draft live (idempotent)
  // POST /api/bounties/:id/announce - Declare winners announced (idempotent)
  //
  // Both are conditional UPDATEs rather than SELECT-then-UPDATE. D1 is single
  // writer, so `WHERE <flag> = 0` plus a check on meta.changes gives us
  // idempotency without a distributed lock: a double-clicked button, a
  // retried request or two tabs racing all leave exactly one transition, and
  // the loser gets 409 instead of silently re-stamping the timestamp.
  if (
    request.method === "POST" &&
    pathname.match(/^\/api\/bounties\/[^/]+\/(publish|announce)$/)
  ) {
    const action = pathname.endsWith("/publish") ? "publish" : "announce";
    const id = pathname.split("/")[3];

    try {
      const sessionUserId = await getSessionUserId(env, request);
      if (!sessionUserId) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const bounty = (await env.DB.prepare(
        `SELECT b.id, b.created_by, b.status, b.is_published, b.is_winners_announced,
                b.title, b.description, b.start_date, b.end_date,
                s.user_id as sponsor_user_id
           FROM bounties b
           LEFT JOIN sponsors s ON b.sponsor_id = s.id
          WHERE b.id = ?`,
      )
        .bind(id)
        .first()) as {
        id: string;
        created_by: string;
        status: string;
        is_published: number;
        is_winners_announced: number;
        title: string | null;
        description: string | null;
        start_date: number | null;
        end_date: number | null;
        sponsor_user_id: string | null;
      } | null;

      if (!bounty || bounty.status === "deleted") {
        return new Response(JSON.stringify({ error: "Bounty not found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }

      const isOwner =
        bounty.created_by === sessionUserId ||
        bounty.sponsor_user_id === sessionUserId;
      if (!isOwner && !(await isGodUser(env, sessionUserId))) {
        return new Response(
          JSON.stringify({ error: "You do not have permission to do that." }),
          { status: 403, headers: corsHeaders },
        );
      }

      if (bounty.status === "cancelled") {
        return new Response(
          JSON.stringify({ error: "This bounty has been cancelled." }),
          { status: 409, headers: corsHeaders },
        );
      }

      const now = Math.floor(Date.now() / 1000);

      if (action === "publish") {
        // Same gate as creating-as-published, so a draft is not a back door
        // to publishing something direct creation would have rejected.
        const missing = publishRequirements(bounty);
        if (missing) {
          return new Response(JSON.stringify({ error: missing }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        // Sponsor standing is re-checked at publish, not just at create: a
        // sponsor can be banned or have their verification pulled while a
        // draft sits unpublished, and the draft must not become live anyway.
        const standing = (await env.DB.prepare(
          `SELECT s.is_verified, s.is_banned
             FROM bounties b JOIN sponsors s ON b.sponsor_id = s.id
            WHERE b.id = ?`,
        )
          .bind(id)
          .first()) as { is_verified: number; is_banned: number } | null;

        const publisherIsGod = await isGodUser(env, sessionUserId);

        if (standing?.is_banned) {
          return new Response(
            JSON.stringify({
              error: "This sponsor account is banned and cannot publish.",
            }),
            { status: 403, headers: corsHeaders },
          );
        }
        if (!standing?.is_verified && !publisherIsGod) {
          return new Response(
            JSON.stringify({
              error:
                "Sponsor account is pending review. Please wait for admin approval before publishing.",
            }),
            { status: 403, headers: corsHeaders },
          );
        }
      }

      if (action === "announce") {
        // Announcing with no winners picked would move the bounty into
        // "Payment Pending" with nothing to pay, and the flag is one-way.
        const winners = (await env.DB.prepare(
          `SELECT COUNT(*) as n FROM bounty_submissions
            WHERE bounty_id = ? AND is_winner = 1`,
        )
          .bind(id)
          .first()) as { n: number } | null;

        if (!winners?.n) {
          return new Response(
            JSON.stringify({
              error: "Select at least one winner before announcing.",
            }),
            { status: 400, headers: corsHeaders },
          );
        }
      }

      const result =
        action === "publish"
          ? await env.DB.prepare(
              `UPDATE bounties
                  SET is_published = 1,
                      published_at = COALESCE(published_at, ?),
                      updated_at = ?
                WHERE id = ? AND is_published = 0`,
            )
              .bind(now, now, id)
              .run()
          : await env.DB.prepare(
              `UPDATE bounties
                  SET is_winners_announced = 1,
                      winners_announced_at = ?,
                      updated_at = ?
                WHERE id = ? AND is_winners_announced = 0`,
            )
              .bind(now, now, id)
              .run();

      if ((result?.meta?.changes ?? 0) === 0) {
        return new Response(
          JSON.stringify({
            error:
              action === "publish"
                ? "This bounty is already published."
                : "Winners have already been announced for this bounty.",
          }),
          { status: 409, headers: corsHeaders },
        );
      }

      const updated = await env.DB.prepare(
        "SELECT * FROM bounties WHERE id = ?",
      )
        .bind(id)
        .first();

      return new Response(
        JSON.stringify({ bounty: transformBounty(updated) }),
        { headers: corsHeaders },
      );
    } catch (error: any) {
      console.error(`Error on bounty ${action}:`, error);
      return new Response(
        JSON.stringify({ error: `Failed to ${action} bounty` }),
        { status: 500, headers: corsHeaders },
      );
    }
  }

  // POST /api/bounties/:id/republish - Create a new copy of an existing bounty with updated dates
  if (
    request.method === "POST" &&
    pathname.match(/^\/api\/bounties\/[^/]+\/republish$/)
  ) {
    try {
      const sessionUserId = await getSessionUserId(env, request);
      if (!sessionUserId) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const id = pathname.split("/")[3];
      const body = (await request.json()) as {
        end_date: string;
        start_date?: string;
      };

      if (!body.end_date) {
        return new Response(JSON.stringify({ error: "end_date is required" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const original = (await env.DB.prepare(
        "SELECT * FROM bounties WHERE id = ? AND status != 'deleted'",
      )
        .bind(id)
        .first()) as any | null;

      if (!original) {
        return new Response(JSON.stringify({ error: "Bounty not found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }

      // Verify the requesting user owns the sponsor, or is a god user
      const sponsor = (await env.DB.prepare(
        "SELECT user_id FROM sponsors WHERE id = ?",
      )
        .bind(original.sponsor_id)
        .first()) as { user_id: string } | null;

      const isGod = await isGodUser(env, sessionUserId);

      if (!isGod && sponsor?.user_id !== sessionUserId) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 403,
          headers: corsHeaders,
        });
      }

      const newId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const startDate =
        body.start_date || new Date().toISOString().split("T")[0];

      // Carry over which side the sponsor fixed, but revalue the derived side
      // at today's rate — a republished bounty is a new promise, and copying a
      // months-old valuation would misstate it.
      const republishReward = await resolveRewardInput(env, {
        denomination: original.denomination,
        reward_amount: original.reward_amount,
        target_usd: original.target_usd,
      });

      await env.DB.prepare(
        `INSERT INTO bounties (
          id, sponsor_id, title, description,
          requirements, deliverables, skills,
          reward_amount, reward_currency, reward_type, tier_count,
          denomination, target_usd, reward_usd, token_usd_at_valuation,
          valuation_updated_at,
          category, difficulty, dapp_name,
          start_date, end_date,
          status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          newId,
          original.sponsor_id,
          original.title,
          original.description,
          original.requirements,
          original.deliverables,
          original.skills,
          republishReward.reward_amount,
          "ALPH",
          original.reward_type,
          original.tier_count,
          republishReward.denomination,
          republishReward.target_usd,
          republishReward.reward_usd,
          republishReward.token_usd_at_valuation,
          republishReward.token_usd_at_valuation ? now : null,
          original.category,
          original.difficulty,
          original.dapp_name,
          startDate,
          body.end_date,
          "open",
          sessionUserId,
          now,
          now,
        )
        .run();

      const newBounty = await env.DB.prepare(
        "SELECT * FROM bounties WHERE id = ?",
      )
        .bind(newId)
        .first();

      return new Response(
        JSON.stringify({ bounty: transformBounty(newBounty) }),
        { status: 201, headers: corsHeaders },
      );
    } catch (error: any) {
      console.error("Error republishing bounty:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to republish bounty",
          details: error.message,
        }),
        { status: 500, headers: corsHeaders },
      );
    }
  }

  // DELETE /api/bounties/:id - Delete (soft delete) a bounty
  if (
    request.method === "DELETE" &&
    pathname.match(/^\/api\/bounties\/[^/]+$/)
  ) {
    try {
      const sessionUserId = await getSessionUserId(env, request);
      if (!sessionUserId) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const id = pathname.split("/").pop();

      // Get the bounty before deleting to update overview
      const bounty = (await env.DB.prepare(
        "SELECT status, sponsor_id FROM bounties WHERE id = ?",
      )
        .bind(id)
        .first()) as {
        status: string;
        sponsor_id: string;
      } | null;

      if (!bounty) {
        return new Response(JSON.stringify({ error: "Bounty not found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }

      const owningSponsor = (await env.DB.prepare(
        "SELECT user_id FROM sponsors WHERE id = ?",
      )
        .bind(bounty.sponsor_id)
        .first()) as { user_id: string } | null;

      if (owningSponsor && owningSponsor.user_id !== sessionUserId) {
        const isGod = await isGodUser(env, sessionUserId);
        if (!isGod) {
          return new Response(JSON.stringify({ error: "Forbidden" }), {
            status: 403,
            headers: corsHeaders,
          });
        }
      }

      // Only update overview if bounty is not already deleted
      if (bounty.status !== "deleted") {
        const now = Math.floor(Date.now() / 1000);

        // Soft delete the bounty
        await env.DB.prepare(
          "UPDATE bounties SET status = 'deleted', updated_at = ? WHERE id = ?",
        )
          .bind(now, id)
          .run();

        // The bounty_overview decrement that used to live here is gone along
        // with the increments on create/republish — /api/bounty-overview
        // computes from bounties directly and already excludes status='deleted'.
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: "Bounty deleted successfully",
        }),
        {
          headers: corsHeaders,
        },
      );
    } catch (error: any) {
      console.error("Error deleting bounty:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to delete bounty",
          details: error.message,
        }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // PUT /api/bounties/:id - Update a bounty
  if (request.method === "PUT" && pathname.match(/^\/api\/bounties\/[^/]+$/)) {
    try {
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

      // Get the old bounty data to calculate overview changes
      const oldBounty = (await env.DB.prepare(
        "SELECT reward_amount, denomination, target_usd, status, sponsor_id, start_date, end_date FROM bounties WHERE id = ?",
      )
        .bind(id)
        .first()) as {
        reward_amount: number | null;
        denomination: string | null;
        target_usd: number | null;
        status: string;
        sponsor_id: string;
        start_date: string | null;
        end_date: string | null;
      } | null;

      if (!oldBounty) {
        return new Response(JSON.stringify({ error: "Bounty not found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }

      const owningSponsor = (await env.DB.prepare(
        "SELECT user_id FROM sponsors WHERE id = ?",
      )
        .bind(oldBounty.sponsor_id)
        .first()) as { user_id: string } | null;

      if (owningSponsor && owningSponsor.user_id !== sessionUserId) {
        const isGod = await isGodUser(env, sessionUserId);
        if (!isGod) {
          return new Response(JSON.stringify({ error: "Forbidden" }), {
            status: 403,
            headers: corsHeaders,
          });
        }
      }

      // Build update query dynamically based on provided fields
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
      // Reward edits go through resolveRewardInput so both sides stay
      // consistent — writing reward_amount without recomputing reward_usd is
      // what let the two drift apart before. Touching either the amount or
      // the denomination re-derives the whole set.
      if (
        body.reward_amount !== undefined ||
        body.target_usd !== undefined ||
        body.denomination !== undefined
      ) {
        let reward: Awaited<ReturnType<typeof resolveRewardInput>>;
        try {
          reward = await resolveRewardInput(env, {
            // Fall back to what the bounty already uses, so a caller can send
            // just a new amount without restating the denomination.
            denomination: body.denomination ?? oldBounty.denomination,
            reward_amount: body.reward_amount ?? oldBounty.reward_amount,
            target_usd: body.target_usd ?? oldBounty.target_usd,
          });
        } catch (err: any) {
          const status = err instanceof RateUnavailableError ? 503 : 400;
          return new Response(JSON.stringify({ error: err.message }), {
            status,
            headers: corsHeaders,
          });
        }

        updates.push(
          "reward_amount = ?",
          "denomination = ?",
          "target_usd = ?",
          "reward_usd = ?",
          "token_usd_at_valuation = ?",
          "valuation_updated_at = ?",
        );
        values.push(
          reward.reward_amount,
          reward.denomination,
          reward.target_usd,
          reward.reward_usd,
          reward.token_usd_at_valuation,
          reward.token_usd_at_valuation ? now : null,
        );
      }
      if (body.reward_type !== undefined) {
        if (body.reward_type !== "fixed" && body.reward_type !== "tiered") {
          return new Response(
            JSON.stringify({
              error: "reward_type must be 'fixed' or 'tiered'",
            }),
            { status: 400, headers: corsHeaders },
          );
        }
        updates.push("reward_type = ?");
        values.push(body.reward_type);
      }
      if (body.tier_count !== undefined) {
        if (![3, 5, 10].includes(Number(body.tier_count))) {
          return new Response(
            JSON.stringify({ error: "tier_count must be 3, 5, or 10" }),
            { status: 400, headers: corsHeaders },
          );
        }
        updates.push("tier_count = ?");
        values.push(Number(body.tier_count));
      }
      if (body.status !== undefined) {
        updates.push("status = ?");
        // "closed" is not in the DB CHECK constraint — store as "cancelled"
        values.push(body.status === "closed" ? "cancelled" : body.status);
      }
      if (body.category !== undefined) {
        updates.push("category = ?");
        values.push(body.category);
      }
      if (body.difficulty !== undefined) {
        updates.push("difficulty = ?");
        values.push(body.difficulty ? body.difficulty.toLowerCase() : null);
      }
      if (body.dapp_name !== undefined) {
        updates.push("dapp_name = ?");
        values.push(body.dapp_name || null);
      }
      if (body.tags !== undefined) {
        updates.push("tags = ?");
        values.push(JSON.stringify(body.tags || []));
      }
      if (body.requirements !== undefined) {
        updates.push("requirements = ?");
        values.push(JSON.stringify(body.requirements || []));
      }
      if (body.deliverables !== undefined) {
        updates.push("deliverables = ?");
        values.push(JSON.stringify(body.deliverables || []));
      }
      if (body.skills !== undefined) {
        updates.push("skills = ?");
        values.push(JSON.stringify(body.skills || []));
      }

      const effectiveStartDate =
        body.start_date !== undefined ? body.start_date : oldBounty.start_date;
      const effectiveEndDate =
        body.end_date !== undefined ? body.end_date : oldBounty.end_date;
      if (
        effectiveStartDate &&
        effectiveEndDate &&
        new Date(effectiveEndDate) <= new Date(effectiveStartDate)
      ) {
        return new Response(
          JSON.stringify({ error: "end_date must be after start_date" }),
          { status: 400, headers: corsHeaders },
        );
      }

      if (body.start_date !== undefined) {
        updates.push("start_date = ?");
        values.push(body.start_date);
      }
      if (body.end_date !== undefined) {
        updates.push("end_date = ?");
        values.push(body.end_date);
      }

      updates.push("updated_at = ?");
      values.push(now);
      values.push(id);

      if (updates.length > 1) {
        // More than just updated_at
        await env.DB.prepare(
          `UPDATE bounties SET ${updates.join(", ")} WHERE id = ?`,
        )
          .bind(...values)
          .run();

        // The bounty_overview delta bookkeeping that used to run here is gone
        // with the rest of that table's maintenance.
      }

      const updatedBounty = await env.DB.prepare(
        "SELECT * FROM bounties WHERE id = ?",
      )
        .bind(id)
        .first();

      return new Response(
        JSON.stringify({ bounty: transformBounty(updatedBounty) }),
        {
          headers: corsHeaders,
        },
      );
    } catch (error: any) {
      console.error("Error updating bounty:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to update bounty",
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

/**
 * How much of a profile the requester may see. Profiles are public pages, but
 * email and wallet_address are not: "full" is the owner or a god user, and
 * "sponsor" is a sponsor whose bounty this user submitted to (they need the
 * wallet to pay a winner, see SubmissionReviewModal). Everyone else is "public".
 */
async function getProfileAccess(
  env: Env,
  request: Request,
  targetUserId: string,
): Promise<"full" | "sponsor" | "public"> {
  const sessionUserId = await getSessionUserId(env, request);
  if (!sessionUserId) return "public";
  if (sessionUserId === targetUserId) return "full";
  if (await isGodUser(env, sessionUserId)) return "full";
  const sponsorOf = await env.DB.prepare(
    `SELECT 1 FROM bounty_submissions bs
       JOIN bounties b ON bs.bounty_id = b.id
       JOIN sponsors s ON b.sponsor_id = s.id
      WHERE bs.user_id = ? AND s.user_id = ?
      LIMIT 1`,
  )
    .bind(targetUserId, sessionUserId)
    .first();
  return sponsorOf ? "sponsor" : "public";
}

/** Strips the fields the requester is not entitled to (see getProfileAccess). */
function redactProfile(
  user: Record<string, any>,
  access: "full" | "sponsor" | "public",
): Record<string, any> {
  if (access === "full") return user;
  const { email, wallet_address, ...rest } = user;
  return access === "sponsor" ? { ...rest, wallet_address } : rest;
}

/**
 * Handle Users API requests
 */
async function handleUsersAPI(
  request: Request,
  env: Env,
  url: URL,
  ctx?: any,
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOriginFor(request, env),
    Vary: "Origin",
    "Access-Control-Allow-Credentials": "true",
    "Content-Type": "application/json",
  };

  const pathname = url.pathname;

  // GET /api/users/username/:username - Get user profile by username
  if (
    request.method === "GET" &&
    pathname.match(/^\/api\/users\/username\/[^/]+$/)
  ) {
    try {
      const username = pathname.split("/").pop();

      // Join with user table to get email, name, image
      const user = await env.DB.prepare(
        `SELECT
          up.*,
          u.email,
          u.name,
          u.image
         FROM user_profiles up
         JOIN user u ON up.user_id = u.id
         WHERE up.username = ?`,
      )
        .bind(username)
        .first();

      if (!user) {
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }

      // Transform data to match frontend expectations
      const transformedUser = {
        ...user,
        // Map username fields to URL fields for frontend compatibility
        github_url: user.github_username || null,
        twitter_url: user.twitter_username || null,
        discord_url: user.discord_url || user.discord_username || null, // Keep discord_url as is
        linkedin_url: user.linkedin_username || null,
        telegram_url: user.telegram_username || null,
        website_url: user.website || null,
        // Map skills field to frontend_skills for backward compatibility
        frontend_skills: user.skills || null,
        backend_skills: null, // These are no longer separate in the DB
        blockchain_skills: null,
      };

      const access = await getProfileAccess(
        env,
        request,
        user.user_id as string,
      );
      return new Response(
        JSON.stringify({ user: redactProfile(transformedUser, access) }),
        { headers: corsHeaders },
      );
    } catch (error: any) {
      console.error("Error fetching user by username:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to fetch user",
          message: error.message || "Unknown error",
        }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // GET /api/users/me - Get current user's profile (requires auth)
  if (request.method === "GET" && pathname === "/api/users/me") {
    try {
      console.log("[GET /api/users/me] Request received");
      console.log(
        "[GET /api/users/me] Cookie header:",
        request.headers.get("Cookie")?.substring(0, 100),
      );

      // Get session from cookie
      const auth = createAuth(
        env.DB,
        {
          GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
          GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
          BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
          BETTER_AUTH_URL: env.BETTER_AUTH_URL,
          APP_URL: env.APP_URL,
          RESEND_API_KEY: env.RESEND_API_KEY,
          FROM_EMAIL: env.FROM_EMAIL,
        },
        ctx, // Pass ExecutionContext for background tasks
      );

      const session = await auth.api.getSession({ headers: request.headers });
      console.log(
        "[GET /api/users/me] Session found:",
        session?.user ? "yes" : "no",
      );

      if (!session?.user) {
        console.log("[GET /api/users/me] No session, returning 401");
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const userId = session.user.id;
      console.log("[GET /api/users/me] User ID:", userId);

      // Get or create user profile
      let profile = await env.DB.prepare(
        `SELECT * FROM user_profiles WHERE user_id = ?`,
      )
        .bind(userId)
        .first();

      if (!profile) {
        console.log("[GET /api/users/me] Profile not found, creating new one");
        const profileId = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);

        await env.DB.prepare(
          `INSERT INTO user_profiles (id, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
          .bind(profileId, userId, now, now)
          .run();

        profile = await env.DB.prepare(
          `SELECT * FROM user_profiles WHERE user_id = ?`,
        )
          .bind(userId)
          .first();
        console.log("[GET /api/users/me] New profile created");
      }

      console.log(
        "[GET /api/users/me] Profile found, username:",
        profile?.username || "none",
      );
      console.log("[GET /api/users/me] Returning user data");

      // Check if user has a Google account linked
      const googleAccount = await env.DB.prepare(
        `SELECT id, accountId FROM account WHERE userId = ? AND providerId = 'google'`,
      )
        .bind(userId)
        .first();

      // Transform data to match frontend expectations
      const transformedProfile = {
        ...profile,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image,
        // Map username fields to URL fields for frontend compatibility
        github_url: profile.github_username || null,
        twitter_url: profile.twitter_username || null,
        discord_url: profile.discord_url || profile.discord_username || null,
        linkedin_url: profile.linkedin_username || null,
        telegram_url: profile.telegram_username || null,
        website_url: profile.website || null,
        // Map skills field to individual skill categories for EditProfile
        frontend_skills: profile.skills || null,
        backend_skills: null,
        blockchain_skills: null,
        // Google linked account info
        isGoogleLinked: !!googleAccount,
        googleName: googleAccount ? session.user.name : null,
      };

      return new Response(
        JSON.stringify({
          user: transformedProfile,
        }),
        {
          headers: corsHeaders,
        },
      );
    } catch (error: any) {
      console.error("Error fetching user profile:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to fetch profile",
          message: error.message || "Unknown error",
        }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // GET /api/users/:id - Get user profile by user_id
  if (request.method === "GET" && pathname.match(/^\/api\/users\/[^/]+$/)) {
    try {
      const id = pathname.split("/").pop();

      // No create-on-miss here: this route is unauthenticated, and
      // /api/users/me already creates the caller's own profile.
      const user = await env.DB.prepare(
        `SELECT
          up.*,
          u.email,
          u.name,
          u.image
         FROM user_profiles up
         JOIN user u ON up.user_id = u.id
         WHERE up.user_id = ?`,
      )
        .bind(id)
        .first();

      if (!user) {
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }

      // Transform data to match frontend expectations
      const transformedUser = {
        ...user,
        // Map username fields to URL fields for frontend compatibility
        github_url: user.github_username || null,
        twitter_url: user.twitter_username || null,
        discord_url: user.discord_url || user.discord_username || null,
        linkedin_url: user.linkedin_username || null,
        telegram_url: user.telegram_username || null,
        website_url: user.website || null,
        // Map skills field to individual skill categories
        frontend_skills: user.skills || null,
        backend_skills: null,
        blockchain_skills: null,
      };

      const access = await getProfileAccess(env, request, id as string);
      return new Response(
        JSON.stringify({ user: redactProfile(transformedUser, access) }),
        { headers: corsHeaders },
      );
    } catch (error: any) {
      console.error("Error fetching user by id:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to fetch user",
          message: error.message || "Unknown error",
        }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // GET /api/users/:id/stats - Get user public statistics
  if (
    request.method === "GET" &&
    pathname.match(/^\/api\/users\/[^/]+\/stats$/)
  ) {
    try {
      const id = pathname.split("/")[3]; // Extract user ID from /api/users/:id/stats

      // Get total submissions count
      const submissionsResult = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM bounty_submissions WHERE user_id = ?`,
      )
        .bind(id)
        .first();
      const totalSubmissions = (submissionsResult?.count as number) || 0;

      // Wins count is_winner, not status='approved'. They agree today, but
      // once winners can be picked before payment the two diverge.
      const wonResult = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM bounty_submissions WHERE user_id = ? AND is_winner = 1`,
      )
        .bind(id)
        .first();
      const totalWon = (wonResult?.count as number) || 0;

      // Earnings come straight from the frozen settlement columns. This used
      // to parse reviewer_notes with three regexes, so a sponsor rewording a
      // note -- or writing one containing "Reward: 100 ALPH" -- silently
      // changed a user's lifetime total with nothing to catch it.
      const earnings = (await env.DB.prepare(
        `SELECT COALESCE(SUM(reward_usd), 0)    AS earned,
                COALESCE(SUM(reward_amount), 0) AS alph_earned
           FROM bounty_submissions
          WHERE user_id = ? AND is_winner = 1`,
      )
        .bind(id)
        .first()) as { earned: number; alph_earned: number } | null;

      const totalEarned = earnings?.earned || 0;
      const totalAlphEarned = earnings?.alph_earned || 0;

      return new Response(
        JSON.stringify({
          stats: {
            submissions: totalSubmissions,
            won: totalWon,
            earned: totalEarned,
            alph_earned: totalAlphEarned,
          },
        }),
        {
          headers: corsHeaders,
        },
      );
    } catch (error: any) {
      console.error("Error fetching user stats:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to fetch user stats",
          message: error.message || "Unknown error",
        }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // PUT /api/god/current-sponsor - God users switch their active sponsor context
  if (request.method === "PUT" && pathname === "/api/god/current-sponsor") {
    const auth = createAuth(
      env.DB,
      {
        GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
        BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
        BETTER_AUTH_URL: env.BETTER_AUTH_URL,
        APP_URL: env.APP_URL,
        RESEND_API_KEY: env.RESEND_API_KEY,
        FROM_EMAIL: env.FROM_EMAIL,
      },
      ctx,
    );
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    const roleRow = (await env.DB.prepare("SELECT role FROM user WHERE id = ?")
      .bind(session.user.id)
      .first()) as { role: string | null } | null;
    if (roleRow?.role !== "god") {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: corsHeaders,
      });
    }
    const body = (await request.json()) as { sponsor_id: string | null };
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE user SET sponsor_id = ?, updatedAt = ? WHERE id = ?",
    )
      .bind(body.sponsor_id ?? null, now, session.user.id)
      .run();
    return new Response(JSON.stringify({ success: true }), {
      headers: corsHeaders,
    });
  }

  // PUT /api/users/:id - Update user profile
  if (request.method === "PUT" && pathname.match(/^\/api\/users\/[^/]+$/)) {
    try {
      const id = pathname.split("/").pop();

      // Only the owner may edit a profile. wallet_address is what bounty
      // payouts are verified against, so this must never be open.
      const sessionUserId = await getSessionUserId(env, request);
      if (!sessionUserId) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: corsHeaders,
        });
      }
      if (sessionUserId !== id) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: corsHeaders,
        });
      }

      const body = (await request.json()) as any;
      const now = Math.floor(Date.now() / 1000);

      // Check if profile exists, create if it doesn't (fail-safe in case trigger didn't run)
      const profile = await env.DB.prepare(
        `SELECT id FROM user_profiles WHERE user_id = ?`,
      )
        .bind(id)
        .first();

      if (!profile) {
        console.log(
          `[PUT /api/users/${id}] Profile not found, creating new one`,
        );
        const profileId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO user_profiles (id, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
          .bind(profileId, id, now, now)
          .run();
      }

      // Check if username is taken (if provided and changed)
      if (body.username) {
        const existing = await env.DB.prepare(
          `SELECT id FROM user_profiles WHERE username = ? AND user_id != ?`,
        )
          .bind(body.username, id)
          .first();

        if (existing) {
          return new Response(
            JSON.stringify({ error: "Username already taken" }),
            {
              status: 400,
              headers: corsHeaders,
            },
          );
        }
      }

      // Update profile image in user table if provided
      if (body.image) {
        await env.DB.prepare(`UPDATE user SET image = ? WHERE id = ?`)
          .bind(body.image, id)
          .run();
      }

      // Update user name in user table if first/last name provided
      if (body.first_name || body.last_name) {
        const fullName =
          `${body.first_name || ""} ${body.last_name || ""}`.trim();
        if (fullName) {
          await env.DB.prepare(`UPDATE user SET name = ? WHERE id = ?`)
            .bind(fullName, id)
            .run();
        }
      }

      // Handle discord_url separately (it's the only social field that has a _url column)
      const discord_url = body.discord_url || null;

      // Combine skills into single JSON field (DB only has one 'skills' column)
      let skillsJson = null;
      if (body.skills && Array.isArray(body.skills) && body.skills.length > 0) {
        skillsJson = JSON.stringify(body.skills);
      }

      // Prepare web3_interests JSON
      const web3InterestsJson =
        body.web3_interests && Array.isArray(body.web3_interests)
          ? JSON.stringify(body.web3_interests)
          : null;

      console.log(
        `[PUT /api/users/${id}] Updating profile with skills:`,
        skillsJson,
      );
      console.log(
        `[PUT /api/users/${id}] Updating profile with web3_interests:`,
        web3InterestsJson,
      );
      console.log(
        `[PUT /api/users/${id}] Updating profile with social links:`,
        {
          github: body.github_username,
          twitter: body.twitter_username,
          discord: body.discord_username,
          linkedin: body.linkedin_username,
          telegram: body.telegram_username,
          website: body.website,
        },
      );

      // Update profile with fields that match the actual database schema
      // When username is set, mark is_default_username = 0 (user has set a custom username)
      const updateResult = await env.DB.prepare(
        `UPDATE user_profiles
         SET username = ?,
             bio = ?,
             wallet_address = ?,
             github_username = ?,
             twitter_username = ?,
             linkedin_username = ?,
             telegram_username = ?,
             discord_username = ?,
             discord_url = ?,
             website = ?,
             location = ?,
             work_preference = ?,
             current_employer = ?,
             web3_interests = ?,
             web3_familiarity = ?,
             looking_for = ?,
             skills = ?,
             is_default_username = CASE WHEN ? IS NOT NULL THEN 0 ELSE is_default_username END,
             updated_at = ?
         WHERE user_id = ?`,
      )
        .bind(
          body.username || null,
          body.bio || null,
          body.wallet_address || null,
          body.github_username || null,
          body.twitter_username || null,
          body.linkedin_username || null,
          body.telegram_username || null,
          body.discord_username || null,
          discord_url,
          body.website || null,
          body.location || null,
          body.work_preference || null,
          body.current_employer || null,
          web3InterestsJson,
          body.web3_familiarity || null,
          body.looking_for || null,
          skillsJson,
          body.username || null, // Used for is_default_username CASE check
          now,
          id,
        )
        .run();

      console.log(
        `[PUT /api/users/${id}] Update result:`,
        updateResult.meta.changes,
        "rows affected",
      );

      // Verify the update was successful
      if (updateResult.meta.changes === 0) {
        console.error(`[PUT /api/users/${id}] WARNING: Update affected 0 rows`);
      }

      // Get updated user with image from user table
      const user = await env.DB.prepare(
        `SELECT up.*, u.image FROM user_profiles up
         JOIN user u ON up.user_id = u.id
         WHERE up.user_id = ?`,
      )
        .bind(id)
        .first();

      console.log(
        `[PUT /api/users/${id}] Profile updated successfully for user:`,
        user?.username,
      );

      return new Response(JSON.stringify({ user }), {
        headers: corsHeaders,
      });
    } catch (error: any) {
      console.error("Error updating user profile:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to update profile",
          message: error.message || "Unknown error",
        }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // POST /api/wallet/nonce - Generate nonce for wallet binding
  if (request.method === "POST" && url.pathname === "/api/wallet/nonce") {
    try {
      const auth = createAuth(
        env.DB,
        {
          GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
          GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
          BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
          BETTER_AUTH_URL: env.BETTER_AUTH_URL,
          APP_URL: env.APP_URL,
          RESEND_API_KEY: env.RESEND_API_KEY,
          FROM_EMAIL: env.FROM_EMAIL,
        },
        ctx,
      );
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: corsHeaders,
        });
      }
      const userId = session.user.id;
      const nonce = crypto.randomUUID();
      const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 minutes

      await env.DB.prepare("DELETE FROM wallet_nonces WHERE user_id = ?")
        .bind(userId)
        .run();
      await env.DB.prepare(
        "INSERT INTO wallet_nonces (id, user_id, nonce, expires_at) VALUES (?, ?, ?, ?)",
      )
        .bind(crypto.randomUUID(), userId, nonce, expiresAt)
        .run();

      return new Response(JSON.stringify({ nonce }), { headers: corsHeaders });
    } catch (error: any) {
      console.error("[POST /api/wallet/nonce] Error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }

  // POST /api/wallet/bind - Verify signature and bind wallet address
  if (request.method === "POST" && url.pathname === "/api/wallet/bind") {
    try {
      const auth = createAuth(
        env.DB,
        {
          GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
          GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
          BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
          BETTER_AUTH_URL: env.BETTER_AUTH_URL,
          APP_URL: env.APP_URL,
          RESEND_API_KEY: env.RESEND_API_KEY,
          FROM_EMAIL: env.FROM_EMAIL,
        },
        ctx,
      );
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: corsHeaders,
        });
      }
      const userId = session.user.id;
      const body = (await request.json()) as {
        address: string;
        publicKey: string;
        signature: string;
        nonce: string;
      };

      // Validate nonce
      const nonceRow = (await env.DB.prepare(
        "SELECT nonce, expires_at FROM wallet_nonces WHERE user_id = ? AND nonce = ?",
      )
        .bind(userId, body.nonce)
        .first()) as { nonce: string; expires_at: number } | null;

      if (!nonceRow) {
        return new Response(
          JSON.stringify({ error: "Invalid or expired nonce" }),
          { status: 400, headers: corsHeaders },
        );
      }
      if (nonceRow.expires_at < Math.floor(Date.now() / 1000)) {
        await env.DB.prepare("DELETE FROM wallet_nonces WHERE user_id = ?")
          .bind(userId)
          .run();
        return new Response(JSON.stringify({ error: "Nonce expired" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      // Verify Alephium signature
      const message = `Bind wallet to Alphland: ${body.nonce}`;
      const isValid = verifySignedMessage(
        message,
        "alephium",
        body.publicKey,
        body.signature,
      );
      if (!isValid) {
        return new Response(JSON.stringify({ error: "Invalid signature" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      // Check address not already bound to another account
      const existing = (await env.DB.prepare(
        "SELECT user_id FROM user_profiles WHERE wallet_address = ? AND user_id != ?",
      )
        .bind(body.address, userId)
        .first()) as { user_id: string } | null;
      if (existing) {
        return new Response(
          JSON.stringify({
            error: "This wallet address is already bound to another account",
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      // Consume nonce and save wallet address
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare("DELETE FROM wallet_nonces WHERE user_id = ?")
        .bind(userId)
        .run();
      await env.DB.prepare(
        "UPDATE user_profiles SET wallet_address = ?, updated_at = ? WHERE user_id = ?",
      )
        .bind(body.address, now, userId)
        .run();

      console.log(
        `[POST /api/wallet/bind] Wallet ${body.address} bound to user ${userId}`,
      );
      return new Response(JSON.stringify({ success: true }), {
        headers: corsHeaders,
      });
    } catch (error: any) {
      console.error("[POST /api/wallet/bind] Error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }

  // POST /api/wallet/unbind - Remove bound wallet address
  if (request.method === "POST" && url.pathname === "/api/wallet/unbind") {
    try {
      const auth = createAuth(
        env.DB,
        {
          GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
          GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
          BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
          BETTER_AUTH_URL: env.BETTER_AUTH_URL,
          APP_URL: env.APP_URL,
          RESEND_API_KEY: env.RESEND_API_KEY,
          FROM_EMAIL: env.FROM_EMAIL,
        },
        ctx,
      );
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: corsHeaders,
        });
      }
      const userId = session.user.id;
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        "UPDATE user_profiles SET wallet_address = NULL, updated_at = ? WHERE user_id = ?",
      )
        .bind(now, userId)
        .run();

      console.log(
        `[POST /api/wallet/unbind] Wallet unbound for user ${userId}`,
      );
      return new Response(JSON.stringify({ success: true }), {
        headers: corsHeaders,
      });
    } catch (error: any) {
      console.error("[POST /api/wallet/unbind] Error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }

  // ── Internal: active address indexing ──────────────────────────────────────
  // POST /api/internal/active-addresses — batch upsert addresses + update cursor
  if (
    url.pathname === "/api/internal/active-addresses" &&
    request.method === "POST"
  ) {
    const authHeader = request.headers.get("Authorization");
    if (
      !env.INTERNAL_SECRET ||
      authHeader !== `Bearer ${env.INTERNAL_SECRET}`
    ) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    try {
      const body = (await request.json()) as {
        addresses?: { address: string; ts: number }[];
        cursor?: number;
      };
      const { addresses = [], cursor } = body;

      // Batch upsert — keep the most recent last_seen_at per address
      if (addresses.length > 0) {
        const stmt = env.DB.prepare(
          `INSERT INTO active_addresses (address, last_seen_at) VALUES (?, ?)
           ON CONFLICT(address) DO UPDATE
             SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
        );
        await env.DB.batch(
          addresses.map(({ address, ts }: { address: string; ts: number }) =>
            stmt.bind(address, ts),
          ),
        );
      }

      // Update cursor
      if (cursor != null) {
        await env.DB.prepare(
          `INSERT INTO indexer_state (key, value) VALUES ('active_addr_cursor', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
          .bind(String(cursor))
          .run();
      }

      // Clean up entries older than 31 days
      await env.DB.prepare(
        `DELETE FROM active_addresses WHERE last_seen_at < ?`,
      )
        .bind(Date.now() - 31 * 24 * 3600_000)
        .run();

      return new Response(
        JSON.stringify({ ok: true, indexed: addresses.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }

  // GET /api/internal/active-addresses/counts — return 7d/30d unique address counts
  if (
    url.pathname === "/api/internal/active-addresses/counts" &&
    request.method === "GET"
  ) {
    const authHeader = request.headers.get("Authorization");
    if (
      !env.INTERNAL_SECRET ||
      authHeader !== `Bearer ${env.INTERNAL_SECRET}`
    ) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    try {
      const now = Date.now();
      const [r7d, r30d, cursorRow] = (await Promise.all([
        env.DB.prepare(
          `SELECT COUNT(*) as c FROM active_addresses WHERE last_seen_at > ?`,
        )
          .bind(now - 7 * 24 * 3600_000)
          .first(),
        env.DB.prepare(
          `SELECT COUNT(*) as c FROM active_addresses WHERE last_seen_at > ?`,
        )
          .bind(now - 30 * 24 * 3600_000)
          .first(),
        env.DB.prepare(
          `SELECT value FROM indexer_state WHERE key = 'active_addr_cursor'`,
        ).first(),
      ])) as [
        { c: number } | null,
        { c: number } | null,
        { value: string } | null,
      ];

      return new Response(
        JSON.stringify({
          count7d: r7d?.c ?? 0,
          count30d: r30d?.c ?? 0,
          cursor: cursorRow?.value ? Number(cursorRow.value) : null,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: corsHeaders,
  });
}
