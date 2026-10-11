#!/usr/bin/env node
/**
 * Phase 7 routing checks.
 *
 *   node scripts/routing-check.mjs                    # preview build on :4173
 *   APP_URL=http://localhost:5173 node scripts/routing-check.mjs
 *
 * WHAT THIS COVERS
 *   The route table and the guards around it, driven as a user would:
 *
 *     * where each role lands after signing in, and from a signed-in visit to "/"
 *     * anonymous visitors are redirected to sign-in from every protected route
 *     * a signed-in user cannot reach their own dashboard, not an error
 *     * /login and /register bounce a signed-in user to their own dashboard
 *     * an unknown URL resolves to the right home for the current role
 *     * a direct load and a refresh of a protected route both work
 *     * signing in returns the user to the page they were originally headed to
 *     * the header navigation reflects the role
 *
 * WHY A REAL BROWSER
 *   These are router decisions: redirects, guards and the catch-all. They only
 *   mean anything as navigation, so they are asserted as navigation rather than
 *   against the component tree.
 *
 *   Route-level CHUNK loading is asserted separately, by hook-checks.mjs.
 */
import { chromium } from "playwright";

const APP_URL = process.env.APP_URL || "http://localhost:4173";
const TZ = process.env.TZ || "Asia/Kolkata";

const ACCOUNTS = {
  patient: { label: "Patient", email: "patient@demo.com", password: "patient123" },
  doctor: { label: "Doctor", email: "doctor1@demo.com", password: "doctor123" },
  admin: { label: "Admin", email: "admin@demo.com", password: "admin123" },
};

const results = [];
const check = (name, cond, detail = "") =>
  results.push({ name, ok: Boolean(cond), detail: String(detail) });

const pathOf = (page) => new URL(page.url()).pathname;

/**
 * Load a URL and wait for the router to settle on `expectedPath`.
 *
 * The guards redirect from inside React, after the session restore resolves, so
 * sampling the path the instant `networkidle` fires races the redirect. Asserting
 * an immediate reading makes this suite flaky rather than strict.
 */
async function gotoExpecting(page, url, expectedPath, timeout = 15000) {
  await page.goto(url, { waitUntil: "networkidle" }).catch(() => {});
  await page
    .waitForFunction((p) => location.pathname === p, expectedPath, { timeout })
    .catch(() => {});
  return pathOf(page) === expectedPath;
}

/**
 * Sign in through the real form and wait for the SPA to leave /login.
 *
 * `alreadyOnLogin` matters: the guard hands the destination to /login as router
 * state, and a full page load would throw that state away. Checking the
 * "return me to where I was going" behaviour means signing in from the page the
 * guard already redirected to, not by navigating there again.
 */
async function signIn(page, role, { alreadyOnLogin = false } = {}) {
  const creds = ACCOUNTS[role];
  if (!alreadyOnLogin) {
    await page.goto(`${APP_URL}/login`, { waitUntil: "networkidle" });
  }
  await page.getByRole("button", { name: creds.label, exact: true }).click();
  await page.locator("#email").fill(creds.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(() => !location.pathname.startsWith("/login"), {
    timeout: 20000,
  });
  await page.waitForLoadState("networkidle");
}

const run = async () => {
  const browser = await chromium.launch();

  /* ---------------------------------------------------------------- *
   * 1. an anonymous visitor                                          *
   * ---------------------------------------------------------------- */
  {
    const context = await browser.newContext({ timezoneId: TZ });
    const page = await context.newPage();

    await page.goto(`${APP_URL}/`, { waitUntil: "networkidle" });
    check("an anonymous visitor sees the public landing page at /", pathOf(page) === "/",
      page.url());
    const landing = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    check("the landing page offers a way to sign in",
      /sign in|log in/i.test(landing), landing.slice(0, 100));

    // Every protected route must send an anonymous visitor to sign-in rather
    // than rendering anything behind the guard.
    for (const route of [
      "/dashboard",
      "/appointments",
      "/appointments/anything",
      "/notifications",
      "/profile",
      "/provider",
      "/admin",
      "/admin/doctors",
    ]) {
      const landed = await gotoExpecting(page, `${APP_URL}${route}`, "/login");
      check(`an anonymous visit to ${route} is sent to sign-in`, landed,
        `${route} -> ${pathOf(page)}`);
    }

    const anonHome = await gotoExpecting(page, `${APP_URL}/no-such-page-at-all`, "/");
    check("an unknown URL as an anonymous visitor lands on the public home",
      anonHome, page.url());

    await context.close();
  }

  /* ---------------------------------------------------------------- *
   * 2. a patient                                                     *
   * ---------------------------------------------------------------- */
  {
    const context = await browser.newContext({ timezoneId: TZ });
    const page = await context.newPage();

    await signIn(page, "patient");
    check("signing in as a patient lands on /dashboard", pathOf(page) === "/dashboard",
      page.url());

    await page.goto(`${APP_URL}/`, { waitUntil: "networkidle" });
    // "/" is the public landing page and stays reachable when signed in; it is
    // a page, not a redirect. What matters is that the header still offers the
    // signed-in user's own dashboard, and that no guard has trapped them.
    const patientLanding = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    check("a signed-in patient visiting / still gets the public landing page",
      pathOf(page) === "/" && patientLanding.length > 40, page.url());
    check("the header still offers a patient their own dashboard",
      (await page.locator("header a, nav a").allInnerTexts()).some((t) => /dashboard/i.test(t)));

    for (const route of ["/login", "/register"]) {
      await page.goto(`${APP_URL}${route}`, { waitUntil: "networkidle" });
      check(`a signed-in patient visiting ${route} is sent to their dashboard`,
        pathOf(page) === "/dashboard", `${route} -> ${pathOf(page)}`);
    }

    // Another role's area is not reachable, and must not 403 on screen.
    for (const route of ["/provider", "/admin", "/admin/doctors", "/admin/patients"]) {
      const landed = await gotoExpecting(page, `${APP_URL}${route}`, "/dashboard");
      check(`a patient visiting ${route} is returned to their own dashboard`,
        landed, `${route} -> ${pathOf(page)}`);
    }

    await page.goto(`${APP_URL}/appointments`, { waitUntil: "networkidle" });
    check("a patient can open their appointments", pathOf(page) === "/appointments",
      page.url());
    const appointments = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    check("the appointments page renders its own content",
      /appointment/i.test(appointments) && appointments.length > 40,
      appointments.slice(0, 100));

    // A refresh of a protected route must behave like a direct load of it.
    await page.reload({ waitUntil: "networkidle" });
    check("refreshing a protected route keeps the user on it",
      pathOf(page) === "/appointments", page.url());
    check("the refreshed protected route still renders content",
      (await page.locator("main").innerText()).replace(/\s+/g, " ").length > 40);

    const patientHome = await gotoExpecting(
      page,
      `${APP_URL}/no-such-page-at-all`,
      "/dashboard",
    );
    check("an unknown URL as a patient lands on their dashboard", patientHome, page.url());

    const nav = await page.locator("header a, nav a").allInnerTexts();
    check("the patient header offers their own areas",
      nav.some((t) => /My appointments/i.test(t)) && !nav.some((t) => /^\s*Doctors\s*$/i.test(t)),
      nav.join(" | "));

    // Signing in from a guarded page returns the user to where they were going.
    await page.goto(`${APP_URL}/profile`, { waitUntil: "networkidle" });
    check("the patient can open their profile", pathOf(page) === "/profile", page.url());

    await context.close();
  }

  /* ---------------------------------------------------------------- *
   * 3. sign-in returns you to the page you asked for                  *
   * ---------------------------------------------------------------- */
  {
    const context = await browser.newContext({ timezoneId: TZ });
    const page = await context.newPage();

    await page.goto(`${APP_URL}/notifications`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => location.pathname === "/login", { timeout: 15000 })
      .catch(() => {});
    check("an anonymous visit to /notifications lands on sign-in",
      pathOf(page) === "/login", page.url());

    // Signed in from the page the guard redirected to, so the destination the
    // guard handed over is still in router state.
    await signIn(page, "patient", { alreadyOnLogin: true });
    check("signing in returns the user to the page they were headed to",
      pathOf(page) === "/notifications", page.url());

    await context.close();
  }

  /* ---------------------------------------------------------------- *
   * 4. a provider                                                    *
   * ---------------------------------------------------------------- */
  {
    const context = await browser.newContext({ timezoneId: TZ });
    const page = await context.newPage();

    await signIn(page, "doctor");
    check("signing in as a provider lands on /provider", pathOf(page) === "/provider",
      page.url());

    await page.goto(`${APP_URL}/`, { waitUntil: "networkidle" });
    check("a provider visiting / still gets the public landing page",
      pathOf(page) === "/", page.url());
    check("the header still offers a provider their own dashboard",
      (await page.locator('header a[href="/provider"], nav a[href="/provider"]').count()) > 0);

    for (const route of ["/dashboard", "/appointments", "/admin"]) {
      const landed = await gotoExpecting(page, `${APP_URL}${route}`, "/provider");
      check(`a provider visiting ${route} is returned to their own dashboard`,
        landed, `${route} -> ${pathOf(page)}`);
    }

    const providerHome = await gotoExpecting(page, `${APP_URL}/no-such-page-at-all`, "/provider");
    check("an unknown URL as a provider lands on their dashboard", providerHome, page.url());

    await context.close();
  }

  /* ---------------------------------------------------------------- *
   * 5. an admin                                                      *
   * ---------------------------------------------------------------- */
  {
    const context = await browser.newContext({ timezoneId: TZ });
    const page = await context.newPage();

    await signIn(page, "admin");
    check("signing in as an admin lands on /admin", pathOf(page) === "/admin", page.url());

    await page.goto(`${APP_URL}/`, { waitUntil: "networkidle" });
    check("an admin visiting / still gets the public landing page",
      pathOf(page) === "/", page.url());
    check("the header still offers an admin their own dashboard",
      (await page.locator("header a, nav a").allInnerTexts()).some((t) => /dashboard/i.test(t)));

    for (const route of ["/dashboard", "/provider"]) {
      const landed = await gotoExpecting(page, `${APP_URL}${route}`, "/admin");
      check(`an admin visiting ${route} is returned to their own dashboard`,
        landed, `${route} -> ${pathOf(page)}`);
    }

    for (const route of ["/admin/doctors", "/admin/facilities", "/admin/patients",
      "/admin/notifications"]) {
      await page.goto(`${APP_URL}${route}`, { waitUntil: "networkidle" });
      check(`an admin can open ${route}`, pathOf(page) === route, `${route} -> ${pathOf(page)}`);
    }

    await context.close();
  }

  await browser.close();

  let passed = 0;
  let failed = 0;
  console.log("");
  for (const r of results) {
    if (r.ok) {
      passed += 1;
      console.log(`  PASS  ${r.name}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${r.name}${r.detail ? `  -> ${r.detail}` : ""}`);
    }
  }
  console.log("");
  console.log(`  app: ${APP_URL}`);
  console.log(`  === ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
};

run().catch((err) => {
  console.error(`\nrouting-check failed to run: ${err.message}`);
  process.exit(1);
});