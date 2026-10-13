#!/usr/bin/env node
/**
 * Key exposure check.
 *
 * Extracts the key from server/.env into memory and tests whether any log, the
 * built client bundle, git history or any tracked file contains it. Prints only
 * booleans - never the key, never a prefix, never a length that could narrow it.
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const REPO = "/home/sri_vishnu/Desktop/healthcare-appointment-platform";
const envPath = `${REPO}/server/.env`;

if (!existsSync(envPath)) {
  console.log("  server/.env does not exist");
  process.exit(1);
}

const env = readFileSync(envPath, "utf8");
const line = env.split("\n").find((l) => /^\s*GEMINI_KEY\s*=/.test(l));
if (!line) {
  console.log("  GEMINI_KEY not present in server/.env");
  process.exit(1);
}
const key = line.split("=").slice(1).join("=").trim();
console.log(`  key extracted into memory: ${key.length > 0 ? "yes" : "no (empty)"}`);
if (!key) process.exit(1);

const check = (label, haystack) => {
  const hit = key.length > 8 && haystack.includes(key);
  console.log(`  ${hit ? "LEAK" : "clean"}  ${label}`);
};

// 1. The API log
const log = existsSync("/tmp/opencode/api.log") ? readFileSync("/tmp/opencode/api.log", "utf8") : "";
check("API log (/tmp/opencode/api.log)", log);

// 2. The built client bundle
let bundle = "";
try {
  bundle = execSync(`find ${REPO}/client/dist -type f -exec cat {} +`, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
} catch {
  /* dist may not exist */
}
check("built client bundle (client/dist)", bundle);

// 3. Every tracked + untracked source file
let src = "";
try {
  src = execSync(
    `cd ${REPO} && grep -rIl . --include='*.js' --include='*.jsx' --include='*.json' --include='*.md' --include='*.css' server/src client/src scripts docs 2>/dev/null | xargs cat`,
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
} catch {
  /* ignore */
}
check("all project source + docs", src);

// 4. Git: index, HEAD tree, and the whole object database
for (const [label, cmd] of [
  ["git index", "cd " + REPO + " && git ls-files -s | git cat-file --batch"],
  ["git HEAD commit", "cd " + REPO + " && git cat-file -p HEAD"],
  ["git all objects", "cd " + REPO + " && git rev-list --objects --all | awk '{print $1}' | git cat-file --batch 2>/dev/null"],
]) {
  try {
    const out = execSync(cmd, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    check(label, out);
  } catch {
    console.log(`  skip   ${label} (command failed)`);
  }
}

// 5. No secrets in the documentation
check("documentation (docs/)", readFileSync(`${REPO}/docs/gemini-live-verification.md`, "utf8"));

console.log("\n=== KEY EXPOSURE CHECK COMPLETE ===");