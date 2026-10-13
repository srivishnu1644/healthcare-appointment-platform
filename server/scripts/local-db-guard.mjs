/**
 * Local-only database guard, defence in depth.
 *
 * `scripts/local-db-guard.mjs` is the primary control: every harness imports it
 * FIRST, and it applies the isolated local override at module evaluation, before
 * anything that initialises a connection is evaluated.
 *
 * This module is the backstop for a script that forgot to import it, or imported
 * the two in the wrong order. It matters because `buildConfig()` below runs at
 * module-init, so an override applied after the fact is already too late.
 *
 * Both sides share this one allowlist, so they cannot drift apart.
 *
 * Scoped to the explicit opt-in flag: the application's own behaviour, including
 * running against a hosted database, is unchanged. This is a test control, not a
 * product control.
 */

/** The only connection automated tests may use. */
export const AUTHORIZED_LOCAL_DSN = "postgresql://postgres@127.0.0.1:5440/medicare_test";

/** Set by every harness in this repository. The explicit authorisation. */
export const TEST_AUTH_FLAG = "MEDICARE_TEST_HARNESS";

/** Substrings that mean "somebody's hosted database, not my laptop". */
const HOSTED_MARKERS = [
  "supabase",
  "neon.tech",
  "rds.amazonaws.com",
  "amazonaws.com",
  "azure.com",
  "googleapis.com",
  "cloudsql",
  "herokuapp.com",
  "render.com",
  "railway.app",
  "planetscale",
  "cockroachlabs",
  "digitalocean",
  "aiven",
  "timescale",
  "elephantsql",
];

/**
 * A safe-to-print form of a DSN.
 *
 * Replaces the password and drops the query string (some hosted providers put
 * credentials there). Never expect a credential to survive this.
 */
export const redactDsn = (dsn) => {
  if (!dsn) return "(unset)";
  // String surgery rather than a URL round-trip: `new URL()` percent-encodes
  // whatever goes in the password field, so "<redacted>" comes back as
  // "%3Credacted%3E" and the message looks like it failed to redact.
  const masked = String(dsn).replace(/\/\/([^:/@]+):[^@/]+@/, "//$1:<redacted>@");
  // A query string can carry secrets too; drop everything from "?" on.
  return masked.split("?")[0];
};

/** Loopback by name or by address. */
const isLoopback = (dsn) => {
  try {
    const h = new URL(dsn).hostname.replace(/^\[|\]$/g, "");
    // Only the canonical loopback names and address. Not the machine's own
    // hostname: a host named "db" can resolve anywhere, and a test that attaches
    // to whatever resolves is not an isolated test.
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
};

/**
 * May this connection be used by an automated test?
 *
 * Authorised when it is exactly the project's local test DSN, or when it is
 * loopback and carries no hosted marker. Everything else is refused - including
 * a staging box and a colleague's forwarded port, both of which "look local"
 * enough to pass a weaker check.
 */
export const isAuthorizedForLocalTesting = (dsn) => {
  if (!dsn || typeof dsn !== "string") return false;
  const trimmed = dsn.trim();
  if (!trimmed) return false;
  if (trimmed === AUTHORIZED_LOCAL_DSN) return true;

  const lowered = trimmed.toLowerCase();
  if (HOSTED_MARKERS.some((m) => lowered.includes(m))) return false;
  return isLoopback(trimmed);
};

/**
 * The guard.
 *
 * @param {{force?: boolean}} options with `force`, the project's local test DSN
 *   is applied regardless of what is set. Used by the import side effect when
 *   the test-auth flag is present, so a stray `DATABASE_URL` cannot survive
 *   into a harness that asked for isolation.
 * @returns {{dsn: string, applied: string|null}}
 */
export const guardLocalDatabase = ({ force = false } = {}) => {
  const before = process.env.DATABASE_URL?.trim();
  const authorized = process.env[TEST_AUTH_FLAG] === "1";

  if (authorized || force) {
    // Explicit authorisation: the harness wants the isolated local database.
    // Overwrite unconditionally. dotenv may have already put the hosted URL
    // here, and "dotenv does not override existing variables" is not a control.
    const applied = before && before !== AUTHORIZED_LOCAL_DSN ? before : null;
    process.env.DATABASE_URL = AUTHORIZED_LOCAL_DSN;
    return { dsn: AUTHORIZED_LOCAL_DSN, applied };
  }

  if (!before) {
    throw new Error(
      [
        "",
        "LOCAL-DB GUARD: no DATABASE_URL is set, and this script is not",
        `authorised for testing (${TEST_AUTH_FLAG}=1). Refusing to guess a database.`,
        "",
        `  Tests and harnesses must opt in explicitly: ${TEST_AUTH_FLAG}=1`,
        "",
      ].join("\n"),
    );
  }

  if (!isAuthorizedForLocalTesting(before)) {
    throw new Error(
      [
        "",
        "LOCAL-DB GUARD: refusing a database connection that is not authorised",
        "for isolated local testing.",
        "",
        `  in force: ${redactDsn(before)}`,
        "",
        `  Automated tests may only use ${AUTHORIZED_LOCAL_DSN}.`,
        "",
        "  Either point DATABASE_URL at a local database, or opt in explicitly:",
        `    ${TEST_AUTH_FLAG}=1`,
        "",
      ].join("\n"),
    );
  }

  return { dsn: before, applied: null };
};

/* ------------------------------------------------------------------ *
 *  Import side effect                                                 *
 *                                                                    *
 *  Runs at module evaluation, i.e. before any import listed after it *
 *  in the importing file is evaluated. That is the whole point:      *
 *  `database.js` reads DATABASE_URL at import (buildConfig), so an  *
 *  override has to happen here or not at all.                       *
 * ------------------------------------------------------------------ */
guardLocalDatabase();
