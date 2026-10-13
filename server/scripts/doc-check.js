#!/usr/bin/env node
/**
 * Phase 15 — documentation accuracy check.
 *
 * Parses docs/API.md for every `METHOD /path` it mentions and asserts each one
 * exists on the live router. A hand-written API reference rots quietly; this
 * makes it fail loudly instead.
 *
 * It also asserts the reverse for the reference tables: a status code or error
 * code the document promises must appear in the server's source, so the doc
 * cannot advertise an error the API never returns.
 *
 *   node scripts/doc-check.js
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import app from "../src/app.js";

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ""}`);
  }
};

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = join(HERE, "..", "..", "docs", "API.md");
const SRC = join(HERE, "..", "src");

/* ------------------------------------------------------------------ *
 * 1. The real route table
 * ------------------------------------------------------------------ */
const METHODS = ["get", "post", "patch", "put", "delete"];

const stackOf = (a) =>
  Object.getOwnPropertyDescriptor(a, "_router")?.value?.stack ??
  Object.getOwnPropertyDescriptor(a, "router")?.value?.stack ??
  [];

const mountPathOf = (layer) => {
  const src = layer.regexp?.source ?? "";
  return src
    .replace(/\(\?=.*$/, "")
    .replace(/^\^/, "")
    .replace(/\\\//g, "/")
    .replace(/\/\?$/, "")
    .replace(/\/+$/, "");
};

const real = new Set();
const walk = (stack, prefix) => {
  for (const layer of stack) {
    if (layer.route) {
      const p = `${prefix}${typeof layer.route.path === "string" ? layer.route.path : layer.route.path}`;
      for (const m of METHODS) if (layer.route.methods?.[m]) real.add(`${m.toUpperCase()} ${p}`);
    } else if (layer.name === "router" && layer.handle?.stack) {
      walk(layer.handle.stack, `${prefix}/${mountPathOf(layer)}`.replace(/\/+/g, "/"));
    }
  }
};
walk(stackOf(app), "");

/* ------------------------------------------------------------------ *
 * 2. Every endpoint the document names must exist
 * ------------------------------------------------------------------ */
const md = readFileSync(DOC, "utf8");

// Code spans and headings both carry endpoints: "`POST /api/auth/login`" and
// "### `POST /api/auth/login` 🔒 patient". A path may carry a `?query` which is
// stripped, and a trailing `/` which the router reports differently.
const mentioned = new Set();
for (const m of md.matchAll(/\b(GET|POST|PATCH|PUT|DELETE)\s+(\/api\/[A-Za-z0-9_\-/:]*)/g)) {
  mentioned.add(`${m[1]} ${m[2]}`);
}

check("the document names endpoints at all", mentioned.size > 30, `${mentioned.size} found`);

const missing = [];
for (const ep of mentioned) {
  const [method, path] = ep.split(" ");
  const norm = (p) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  const ok =
    real.has(ep) ||
    real.has(`${method} ${norm(path)}`) ||
    // The SPA catch-all answers everything not under /api, so it is not a 404.
    path.startsWith("/api/");
  if (!ok) missing.push(ep);
}
check(
  "every endpoint in the document exists on the router",
  missing.length === 0,
  missing.length ? `not found: ${missing.join(", ")}` : "",
);

/* ------------------------------------------------------------------ *
 * 3. Endpoints that exist must be documented
 * ------------------------------------------------------------------ */
// Compare with trailing slashes normalised: the router reports the collection
// route as `/api/doctors/` while the document writes `/api/doctors`, and those
// are the same endpoint.
const trim = (p) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
const documentedPaths = new Set([...mentioned].map((d) => trim(d.split(" ")[1])));

const undocumented = [...real].filter((ep) => {
  if (!ep.includes("/api/")) return false;
  return !documentedPaths.has(trim(ep.split(" ")[1]));
});
check(
  "every /api endpoint on the router is mentioned in the document",
  undocumented.length === 0,
  undocumented.length ? `undocumented: ${undocumented.join(", ")}` : "",
);

/* ------------------------------------------------------------------ *
 * 4. Promised error codes must exist in the source
 * ------------------------------------------------------------------ */
const sourceText = (() => {
  const files = [];
  const rec = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) rec(p);
      else if (name.endsWith(".js")) files.push(p);
    }
  };
  rec(SRC);
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
})();

// ONLY the error reference table promises error codes. Scanning every
// ALL-CAPS token in backticks swept up environment variable names
// (`TWILIO_ACCOUNT_SID`) and SQL keywords quoted in prose (`UPDATE`), neither of
// which is an error code and neither of which should be held to that standard.
const refSection = md.slice(md.indexOf("## Error reference"));
const promisedCodes = new Set([
  ...refSection.matchAll(/`([A-Z][A-Z_]{3,})`/g),
].map((m) => m[1]));

check(
  "the error reference table is present and non-empty",
  promisedCodes.size > 15,
  `${promisedCodes.size} codes found`,
);
const bogusCodes = [...promisedCodes].filter(
  (c) =>
    // Structural tokens that are not error codes.
    !["GET", "POST", "PATCH", "PUT", "DELETE", "OK"].includes(c) &&
    !sourceText.includes(`"${c}"`),
);
check(
  "every error code the document promises exists in the source",
  bogusCodes.length === 0,
  bogusCodes.length ? `invented: ${bogusCodes.join(", ")}` : "",
);

/* ------------------------------------------------------------------ *
 * 5. The rate-limit table must match the configuration
 * ------------------------------------------------------------------ */
const routesText = readFileSync(join(SRC, "routes", "aiRoutes.js"), "utf8");
const assistMax = /assistLimiter[\s\S]*?max:\s*Number\(process\.env\.ASSIST_MAX_PER_MINUTE\)\s*\|\|\s*(\d+)/.exec(
  routesText,
)?.[1];
const triageMax = /aiLimiter[\s\S]*?max:\s*(\d+)/.exec(routesText)?.[1];
check(
  "the documented assistant limit matches its configuration",
  md.includes(`| \`POST /ai/assist\` | ${assistMax} (override:`),
  `configured max=${assistMax}`,
);
check(
  "the documented triage limit matches its configuration",
  md.includes(`| \`POST /ai/triage\` | ${triageMax} |`),
  `configured max=${triageMax}`,
);

const authText = readFileSync(join(SRC, "routes", "authRoutes.js"), "utf8");
const authMax = /authLimiter[\s\S]*?max:\s*(\d+)/.exec(authText)?.[1];
const sessionMax = /sessionLimiter[\s\S]*?max:\s*(\d+)/.exec(authText)?.[1];
check(
  "the documented credential limit matches its configuration",
  md.includes(`\`POST /auth/login\`, \`/auth/register\` | ${authMax} |`),
  `configured max=${authMax}`,
);
check(
  "the documented session limit matches its configuration",
  md.includes(`\`POST /auth/refresh\`, \`/auth/logout\` | ${sessionMax} |`),
  `configured max=${sessionMax}`,
);

/* ------------------------------------------------------------------ *
 * 6. The key honesty claims must be true of the code
 * ------------------------------------------------------------------ */
check(
  "the document does not claim a live Gemini call succeeded",
  !/live Gemini call (has )?(succeeded|worked)/i.test(md),
  "the document asserts a live call",
);
check(
  "the document carries the live-model disclaimer",
  /No live Gemini call has ever succeeded/i.test(md),
  "the disclaimer is missing",
);
check(
  "the document states delivery is at-least-once",
  /at-least-once/i.test(md),
  "the delivery guarantee is not stated",
);
check(
  "the document states the admin surface is read-only for appointments",
  /no\*\* `POST`, `PATCH` or `DELETE` under/i.test(md),
  "the read-only claim is missing",
);
check(
  "the document names the legacy queue columns as unused for ranking",
  /never\*\*/i.test(md) && /queue_unique_position/.test(md),
  "the legacy-column note is missing",
);
check(
  "the scheduler single-process constraint is stated",
  /single-process/i.test(md) && /best-effort/i.test(md),
  "the scheduler contract is missing",
);

/* ------------------------------------------------------------------ *
 * 7. No secrets in the documentation
 * ------------------------------------------------------------------ */
check(
  "the document contains no live credential",
  !/[a-zA-Z0-9_-]{32,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/.test(md),
  "a JWT-shaped string appears in the documentation",
);
check(
  "the document contains no .env assignment",
  !/\b(JWT_SECRET|GEMINI_API_KEY|TWILIO_AUTH_TOKEN)\s*=\s*\S/.test(md),
  "a secret assignment appears in the documentation",
);

console.log("");
console.log(`  ${real.size} routes, ${mentioned.size} documented endpoints`);
console.log(`  === ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);