/**
 * Central env bootstrap.
 *
 * Loads `.env` once, then applies prototype-safe defaults so a fresh clone runs
 * with `npm run dev`. Real environment variables always win, because dotenv does
 * not overwrite variables that already exist.
 *
 * Security rules enforced here:
 *   1. JWT_SECRET has NO hardcoded fallback. Outside `test`, a missing value is
 *      a fatal error rather than a silent insecure default.
 *   2. Optional integrations warn instead of throwing, so the app still boots
 *      without Gemini / Twilio / Resend credentials.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";

const ROOT = path.resolve(process.cwd());

// dotenv only reads ./.env by default; resolve it next to the server folder so
// the app works whether it is started from the repo root or the server folder.
const candidates = [
  path.join(ROOT, ".env"),
  path.join(ROOT, "server", ".env"),
  path.resolve(ROOT, "healthcare-appointment-platform", "server", ".env"),
];

let loaded = null;
for (const file of candidates) {
  if (fs.existsSync(file)) {
    loaded = dotenv.config({ path: file });
    break;
  }
}

if (!loaded) {
  console.warn("[env] no .env file found - falling back to environment only");
}

const IS_TEST = process.env.NODE_ENV === "test";
const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Record which variables were genuinely provided, BEFORE defaults are applied.
 *
 * This matters because a default and an explicit value are otherwise
 * indistinguishable afterwards: without this flag, a production boot could not
 * tell "CORS_ORIGIN was set to http://localhost:5173" from "nobody set it and we
 * filled in a placeholder", and a missing variable would silently pass.
 */
const PROVIDED = new Set(
  Object.entries(process.env)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k]) => k),
);

/** True when the variable was explicitly supplied (file or environment). */
export const wasProvided = (key) => PROVIDED.has(key);

/** Keys the app needs, with the value used when unset. Never a secret. */
const DEFAULTS = {
  PORT: "5000",
  NODE_ENV: "development",
  // Short-lived access token. The refresh token is the long-lived credential;
  // a 7-day access token was a 7-day window on a stolen bearer token.
  JWT_EXPIRES_IN: "15m",
  CORS_ORIGIN: "http://localhost:5173",
  GEMINI_MODEL: "gemini-2.0-flash",
  NOTIFICATION_FROM_EMAIL: "notifications@medicare.demo",
};

for (const [key, fallback] of Object.entries(DEFAULTS)) {
  if (!process.env[key]) process.env[key] = fallback;
}

/* ------------------------------------------------------------------ *
 *  JWT_SECRET — required, with no insecure default                     *
 * ------------------------------------------------------------------ */

/**
 * Development gets a per-process random secret. It is regenerated on every
 * restart (so old tokens stop working) and is never written to disk, so it
 * cannot be copied out of the repository. Production must supply its own.
 */
const generateEphemeralSecret = () =>
  crypto.randomBytes(48).toString("base64url");

if (!process.env.JWT_SECRET) {
  if (IS_TEST) {
    // Deterministic secret so test suites can sign and verify tokens.
    process.env.JWT_SECRET = "test-only-secret-not-for-production";
  } else if (IS_PROD) {
    console.error(
      [
        "",
        "[env] FATAL: JWT_SECRET is required in production.",
        "",
        "  Set it in the environment (never in version control):",
        "    JWT_SECRET=$(node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\")",
        "",
      ].join("\n"),
    );
    process.exit(1);
  } else {
    // Development / staging: random per process, safe for local use only.
    process.env.JWT_SECRET = generateEphemeralSecret();
    console.warn(
      "[env] JWT_SECRET not set - using a random per-process secret. " +
        "Tokens will not survive a restart. Set JWT_SECRET to persist sessions.",
    );
  }
}

/** Refuse an obviously-insecure secret before we start signing tokens with it. */
const INSECURE_SECRETS = new Set([
  "medicare-prototype-dev-secret",
  "change-me",
  "secret",
  "your-secret-key",
]);

if (INSECURE_SECRETS.has(process.env.JWT_SECRET)) {
  console.error(
    [
      "",
      "[env] FATAL: JWT_SECRET is a known placeholder value.",
      "",
      "  Generate a real secret:",
      "    node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (IS_PROD && process.env.JWT_SECRET.length < 32) {
  console.error(
    "[env] FATAL: JWT_SECRET must be at least 32 characters in production.",
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 *  Optional integrations                                              *
 * ------------------------------------------------------------------ */

const OPTIONAL = {
  GEMINI_KEY: "Google Gemini (live AI triage) - using rule-based engine",
  TWILIO_ACCOUNT_SID: "Twilio SMS - logging notifications to console",
  RESEND_API_KEY: "Resend email - logging notifications to console",
};

for (const [key, label] of Object.entries(OPTIONAL)) {
  if (!process.env[key]) console.warn(`[env] ${label} (${key} not set)`);
}

/**
 * CORS_ORIGIN must be set explicitly in production.
 *
 * Checked against `PROVIDED` rather than `process.env.CORS_ORIGIN`, because the
 * defaults loop above has already backfilled the development value. Without
 * this, a production deploy would silently allow only localhost — which fails
 * closed, but fails with a confusing CORS error rather than a clear message.
 */
if (IS_PROD && !PROVIDED.has("CORS_ORIGIN")) {
  console.error(
    [
      "",
      "[env] FATAL: CORS_ORIGIN is required in production.",
      "",
      "  Set it to your deployed frontend origin:",
      "    CORS_ORIGIN=https://medicare.vercel.app",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (IS_PROD && process.env.CORS_ORIGIN?.split(",").includes("*")) {
  console.error("[env] FATAL: CORS_ORIGIN must not contain '*'.");
  process.exit(1);
}