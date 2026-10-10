/**
 * Recorded UI walkthrough of the patient + admin journeys.
 *
 * Requires the API (port 5000) and Vite client to already be running:
 *   npm run dev:server      # terminal 1
 *   npm run dev:client      # terminal 2
 *   node scripts/ui-walkthrough.mjs
 *
 * Produces a WebM video in ./recordings plus a JSON step-by-step report.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.APP_URL || "http://localhost:5174";
const OUT_DIR = path.resolve("recordings");
const VIDEO_SIZE = { width: 1280, height: 800 };

const steps = [];
let failures = 0;

const log = (msg) => console.log(`  ${msg}`);

/** Record a titled step: logs it, screenshots it, and pushes to the report. */
async function step(ctx, page, name, fn) {
  const n = steps.length + 1;
  console.log(`\n[${n}] ${name}`);
  try {
    await fn();
    const shot = path.join(
      OUT_DIR,
      `step-${String(n).padStart(2, "0")}-${slug(name)}.png`,
    );
    await page.screenshot({ path: shot, fullPage: true });
    steps.push({
      step: n,
      name,
      status: "PASS",
      screenshot: path.basename(shot),
    });
    log("PASS");
  } catch (err) {
    failures++;
    const shot = path.join(
      OUT_DIR,
      `step-${String(n).padStart(2, "0")}-${slug(name)}-FAILED.png`,
    );
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    steps.push({
      step: n,
      name,
      status: "FAIL",
      error: err.message,
      screenshot: path.basename(shot),
    });
    console.error(`  FAIL: ${err.message}`);
  }
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

/** Sign in through the real login form using the demo-fill shortcut. */
async function loginAs(page, label, email, password) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: label, exact: true }).click();
  const emailVal = await page.locator("#email").inputValue();
  if (emailVal !== email)
    throw new Error(`demo fill mismatch: got ${emailVal}, want ${email}`);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForLoadState("networkidle");
}

const signOut = async (page) => {
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await page.waitForLoadState("networkidle");
};

const run = async () => {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: VIDEO_SIZE,
    recordVideo: { dir: OUT_DIR, size: VIDEO_SIZE },
  });
  const page = await ctx.newPage();

  // Fail loudly if any page errors so the report reflects reality.
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(e.message));

  console.log(`\n=== UI walkthrough (${BASE}) ===`);

  // ---------------------------------------------------------------- public
  await step(ctx, page, "Landing page", async () => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("heading", { level: 1 }).first().waitFor();
  });

  await step(ctx, page, "Doctor directory with filters", async () => {
    await page.goto(`${BASE}/doctors`, { waitUntil: "networkidle" });
    await page.locator("#f-search").waitFor();
    await page.locator("#f-search").fill("a");
    await page.waitForTimeout(900); // debounced search
  });

  await step(ctx, page, "Filter by specialty", async () => {
    await page.locator("#f-search").fill("");
    const spec = page.locator("#f-spec");
    const value = await spec.locator("option").nth(1).getAttribute("value");
    await spec.selectOption(value);
    await page.waitForTimeout(900);
  });

  // ---------------------------------------------------------------- AI triage
  await step(ctx, page, "AI symptom checker triage", async () => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page
      .locator("textarea")
      .first()
      .fill("chest pain and shortness of breath");
    await page
      .getByRole("button", { name: /triage|check|analy/i })
      .first()
      .click();
    await page.locator("textarea").first().waitFor();
    await page.waitForTimeout(1800);
  });

  // ---------------------------------------------------------------- patient
  await step(ctx, page, "Sign in as patient", async () => {
    await loginAs(page, "Patient", "patient@demo.com", "patient123");
    if (!(await page.locator("body").innerText()).match(/patient/i)) {
      throw new Error("expected to be signed in as a patient");
    }
  });

  await step(ctx, page, "Book an appointment", async () => {
    await page.goto(`${BASE}/doctors`, { waitUntil: "networkidle" });
    await page.locator("#f-search").fill("");
    await page
      .getByRole("link", { name: /book now/i })
      .first()
      .click();
    await page.waitForLoadState("networkidle");
    // Pick the first date, then the first available (non-primary) slot chip.
    await page
      .locator(".btn-primary.btn-block")
      .filter({ hasText: /book/i })
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(1200);
    const slot = page
      .locator("button.btn-secondary.btn-sm")
      .filter({ hasText: /^\d{1,2}:\d{2}/ });
    const slotCount = await slot.count();
    if (slotCount === 0) throw new Error("no selectable slot chips rendered");
    await slot.first().click();
    await page.locator("#reason").fill("Walkthrough demo booking");
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await page.waitForTimeout(2000);
  });

  await step(ctx, page, "View my appointments", async () => {
    await page.goto(`${BASE}/appointments`, { waitUntil: "networkidle" });
    await page
      .getByRole("heading", { name: /appointment/i })
      .first()
      .waitFor();
  });

  await step(ctx, page, "View notifications", async () => {
    await page.goto(`${BASE}/notifications`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
  });

  await step(ctx, page, "Edit profile", async () => {
    await page.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
    await page.locator("form").first().waitFor();
  });

  // ---------------------------------------------------------------- admin
  await step(ctx, page, "Sign out of patient", async () => {
    await signOut(page);
  });

  await step(ctx, page, "Admin dashboard analytics", async () => {
    await loginAs(page, "Admin", "admin@demo.com", "admin123");
    await page.waitForTimeout(1200);
    await page
      .getByRole("heading", { name: /admin|dashboard|overview/i })
      .first()
      .waitFor();
  });

  await step(ctx, page, "Admin manage doctors", async () => {
    await page.goto(`${BASE}/admin/doctors`, { waitUntil: "networkidle" });
    await page.locator('input[placeholder="Search doctors…"]').waitFor();
  });

  await step(ctx, page, "Admin manage patients", async () => {
    await page.goto(`${BASE}/admin/patients`, { waitUntil: "networkidle" });
    await page.locator('input[placeholder="Search patients…"]').waitFor();
  });

  // ------------------------------------------------------- doctor / provider
  await step(ctx, page, "Sign out of admin", async () => {
    await signOut(page);
  });

  await step(ctx, page, "Provider schedule dashboard", async () => {
    await loginAs(page, "Doctor", "doctor1@demo.com", "doctor123");
    await page.waitForTimeout(1200);
    await page
      .getByRole("heading", { name: /schedule|provider|today/i })
      .first()
      .waitFor();
  });

  await step(ctx, page, "Sign out and reach login", async () => {
    await signOut(page);
  });

  const summary = {
    total: steps.length,
    passed: steps.filter((s) => s.status === "PASS").length,
    failed: failures,
    consoleErrors,
    steps,
  };

  await writeFile(
    path.join(OUT_DIR, "walkthrough-report.json"),
    JSON.stringify(summary, null, 2),
  );

  // The video is only finalised once the context closes.
  const video = page.video();
  await ctx.close();
  const file = await video.path();
  const finalPath = path.join(OUT_DIR, "ui-walkthrough.webm");
  await writeFile(
    finalPath,
    await import("node:fs/promises").then((fs) => fs.readFile(file)),
  );

  await browser.close();

  console.log(`\n=== ${summary.passed} passed, ${failures} failed ===`);
  console.log(`Video:  ${finalPath}`);
  console.log(`Report: ${path.join(OUT_DIR, "walkthrough-report.json")}`);
  process.exit(failures > 0 ? 1 : 0);
};

run().catch((e) => {
  console.error("\nWalkthrough crashed:", e);
  process.exit(1);
});
