/**
 * Better Auth configuration for Cloudflare Worker with D1
 *
 * IMPORTANT: D1 Database Binding Context
 *
 * D1 binding is only available inside the request context in Cloudflare Workers.
 * We cannot create a static auth instance with D1 - it must be created per-request.
 *
 * Authentication Flow with Next.js Proxy:
 * 1. Frontend (localhost:3000) sends auth requests to /api/auth/*
 * 2. Next.js rewrites proxy these to Worker (localhost:8787)
 * 3. For Google OAuth:
 *    - BETTER_AUTH_URL must be the FRONTEND URL (localhost:3000)
 *    - Google redirects to localhost:3000/api/auth/callback/google
 *    - Next.js proxies callback to worker
 *    - Worker sets cookie, which appears on localhost:3000 domain
 */
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { Resend } from "resend";

// Import Cloudflare Worker types
type D1Database = any;
type ExecutionContext = {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
};

export interface AuthEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  APP_URL?: string;
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
}

/**
 * Origins allowed to make credentialed requests: better-auth's CSRF check and
 * the Worker's CORS headers both read this, so the two cannot drift apart.
 */
export function getTrustedOrigins(
  env: Pick<AuthEnv, "APP_URL" | "BETTER_AUTH_URL">,
): string[] {
  const publicUrl =
    env.APP_URL || env.BETTER_AUTH_URL || "http://localhost:3000";
  return [publicUrl, "https://alph.land", "https://www.alph.land"];
}

/**
 * Access-Control-Allow-Origin for a credentialed response. Echoes the
 * request's Origin only when it is trusted; reflecting any Origin alongside
 * Allow-Credentials would let any site read a logged-in user's responses.
 */
export function corsOriginFor(
  request: Request,
  env: Pick<AuthEnv, "APP_URL" | "BETTER_AUTH_URL">,
): string {
  const trusted = getTrustedOrigins(env);
  const origin = request.headers.get("Origin");
  return origin && trusted.includes(origin) ? origin : trusted[0];
}

/**
 * Create auth instance with D1 database
 * Must be called within request context where D1 binding is available
 * @param ctx - ExecutionContext for background tasks (email sending)
 */
export function createAuth(
  db: D1Database,
  env: AuthEnv,
  ctx?: ExecutionContext,
) {
  // Use APP_URL or BETTER_AUTH_URL as the public-facing URL
  const publicUrl = env.APP_URL || env.BETTER_AUTH_URL;

  // Create Kysely instance with D1 dialect
  const kysely = new Kysely<any>({
    dialect: new D1Dialect({ database: db }),
  });

  // Initialize Resend for email sending
  const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
  const fromEmail = `Alphland <${env.FROM_EMAIL || "onboarding@resend.dev"}>`;

  const logEmail = async (
    to: string,
    subject: string,
    type: string,
    resendId: string | null,
    error: string | null,
  ) => {
    try {
      await db
        .prepare(
          "INSERT INTO email_logs (id, to_email, subject, type, status, resend_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())",
        )
        .bind(
          crypto.randomUUID(),
          to,
          subject,
          type,
          error ? "failed" : "sent",
          resendId,
          error,
        )
        .run();
    } catch (e) {
      console.error("Failed to log email:", e);
    }
  };

  return betterAuth({
    // D1 uses SQLite syntax - must specify type
    database: {
      db: kysely,
      type: "sqlite",
    },

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // Must be false for free tier (CPU limit)
      sendResetPassword: ({ user, url }) => {
        // CRITICAL: Returns immediately with resolved promise
        if (!resend || !ctx) {
          console.error("RESEND_API_KEY or ctx not configured");
          return Promise.resolve(); // Return resolved promise immediately
        }

        // Fire and forget: ctx.waitUntil handles background execution
        ctx.waitUntil(
          resend.emails
            .send({
              from: fromEmail,
              to: user.email,
              subject: "Reset your password - Alphland",
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2>Reset Your Password</h2>
                  <p>Hello ${user.name || "there"},</p>
                  <p>We received a request to reset your password for your Alphland account.</p>
                  <p>Click the button below to reset your password:</p>
                  <a href="${url}" style="display: inline-block; padding: 12px 24px; background-color: #007bff; color: white; text-decoration: none; border-radius: 4px; margin: 16px 0;">Reset Password</a>
                  <p>Or copy and paste this link into your browser:</p>
                  <p style="color: #666; word-break: break-all;">${url}</p>
                  <p>If you didn't request this password reset, you can safely ignore this email.</p>
                  <p>This link will expire in 1 hour.</p>
                  <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;">
                  <p style="color: #666; font-size: 12px;">This email was sent by Alphland</p>
                </div>
              `,
            })
            .then(({ data, error: sendError }) => {
              if (sendError) {
                console.error(
                  "Failed to send password reset email:",
                  sendError,
                );
                return logEmail(
                  user.email,
                  "Reset your password - Alphland",
                  "password_reset",
                  null,
                  String((sendError as any).message || sendError),
                );
              } else {
                console.log(`Password reset email sent to ${user.email}`);
                return logEmail(
                  user.email,
                  "Reset your password - Alphland",
                  "password_reset",
                  (data as any)?.id || null,
                  null,
                );
              }
            })
            .catch((err) => {
              console.error("Password reset email error:", err);
            }),
        );

        // Return resolved promise immediately - Better Auth continues without waiting
        return Promise.resolve();
      },
    },

    emailVerification: {
      sendOnSignUp: true, // Enable automatic email sending on signup
      sendVerificationEmail: ({ user, url }) => {
        // CRITICAL: Returns immediately with resolved promise
        // No await anywhere in this function

        if (!resend || !ctx) {
          console.error("RESEND_API_KEY or ctx not configured");
          return Promise.resolve(); // Return resolved promise immediately
        }

        // Fire and forget: ctx.waitUntil handles the Promise in background
        // Better Auth won't wait because we return immediately
        ctx.waitUntil(
          resend.emails
            .send({
              from: fromEmail,
              to: user.email,
              subject: "Verify your email - Alphland",
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2>Welcome to Alphland!</h2>
                  <p>Hello ${user.name || "there"},</p>
                  <p>Thank you for signing up! Please verify your email address to complete your registration.</p>
                  <p>Click the button below to verify your email:</p>
                  <a href="${url}" style="display: inline-block; padding: 12px 24px; background-color: #007bff; color: white; text-decoration: none; border-radius: 4px; margin: 16px 0;">Verify Email</a>
                  <p>Or copy and paste this link into your browser:</p>
                  <p style="color: #666; word-break: break-all;">${url}</p>
                  <p>If you didn't create an account with Alphland, you can safely ignore this email.</p>
                  <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;">
                  <p style="color: #666; font-size: 12px;">This email was sent by Alphland</p>
                </div>
              `,
            })
            .then(({ data, error: sendError }) => {
              if (sendError) {
                console.error("Failed to send verification email:", sendError);
                return logEmail(
                  user.email,
                  "Verify your email - Alphland",
                  "email_verification",
                  null,
                  String((sendError as any).message || sendError),
                );
              } else {
                console.log(`Verification email sent to ${user.email}`);
                return logEmail(
                  user.email,
                  "Verify your email - Alphland",
                  "email_verification",
                  (data as any)?.id || null,
                  null,
                );
              }
            })
            .catch((err) => {
              console.error("Email sending error:", err);
            }),
        );

        // Return resolved promise immediately - Better Auth continues without waiting
        return Promise.resolve();
      },
    },

    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        enabled: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      },
    },

    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 300, // 5 minutes
        sendVerificationOTP: async ({
          email,
          otp,
        }: {
          email: string;
          otp: string;
          type: string;
        }) => {
          if (!resend || !ctx) {
            console.error("RESEND_API_KEY or ctx not configured");
            return;
          }

          ctx.waitUntil(
            resend.emails
              .send({
                from: fromEmail,
                to: email,
                subject: "Your login code - Alphland",
                html: `
                  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2>Your Login Code</h2>
                    <p>Use the code below to sign in to Alphland. It expires in 5 minutes.</p>
                    <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px; text-align: center; padding: 24px; background: #f5f5f5; border-radius: 8px; margin: 24px 0;">
                      ${otp}
                    </div>
                    <p>If you didn't request this code, you can safely ignore this email.</p>
                    <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;">
                    <p style="color: #666; font-size: 12px;">This email was sent by Alphland</p>
                  </div>
                `,
              })
              .then(({ data, error: sendError }) => {
                if (sendError) {
                  console.error("Failed to send OTP email:", sendError);
                  return logEmail(
                    email,
                    "Your login code - Alphland",
                    "otp",
                    null,
                    String((sendError as any).message || sendError),
                  );
                } else {
                  console.log(`OTP email sent to ${email}`);
                  return logEmail(
                    email,
                    "Your login code - Alphland",
                    "otp",
                    (data as any)?.id || null,
                    null,
                  );
                }
              })
              .catch((err) => {
                console.error("OTP email error:", err);
              }),
          );
        },
      }),
    ],

    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24,
      cookieCache: {
        enabled: false, // Disabled: session data exceeds cookie size limit
      },
    },

    baseURL: publicUrl,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: getTrustedOrigins(env),

    // TODO: Re-enable account settings when we have a real production domain
    // Currently commented out to avoid cookie/state issues in preview domains
    // account: {
    //   accountLinking: {
    //     enabled: true,
    //   },
    //   skipStateCookieCheck: true, // Skip state cookie check for Vercel preview domains
    // },

    advanced: {
      database: {
        generateId: () => crypto.randomUUID(),
      },
    },

    // Database hooks for auto-generating default username on user creation
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const maxRetries = 3;
            for (let attempt = 0; attempt < maxRetries; attempt++) {
              try {
                // Generate default username from email
                const emailPrefix = user.email
                  .split("@")[0]
                  .replace(/[^a-zA-Z0-9]/g, "")
                  .toLowerCase()
                  .slice(0, 20);

                // Generate random alphanumeric suffix (4 chars + extra on retry)
                const suffixLength = 4 + attempt;
                const randomSuffix = Array.from(
                  crypto.getRandomValues(new Uint8Array(suffixLength)),
                )
                  .map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36])
                  .join("");

                const defaultUsername = `${emailPrefix}_${randomSuffix}`;
                const now = Math.floor(Date.now() / 1000);

                // Ensure user_profiles row exists (fallback if trigger didn't run)
                await kysely
                  .insertInto("user_profiles")
                  .values({
                    id: crypto.randomUUID(),
                    user_id: user.id,
                    username: defaultUsername,
                    is_default_username: 1,
                    created_at: now,
                    updated_at: now,
                  })
                  .onConflict((oc) =>
                    oc.column("user_id").doUpdateSet({
                      username: defaultUsername,
                      is_default_username: 1,
                      updated_at: now,
                    }),
                  )
                  .execute();

                console.log(
                  `[AUTH] Auto-generated username "${defaultUsername}" for user ${user.id}`,
                );
                return; // Success, exit loop
              } catch (error: any) {
                // If it's a UNIQUE constraint violation on username, retry with longer suffix
                if (
                  attempt < maxRetries - 1 &&
                  error?.message?.includes("UNIQUE")
                ) {
                  console.warn(
                    `[AUTH] Username collision on attempt ${attempt + 1}, retrying...`,
                  );
                  continue;
                }
                // Don't fail user creation if username generation fails
                console.error(
                  "[AUTH] Failed to generate default username:",
                  error,
                );
              }
            }
          },
        },
      },
    },
  });
}
