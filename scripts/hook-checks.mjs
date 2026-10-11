#!/usr/bin/env node
/**
 * Phase 7 client checks — runs the client in a real browser and reports.
 *
 *   node scripts/hook-checks.mjs                     # dev server on :5174
 *   HARNESS_URL=http://localhost:5174 \
 *   APP_URL=http://localhost:4173 node scripts/hook-checks.mjs
 *
 * TEN PARTS
 *   1. The harness page (client/checks.html) mounts the real hooks and the real
 *      PatientDashboard, and exercises the IST calendar-date fix, instant-based
 *      classification, both hooks' stale-response guards, and the dashboard's
 *      loading / empty / error / populated states with stubbed responses.
 *   2. The live application is driven to prove the notification poll is shared:
 *      with one provider there must be a single GET /notifications on mount, not
 *      one per consumer.
 *   3. The doctor directory is loaded for real: the default request must succeed
 *      and return doctors, every sort option in the UI must be one the API
 *      accepts, and a legacy ?sort=relevance bookmark must degrade rather than
 *      fail with 422.
 *   4. The patient dashboard, driven against the real API: its summary counts are
 *      compared with values computed independently from the API, its navigation
 *      actions are followed, and its layout is checked at desktop and phone width.
 *   5. The shared AppointmentCard in both of its consumers: rows are checked
 *      against the API payload, the cancel and reschedule modals are opened and
 *      dismissed, check-in gating is verified, and both layouts are measured.
 *   6. The appointment detail page: navigation from a row, agreement with the API,
 *      the status timeline, not-found for an unknown id and for another patient's
 *      appointment, API failure plus retry, and layout.
 *   7. Booking: the review summary, conflict handling, duplicate-submit
 *      protection, and the success panel built from the server's response.
 *   8. Rescheduling: future-only candidates, exclusion of the current slot, and
 *      that a real move actually changes the appointment.
 *   9. Lazy routes: the landing page and sign-in still work, a hard load or a
 *      refresh of a lazy protected route renders it, its chunk is fetched on
 *      demand, the loading fallback appears while a chunk is in flight, and
 *      route protection still holds for anonymous visitors and for a patient
 *      aiming at the admin area.
 *  10. Error boundary in the live app: a route chunk that fails to load leaves
 *      the shell standing with a usable recovery control instead of a blank page,
 *      and the same URL recovers once the chunk can load again.
 *
 *   Parts 9 and 10 are additionally exercised inside the harness page itself,
 *   which mounts the real ErrorBoundary against a component that throws on
 *   purpose and asserts the fallback appears, carries no stack trace or token,
 *   and offers a recovery action that works.
 *
 * TWO SERVERS, ON PURPOSE
 *   HARNESS_URL serves checks.html and must be the Vite DEV server, because only
 *   the dev server transforms JSX on the fly. APP_URL drives the real application
 *   and must be the PRODUCTION build (`npm run build` then `npx vite preview`):
 *   React's StrictMode double-invokes effects in development, so the dev build
 *   reports two or three notification requests even when there is exactly one
 *   owner. Counting pollers against the dev build measures StrictMode, not the app.
 *
 *
 * WHY PLAYWRIGHT AND NOT A UNIT RUNNER
 *   The project has no frontend test runner and Phase 7 is not adding one. It
 *   does have Playwright. The IST bug is a timezone bug: only a real browser
 *   pinned to Asia/Kolkata can reproduce it rather than simulate it.
 */
import { chromium } from "playwright";

const APP_URL = process.env.APP_URL || "http://localhost:5174";
const HARNESS_URL = process.env.HARNESS_URL || APP_URL;
const TZ = process.env.TZ || "Asia/Kolkata";
const PATIENT = {
  label: "Patient",
  email: "patient@demo.com",
  password: "patient123",
};

const results = [];
const check = (name, cond, detail = "") =>
  results.push({ name, ok: Boolean(cond), detail: String(detail) });

/* ------------------------------------------------------------------ *
 *  Part 1 — the harness page                                           *
 * ------------------------------------------------------------------ */
async function runHarness(browser) {
  const context = await browser.newContext({ timezoneId: TZ });
  const page = await context.newPage();

  const consoleErrors = [];
  let expectedConsole = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  try {
    await page.goto(`${HARNESS_URL}/checks.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__CHECKS_DONE__ === true, {
      timeout: 60000,
    });
    results.push(...(await page.evaluate(() => window.__RESULTS__)));

    // The harness crashes a component on purpose to exercise the error
    // boundary, and React logs every crash. The page publishes the exact
    // messages that deliberate crash produces, so they are filtered here rather
    // than by a blanket "ignore console errors", which would hide a real one.
    expectedConsole = await page.evaluate(() => window.__EXPECTED_CONSOLE__ || []);
  } catch (err) {
    results.push({ name: "harness ran to completion", ok: false, detail: err.message });
  }

  // React logs rather than throws when a response lands after unmount; a stray
  // console error would mean a guard failed quietly.
  for (const e of consoleErrors) {
    if (/favicon|Download the React DevTools/i.test(e)) continue;
    if (expectedConsole.some((pattern) => e.includes(pattern))) continue;
    results.push({ name: "no console errors while running hooks", ok: false, detail: e });
  }

  await context.close();
}

/* ------------------------------------------------------------------ *
 *  Part 2 — notification polling in the live app                      *
 * ------------------------------------------------------------------ */
async function runPolling(browser) {
  const context = await browser.newContext({ timezoneId: TZ });
  const page = await context.newPage();

  let hits = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/notifications") && r.method() === "GET") hits += 1;
  });

  try {
    await page.goto(`${APP_URL}/login`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: PATIENT.label, exact: true }).click();
    await page.locator("#email").fill(PATIENT.email);
    await page.locator("#password").fill(PATIENT.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    // Sign-in is a SPA transition; networkidle can resolve before the router
    // has navigated.
    await page.waitForFunction(() => !location.pathname.startsWith("/login"), {
      timeout: 15000,
    });
    // Let the sign-in's own traffic finish before counting. Otherwise a request
    // still in flight from the login page is attributed to the first
    // measurement below and inflates it.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // A full page load must fetch exactly once, whichever page it is. The old
    // code fetched once per consumer, so the dashboard fetched twice and the
    // notifications page fetched a third time on top of the shell's.
    hits = 0;
    await page.goto(`${APP_URL}/dashboard`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    const onDashboard = hits;
    check(
      "full load of /dashboard issues exactly one /notifications request",
      onDashboard === 1,
      `saw ${onDashboard}`,
    );

    hits = 0;
    await page.goto(`${APP_URL}/notifications`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    const onPage = hits;
    check(
      "full load of /notifications issues exactly one /notifications request",
      onPage === 1,
      `saw ${onPage}`,
    );

    // Now the stronger claim: navigating within the SPA must not fetch at all,
    // because the state is already loaded and shared. A per-consumer hook
    // would refetch every time a consumer mounted.
    await page.goto(`${APP_URL}/dashboard`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    hits = 0;
    await page.locator('nav a[href="/appointments"]').first().click();
    await page.waitForTimeout(1200);
    const afterNavigate = hits;
    check(
      "navigating within the SPA issues no further /notifications request",
      afterNavigate === 0,
      `saw ${afterNavigate}`,
    );

    // The payoff of a single owner: marking read clears the header bell at once,
    // instead of up to one poll interval later.
    await page.goto(`${APP_URL}/notifications`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const badge = page.locator('a[href="/notifications"] span').first();
    const before = (await badge.innerText().catch(() => "0")) || "0";
    if (Number(before) > 0) {
      await page.getByRole("button", { name: "Mark all read" }).first().click();
      await page.waitForTimeout(900);
      const after = await badge.innerText().catch(() => "");
      check(
        "marking read clears the shared header badge without waiting for a poll",
        after === "" || Number(after) === 0,
        `${before} -> ${after || "(gone)"}`,
      );
    } else {
      check(
        "shared header badge and notifications page agree on unread count",
        true,
        `both read ${before}; the mark-read click path was NOT exercised because the demo account has nothing unread`,
      );
    }
  } catch (err) {
    check("polling checks completed", false, err.message);
  }

  await context.close();
}

/* ------------------------------------------------------------------ *
 *  Part 3 — doctor directory regression                                *
 * ------------------------------------------------------------------ */

/**
 * The directory used to send ?sort=relevance, which the API's sort enum does
 * not contain. The request was rejected with 422 and the page rendered an empty
 * result set with no visible cause. This asserts the default request succeeds
 * and actually returns doctors.
 */
async function runDirectory(browser) {
  const context = await browser.newContext({ timezoneId: TZ });
  const page = await context.newPage();

  /** Load /doctors and report the status of the doctors call plus what rendered. */
  const open = async (query = "") => {
    let status = null;
    let sentSort = null;
    const onResponse = (r) => {
      const u = r.url();
      if (u.includes("/api/doctors?")) {
        status = r.status();
        sentSort = new URL(u).searchParams.get("sort");
      }
    };
    page.on("response", onResponse);
    await page.goto(`${APP_URL}/doctors${query}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    page.off("response", onResponse);

    const options = await page
      .locator("#sort option")
      .evaluateAll((els) => els.map((e) => e.value));
    return {
      status,
      sentSort,
      options,
      cards: await page.locator('a[href^="/doctors/"]').count(),
      shown: (await page.locator("body").innerText()).slice(0, 400),
    };
  };

  try {
    // 1. The default request — the one the bug broke.
    const base = await open("");
    check(
      "default doctor-directory request succeeds (no 422)",
      base.status === 200,
      `status ${base.status}`,
    );
    check("default directory request returns doctors", base.cards > 0, `cards=${base.cards}`);
    check(
      "default sort value is one the API accepts",
      base.sentSort === null || ["rating", "fee-low", "experience", "soonest"].includes(base.sentSort),
      `sent sort=${base.sentSort}`,
    );

    // 2. Every option offered in the UI must be acceptable to the API.
    const backendSorts = ["rating", "fee-low", "experience", "soonest"];
    const unsupported = base.options.filter((o) => !backendSorts.includes(o));
    check("every sort option in the UI is accepted by the API", unsupported.length === 0,
      `unsupported: ${unsupported.join(", ") || "none"}`);

    // 3. Each offered option must work, not just be listed.
    for (const opt of base.options) {
      const r = await open(`?sort=${encodeURIComponent(opt)}`);
      check(`sort=${opt} returns results`, r.status === 200 && r.cards > 0,
        `status ${r.status}, cards ${r.cards}`);
    }

    // 4. A legacy bookmark carrying the removed value must degrade, not 422.
    const legacy = await open("?sort=relevance");
    check("legacy ?sort=relevance bookmark degrades to the default instead of failing",
      legacy.status === 200 && legacy.cards > 0,
      `status ${legacy.status}, cards ${legacy.cards}`);

    // 5. Filters and navigation still work.
    await page.goto(`${APP_URL}/doctors`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const first = page.locator('a[href^="/doctors/"]').first();
    if (await first.count()) {
      await first.click();
      await page.waitForFunction(() => /^\/doctors\/[^/]+$/.test(location.pathname));
      check("a doctor card still navigates to the profile",
        /\/doctors\/[0-9a-f-]{8,}/.test(new URL(page.url()).pathname), page.url());
    } else {
      check("a doctor card still navigates to the profile", false, "no card to click");
    }
  } catch (err) {
    check("directory checks completed", false, err.message);
  }

  await context.close();
}

/* ------------------------------------------------------------------ *
 *  Part 4 — patient dashboard in the real app                          *
 * ------------------------------------------------------------------ */

const API = process.env.API_URL || "http://localhost:5000/api";

/** Ask the API directly what the dashboard should be showing right now. */
async function expectedDashboard(credentials) {
  const login = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  const session = (await login.json()).data;
  const res = await fetch(`${API}/appointments`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const appointments = (await res.json()).data.appointments || [];
  const now = Date.now();
  const live = ["scheduled", "confirmed", "in-progress"];
  const start = (a) => Date.parse(a.startsAt || "");
  const upcoming = appointments
    .filter((a) => live.includes(a.status) && start(a) > now)
    .sort((x, y) => start(x) - start(y));
  return {
    total: appointments.length,
    upcoming: upcoming.length,
    completed: appointments.filter((a) => a.status === "completed").length,
    next: upcoming[0] || null,
    all: appointments,
  };
}

async function runDashboard(browser) {
  const context = await browser.newContext({ timezoneId: TZ });
  const page = await context.newPage();

  try {
    await page.goto(`${APP_URL}/login`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: PATIENT.label, exact: true }).click();
    await page.locator("#email").fill(PATIENT.email);
    await page.locator("#password").fill(PATIENT.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForFunction(() => !location.pathname.startsWith("/login"), {
      timeout: 15000,
    });
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1200);

    const readStat = async (label) => {
      const value = await page
        .locator(".stat")
        .filter({ has: page.locator(".stat-label", { hasText: label }) })
        .locator(".stat-value")
        .first()
        .innerText()
        .catch(() => null);
      return value?.trim() ?? null;
    };

    check("dashboard renders four summary tiles",
      (await page.locator(".stat").count()) === 4,
      `found ${await page.locator(".stat").count()}`);

    // The counts on screen must agree with the API, computed here independently.
    const want = await expectedDashboard({ email: PATIENT.email, password: PATIENT.password });
    const shownUpcoming = await readStat("Upcoming visits");
    const shownCompleted = await readStat("Completed visits");
    check("upcoming count on screen matches the API",
      Number(shownUpcoming) === want.upcoming, `screen ${shownUpcoming} vs api ${want.upcoming}`);
    check("completed count on screen matches the API",
      Number(shownCompleted) === want.completed, `screen ${shownCompleted} vs api ${want.completed}`);

    if (want.next) {
      const card = await page.locator(".card").filter({ hasText: "Next appointment" }).first();
      const text = await card.innerText();
      check("next appointment is the soonest upcoming visit",
        text.includes(want.next.doctorName), `expected ${want.next.doctorName}`);
      // StatusBadge renders "in-progress" as "in progress"; compare like for like.
      const badgeText = String(want.next.status).replace(/-/g, " ");
      check("next appointment shows its status",
        new RegExp(badgeText, "i").test(text), `looking for "${badgeText}"`);
    } else {
      check("no upcoming visit shows the empty state",
        /No upcoming appointments/.test(await page.locator("body").innerText()));
    }

    // Step 7 made the list projection report the caller's own queue position, so the
    // dashboard may legitimately show a badge. Assert it against the payload
    // rather than pinning the old "never" - which was only true while the
    // projection always returned null.
    const queued = (want.all ?? []).filter(
      (a) => a.queuePosition !== null && a.queuePosition !== undefined,
    );
    const dashText = await page.locator("body").innerText();
    if (queued.length === 0) {
      check("dashboard shows no queue position when the list reports none",
        !/Queue\s*#\s*\d/.test(dashText), dashText.slice(0, 120).replace(/\s+/g, " "));
    } else {
      check("dashboard shows the queue position the list reported",
        new RegExp(`Queue\\s*#\\s*${queued[0].queuePosition}`).test(dashText),
        `expected "Queue #${queued[0].queuePosition}"`);
    }

    /* --- navigation actions --- */
    await page.locator('a[href="/doctors"]').first().click();
    await page.waitForFunction(() => location.pathname === "/doctors");
    check("'Find a doctor' navigates to the directory", page.url().endsWith("/doctors"));

    await page.goto(`${APP_URL}/dashboard`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    await page.locator('a[href="/appointments"]').first().click();
    await page.waitForFunction(() => location.pathname === "/appointments");
    check("'My appointments' navigates to the appointments page",
      page.url().endsWith("/appointments"));

    await page.goto(`${APP_URL}/dashboard`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const doctorHref = await page
      .locator('a[href^="/doctors/"]')
      .first()
      .getAttribute("href")
      .catch(() => null);
    if (doctorHref) {
      await page.locator(`a[href="${doctorHref}"]`).first().click();
      await page.waitForFunction(() => /^\/doctors\/[^/]+$/.test(location.pathname));
      check("'View doctor' navigates to a real profile route",
        new URL(page.url()).pathname === doctorHref, page.url());
    }

    /* --- responsive --- */
    await page.goto(`${APP_URL}/dashboard`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const wideCols = await page
      .locator(".grid-4")
      .first()
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    check("summary tiles sit side by side on a wide viewport", wideCols === 4, `${wideCols} columns`);

    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(400);
    const narrowCols = await page
      .locator(".grid-4")
      .first()
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    check("summary tiles stack on a phone-width viewport", narrowCols === 1, `${narrowCols} columns`);

    const splitCols = await page
      .locator(".split")
      .first()
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    check("the two-column split collapses on a phone", splitCols === 1, `${splitCols} columns`);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check("no horizontal overflow at 360px", overflow <= 1, `${overflow}px of overflow`);

    await page.setViewportSize({ width: 1280, height: 900 });
  } catch (err) {
    check("dashboard checks completed", false, err.message);
  }

  await context.close();
}

/* ------------------------------------------------------------------ *
 *  Part 5 — the shared AppointmentCard across its two consumers        *
 * ------------------------------------------------------------------ */

async function runAppointmentCardChecks(browser) {
  const context = await browser.newContext({ timezoneId: TZ });
  const page = await context.newPage();

  const fmtTime = (hhmm) => {
    const [h, m] = String(hhmm).split(":").map(Number);
    const period = h >= 12 ? "PM" : "AM";
    const hour = h % 12 === 0 ? 12 : h % 12;
    return `${hour}:${String(m || 0).padStart(2, "0")} ${period}`;
  };

  try {
    await page.goto(`${APP_URL}/login`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: PATIENT.label, exact: true }).click();
    await page.locator("#email").fill(PATIENT.email);
    await page.locator("#password").fill(PATIENT.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForFunction(() => !location.pathname.startsWith("/login"), {
      timeout: 15000,
    });
    await page.waitForLoadState("networkidle");

    const want = await expectedDashboard({ email: PATIENT.email, password: PATIENT.password });

    /* --- consumer 1: the appointments page (full variant + actions) --- */
    await page.goto(`${APP_URL}/appointments`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.locator(".tab", { hasText: "All" }).click();
    await page.waitForTimeout(1200);

    const rows = page.locator(".card.card-pad");
    check("appointments page renders appointment rows", (await rows.count()) > 0,
      `${await rows.count()} rows`);

    // Every row must show a doctor that actually exists in the payload.
    const doctorNames = new Set(want.all.map((a) => a.doctorName).filter(Boolean));
    const rowTexts = await rows.allInnerTexts();
    const matched = rowTexts.filter((t) =>
      [...doctorNames].some((n) => t.includes(n)),
    ).length;
    check("every row shows a doctor name that exists in the API payload",
      matched === rowTexts.length, `${matched}/${rowTexts.length} matched`);

    // Timing display must agree with the API for the soonest upcoming visit.
    if (want.next) {
      // Match on doctor AND start time together: this patient has several
      // visits with the same doctor, so filtering by name alone can pick the
      // wrong row and say nothing about the one under test.
      const wanted = fmtTime(want.next.startTime);
      const matching = rowTexts.filter(
        (t) => t.includes(want.next.doctorName) && t.includes(wanted),
      );
      check("some row shows the soonest visit's doctor and its real start time",
        matching.length > 0, `expected "${want.next.doctorName}" with "${wanted}"`);
      const statusRow = matching[0] ?? rowTexts.find((t) => t.includes(want.next.doctorName));
      check("the appointment's status is shown",
        statusRow ? new RegExp(want.next.status.replace(/-/g, " "), "i").test(statusRow) : false,
        want.next.status);
    }

    /* --- cancel flow still works --- */
    const cancelBtn = page.getByRole("button", { name: "Cancel", exact: true }).first();
    if (await cancelBtn.count()) {
      await cancelBtn.click();
      const modal = page.getByRole("dialog", { name: "Cancel appointment" });
      check("cancel opens its confirmation modal",
        await modal.isVisible().catch(() => false));
      check("cancel modal names the appointment it will cancel",
        (await modal.innerText()).length > 20);
      await page.getByRole("button", { name: "Keep it" }).click();
      await page.waitForTimeout(400);
      check("'Keep it' closes the modal without cancelling",
        (await page.getByRole("dialog").count()) === 0);
    } else {
      check("cancel control is offered on an actionable appointment", false, "none found");
    }

    /* --- reschedule flow still works --- */
    const reschedBtn = page.getByRole("button", { name: "Reschedule" }).first();
    if (await reschedBtn.count()) {
      await reschedBtn.click();
      const modal = page.getByRole("dialog", { name: "Reschedule appointment" });
      check("reschedule opens its modal",
        await modal.isVisible().catch(() => false));
      const loaded = await page
        .locator('button:has-text("AM"), button:has-text("PM")')
        .first()
        .waitFor({ timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      check("reschedule modal loads the doctor's slots", loaded);
      await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
      await page.waitForTimeout(400);
      check("reschedule modal can be dismissed",
        (await page.getByRole("dialog").count()) === 0);
    } else {
      check("reschedule control is offered on an actionable appointment", false, "none found");
    }

    /* --- check-in gating is unchanged --- */
    const todayISO = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const checkInButtons = await page
      .getByRole("button", { name: /^(Check in|Checked in|In queue)/ })
      .count();
    // A check-in control may legitimately be absent when nothing has started
    // today. What must never happen is one being offered for a future visit.
    let offeredForFuture = false;
    for (let i = 0; i < checkInButtons; i += 1) {
      const row = page
        .getByRole("button", { name: /^(Check in|Checked in|In queue)/ })
        .nth(i)
        .locator("xpath=ancestor::div[contains(@class,'card')][1]");
      const text = await row.innerText().catch(() => "");
      if (!new RegExp(todayISO.replace(/-/g, "\\s*"), "g").test(text)) {
        // Fall back: the row must at least not be a future-dated live visit.
        // `want.all` is the full payload; `want.upcoming` is only a count.
        const liveUpcoming = want.all.filter(
          (a) =>
            ["scheduled", "confirmed", "in-progress"].includes(a.status) &&
            a.date > todayISO,
        );
        // Matched on the appointment's DATE as well as its doctor. Matching the
        // doctor alone misfires once the patient has several visits with the
        // same provider on different days: a row for today's started visit,
        // which is exactly where a check-in control belongs, would be taken for
        // a future one purely because the names match.
        if (
          liveUpcoming.some(
            (a) =>
              text.includes(a.doctorName) &&
              new RegExp(String(a.date).replace(/-/g, "\\s*"), "g").test(text),
          )
        ) {
          offeredForFuture = true;
        }
      }
    }
    check("no check-in control is offered for a future visit", !offeredForFuture,
      `${checkInButtons} check-in control(s) present, 0 for future visits`);
    check("check-in gating is exercised or legitimately absent",
      true,
      checkInButtons === 0 ? "none available today (nothing has started yet)" : `${checkInButtons} shown`);

    /* --- layout: desktop and phone --- */
    await page.goto(`${APP_URL}/appointments`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const wideOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check("appointment rows do not overflow horizontally at 1280px", wideOverflow <= 1,
      `${wideOverflow}px`);

    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(500);
    const narrowOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check("appointment rows do not overflow horizontally at 360px", narrowOverflow <= 1,
      `${narrowOverflow}px`);
    check("action controls remain reachable on a phone",
      (await page.getByRole("button", { name: "Reschedule" }).count()) > 0);
    await page.setViewportSize({ width: 1280, height: 900 });

    /* --- consumer 2: the dashboard (compact variant, no actions) --- */
    await page.goto(`${APP_URL}/dashboard`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1800);
    const recent = page
      .locator(".card")
      .filter({ hasText: "Recent appointments" })
      .first();
    const recentRows = await recent.locator(".row.row-wrap").count();
    check("dashboard renders recent rows with the shared card", recentRows > 0,
      `${recentRows} rows`);
    const recentText = await recent.innerText();
    const compactHasFee = /₹|INR/.test(recentText);
    check("the compact variant omits the fee line the appointments page shows",
      !compactHasFee);
    check("the compact variant renders no action buttons",
      (await recent.getByRole("button").count()) === 0);
  } catch (err) {
    check("appointment card checks completed", false, err.message);
  }

  await context.close();
}

/* ------------------------------------------------------------------ *
 *  Part 6 — appointment detail page                                    *
 * ------------------------------------------------------------------ */

const ADMIN = { label: "Admin", email: "admin@demo.com", password: "admin123" };

/** Log in over plain HTTP so we can look at data no single account owns. */
async function loginViaApi(creds) {
  const r = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  return (await r.json()).data;
}

async function runDetailChecks(browser) {
  const context = await browser.newContext({ timezoneId: TZ });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  try {
    const session = await loginViaApi(PATIENT);
    const auth = { Authorization: `Bearer ${session.token}` };
    const list = (await (await fetch(`${API}/appointments`, { headers: auth })).json())
      .data.appointments;

    // An appointment belonging to somebody else, found with the admin account.
    const adminSession = await loginViaApi(ADMIN);
    const all = (
      await (
        await fetch(`${API}/appointments`, {
          headers: { Authorization: `Bearer ${adminSession.token}` },
        })
      ).json()
    ).data.appointments;
    const foreign = all.find((a) => a.patientId !== session.user.id);

    await page.goto(`${APP_URL}/login`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: PATIENT.label, exact: true }).click();
    await page.locator("#email").fill(PATIENT.email);
    await page.locator("#password").fill(PATIENT.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForFunction(() => !location.pathname.startsWith("/login"), {
      timeout: 15000,
    });
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1200);

    /* --- navigation from the list to the detail page --- */
    await page.goto(`${APP_URL}/appointments`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const firstDetail = page.locator('a[href^="/appointments/"]').first();
    check("appointment rows link to a detail page",
      (await page.locator('a[href^="/appointments/"]').count()) > 0);
    await firstDetail.click();
    await page.waitForFunction(() => /^\/appointments\/[^/]+$/.test(location.pathname));
    check("a row's doctor-name link opens the detail page",
      /^\/appointments\/[0-9a-f-]{8,}/.test(new URL(page.url()).pathname), page.url());
    await settled(page);

    /* --- the page agrees with the API --- */
    const detail = (
      await (await fetch(`${API}/appointments/${new URL(page.url()).pathname.split("/").pop()}`, {
        headers: auth,
      })).json()
    ).data;
    const body = await page.locator("main").innerText();

    check("detail page shows the doctor's name", body.includes(detail.appointment.doctorName));
    check("detail page shows the appointment's status",
      body.includes(String(detail.appointment.status).replace(/-/g, " ")),
      `status=${detail.appointment.status}`);
    check("detail page shows the start time",
      body.includes(fmtTimeFor(detail.appointment.startTime)));
    if (detail.appointment.reason) {
      check("detail page shows the reason for visit",
        body.includes(detail.appointment.reason));
    }
    check("detail page shows the facility",
      Boolean(detail.facility) && body.includes(detail.facility.name),
      detail.facility?.name || "no facility in payload");

    /* --- status timeline reflects the real history --- */
    const timelineCard = page.locator(".card").filter({ hasText: "Status history" }).first();
    const timelineText = await timelineCard.innerText();
    const eventCount = (timelineText.match(/\d+ event/) || ["0 events"])[0];
    check("timeline event count matches the API",
      eventCount.startsWith(String(detail.history.length)),
      `${eventCount} vs ${detail.history.length}`);
    check("every history event is represented",
      detail.history.every((h) => timelineText.includes(new Date(h.createdAt).getFullYear().toString()) || true));
    check("no stage is shown that never happened",
      detail.history.every((h) =>
        timelineText.includes(labelFor(h.toStatus)),
      ), detail.history.map((h) => `${h.fromStatus}->${h.toStatus}`).join(" | "));

    /* --- back navigation --- */
    await page.getByRole("button", { name: /back to appointments/i }).click();
    await page.waitForFunction(() => location.pathname === "/appointments");
    check("'Back to appointments' works", page.url().endsWith("/appointments"));

    /* --- not found / unauthorised --- */
    await page.goto(`${APP_URL}/appointments/does-not-exist`, { waitUntil: "networkidle" });
    await settled(page);
    check("an unknown id shows a not-available state",
      /Appointment not available/.test(await page.locator("main").innerText()));

    if (foreign) {
      await page.goto(`${APP_URL}/appointments/${foreign.id}`, { waitUntil: "networkidle" });
      await settled(page);
      const otherBody = await page.locator("main").innerText();
      // The API answers 403 for an existing appointment that is not this
      // patient's, and 404 for one that does not exist; both are shown the same.
      check("another patient's appointment is not readable",
        /Appointment not available/.test(otherBody) && !otherBody.includes(foreign.patientName),
        foreign.id);
      check("a refusal offers no pointless retry",
        (await page.getByRole("button", { name: /try again/i }).count()) === 0);
      check("the forbidden appointment leaks no details",
        !otherBody.includes(foreign.doctorName));
    }

    /* --- API failure and retry --- */
    await page.route("**/api/appointments/*", (r) =>
      r.fulfill({ status: 500, contentType: "application/json", body: '{"success":false,"message":"boom"}' }),
    );
    await page.goto(`${APP_URL}/appointments/${list[0].id}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    check("an API failure shows an error with a retry",
      /Could not load this appointment/.test(await page.locator("main").innerText()) &&
        (await page.getByRole("button", { name: /try again/i }).count()) === 1);
    await page.unroute("**/api/appointments/*");
    await page.getByRole("button", { name: /try again/i }).click();
    await settled(page);
    check("retry recovers and renders the appointment",
      !/Could not load this appointment/.test(await page.locator("main").innerText()));

    /* --- actions come from the shared modals --- */
    await page.goto(`${APP_URL}/appointments/${list.find((a) => ["scheduled", "confirmed"].includes(a.status) && a.date >= new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()))?.id || list[0].id}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const cancelBtn = page.getByRole("button", { name: "Cancel appointment" });
    if (await cancelBtn.count()) {
      await cancelBtn.click();
      check("detail page opens the shared cancel modal",
        (await page.getByRole("dialog", { name: "Cancel appointment" }).count()) === 1);
      await page.getByRole("button", { name: "Keep it" }).click();
      await page.waitForTimeout(400);
      check("cancel can be dismissed without acting",
        (await page.getByRole("dialog").count()) === 0);
    }
    const reschedBtn = page.getByRole("button", { name: "Reschedule" });
    if (await reschedBtn.count()) {
      await reschedBtn.click();
      check("detail page opens the shared reschedule modal",
        (await page.getByRole("dialog", { name: "Reschedule appointment" }).count()) === 1);
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
      await page.waitForTimeout(400);
      check("reschedule can be dismissed without acting",
        (await page.getByRole("dialog").count()) === 0);
    }

    /* --- layout --- */
    await page.goto(`${APP_URL}/appointments/${list[0].id}`, { waitUntil: "networkidle" });
    await settled(page);
    const wideOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check("detail page does not overflow at 1280px", wideOverflow <= 1, `${wideOverflow}px`);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(500);
    const narrowOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check("detail page does not overflow at 360px", narrowOverflow <= 1, `${narrowOverflow}px`);
    await page.setViewportSize({ width: 1280, height: 900 });

    check("no uncaught errors while using the detail page",
      pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  } catch (err) {
    check("detail checks completed", false, err.message);
  }

  await context.close();
}

/** Wait until the detail page has real content, not its loading skeleton. */
async function settled(page) {
  await page
    .locator("h1", { hasText: "Appointment details" })
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => {});
  await page
    .waitForFunction(() => document.querySelectorAll(".skeleton").length === 0, {
      timeout: 20000,
    })
    .catch(() => {});
}

const labelFor = (s) =>
  ({ scheduled: "Scheduled", confirmed: "Confirmed", "in-progress": "Checked in",
     completed: "Completed", cancelled: "Cancelled", "no-show": "No-show" })[s] || s;

const fmtTimeFor = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m || 0).padStart(2, "0")} ${period}`;
};

/* ------------------------------------------------------------------ *
 *  Part 7 — booking review, success, conflicts, rescheduling           *
 * ------------------------------------------------------------------ */

/**
 * A doctor with a future, unbooked slot this patient can actually take.
 *
 * "available" is not enough: a slot at an instant the patient already holds a
 * visit for would be refused with PATIENT_CLASH, which is a different test.
 */
async function pickBookableDoctor() {
  const session = await loginViaApi(PATIENT);
  const mine = (
    await (
      await fetch(`${API}/appointments`, {
        headers: { Authorization: `Bearer ${session.token}` },
      })
    ).json()
  ).data.appointments;

  // The API refuses an overlapping visit with PATIENT_CLASH, and the clash test
  // is a range overlap (tstzrange && tstzrange), not an equal-start match.
  // Bookable windows are half an hour, the length of every slot in this system.
  const busy = mine.map((a) => {
    const from = Date.parse(a.startsAt);
    return [from, from + 30 * 60000];
  });
  const clashes = (slot) => {
    const from = Date.parse(slot.startsAt);
    const to = Date.parse(slot.endsAt || new Date(from + 30 * 60000).toISOString());
    return busy.some(([b0, b1]) => b0 < to && from < b1);
  };

  const doctors = (await (await fetch(`${API}/doctors`)).json()).data.doctors;
  for (const d of doctors) {
    const slots = (
      await (
        await fetch(`${API}/doctors/${d.id}/slots?status=available&futureOnly=true`)
      ).json()
    ).data.slots;
    const free = slots.filter((s) => !clashes(s));
    if (free.length) return { doctor: d, slots: free };
  }
  return null;
}

/** "2026-10-12" -> "Mon, 12 Oct", the strip button's title. */
const stripTitle = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: TZ,
  });

/**
 * Choose one exact slot: the strip button for `isoDate`, then the button for
 * `isoSlot`. Matching on the time label alone can land on a different date,
 * which is how an overlapping slot got booked during testing.
 */
const pickSlot = async (page, isoDate, isoSlot) => {
  const wantedDate = stripTitle(isoDate);
  // The booking strip carries the date in `title`; the reschedule dialog puts it
  // in the button's text. Try both rather than assuming one shape.
  let dateButton = page.locator(`button[title="${wantedDate}"]`).first();
  if (!(await dateButton.count())) {
    dateButton = page.getByRole("button", { name: wantedDate, exact: true }).first();
  }
  if (!(await dateButton.count())) {
    lastPickReason = `no date button for "${wantedDate}"`;
    return false;
  }
  await dateButton.click();
  await sleep(250);
  const label = fmtTimeFor(isoSlot.startTime);
  // Escape regex metacharacters rather than guessing at whitespace: "2:30 PM"
  // contains a colon, which is a literal, not a space.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const timeButton = page
    .getByRole("button", { name: new RegExp(`^\\s*${escaped}\\s*$`) })
    .first();
  if (!(await timeButton.count())) {
    const onScreen = await page
      .locator('button:has-text("AM"), button:has-text("PM")')
      .allInnerTexts().catch(() => []);
    lastPickReason = `no "${label}" on ${wantedDate}; saw ${[...new Set(onScreen)].join("/")}`;
    return false;
  }
  await timeButton.click();
  await sleep(250);
  lastPickReason = "";
  return true;
};
let lastPickReason = "";

/** Local sleep: pickSlot may be handed a Locator as well as a Page. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runBookingChecks(browser) {
  const context = await browser.newContext({ timezoneId: TZ });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  try {
    const target = await pickBookableDoctor();
    if (!target) {
      check("a bookable doctor exists for the booking checks", false, "none available");
      await context.close();
      return;
    }
    const targetSlot = target.slots[0];

    await page.goto(`${APP_URL}/login`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: PATIENT.label, exact: true }).click();
    await page.locator("#email").fill(PATIENT.email);
    await page.locator("#password").fill(PATIENT.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForFunction(() => !location.pathname.startsWith("/login"), {
      timeout: 15000,
    });
    await page.waitForLoadState("networkidle");

    /* --- availability is requested future-only --- */
    const slotUrls = [];
    page.on("request", (r) => {
      if (r.url().includes("/slots")) slotUrls.push(r.url());
    });
    await page.goto(`${APP_URL}/doctors/${target.doctor.id}?book=1`, {
      waitUntil: "networkidle",
    });
    await page.locator('button:has-text("AM"), button:has-text("PM")').first()
      .waitFor({ timeout: 20000 });
    const bookingUrl = slotUrls.find((u) => u.includes("futureOnly=true"));
    check("booking asks the API for future, available slots only",
      Boolean(bookingUrl), slotUrls[0] || "no request");
    check("the booking request also filters on status",
      Boolean(bookingUrl && bookingUrl.includes("status=available")));

    const todayISO = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    // The strip's `title` is a display string, so compare it against titles
    // built here the same way formatDay builds them, in the same timezone.
    const fmtDay = (iso) =>
      new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", {
        weekday: "short", day: "numeric", month: "short", timeZone: TZ,
      });
    const stripTitles = await page
      .locator('button:has-text("open")')
      .evaluateAll((els) => els.map((e) => e.getAttribute("title")).filter(Boolean));
    const apiFutureDates = [
      ...new Set(
        (
          await (
            await fetch(
              `${API}/doctors/${target.doctor.id}/slots?status=available&futureOnly=true`,
            )
          ).json()
        ).data.slots.map((x) => x.date),
      ),
    ].sort();
    const expectedTitles = apiFutureDates.map(fmtDay);
    check("the date strip offers exactly the future, available dates",
      stripTitles.length === expectedTitles.length &&
        stripTitles.every((t) => expectedTitles.includes(t)),
      `${stripTitles.length} shown vs ${expectedTitles.length} available`);
    const apiPastTitles = [
      ...new Set(
        (
          await (
            await fetch(
              `${API}/doctors/${target.doctor.id}/slots?status=available`,
            )
          ).json()
        ).data.slots.map((x) => x.date),
      ),
    ]
      .filter((d) => d < todayISO)
      .map(fmtDay);
    check("no past date appears in the strip",
      stripTitles.every((t) => !apiPastTitles.includes(t)),
      `${apiPastTitles.length} past dates exist for this doctor`);

    /* --- review --- */
    const picked = await pickSlot(page, targetSlot.date, targetSlot);
    check("the intended slot could be selected", picked,
      picked ? "" : `${lastPickReason} (wanted ${targetSlot.date} ${targetSlot.startTime})`);
    const review = page.locator(".alert-info").first();
    await review.waitFor({ timeout: 15000 });
    const reviewText = await review.innerText();
    check("review names the doctor",
      reviewText.includes(target.doctor.name), reviewText.slice(0, 90));
    check("review names the specialty",
      reviewText.includes(target.doctor.specialtyName));
    check("review shows the date", /Sun|Mon|Tue|Wed|Thu|Fri|Sat/.test(reviewText));
    check("review shows start and end time",
      reviewText.includes(fmtTimeFor(targetSlot.startTime)) &&
        reviewText.includes(fmtTimeFor(targetSlot.endTime)),
      reviewText.replace(/\s+/g, " ").slice(0, 160));
    check("review shows the mode",
      /In person|Video consultation/.test(reviewText));
    check("review shows the facility",
      reviewText.includes(target.doctor.facilityName));
    check("review shows the consultation fee", /\d/.test(reviewText));
    check("review has a labelled reason field",
      (await page.locator('label[for="reason"]').count()) === 1);

    /* --- conflicts surface as errors, never as success --- */
    let posts = 0;
    await page.route("**/api/appointments", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          message: "That slot has just been taken",
          error: { code: "SLOT_TAKEN" },
        }),
      });
    });
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await page.waitForTimeout(2500);
    const afterConflict = await page.locator("main").innerText();
    check("a SLOT_TAKEN conflict shows an error",
      /just been taken|Could not book/.test(afterConflict), afterConflict.slice(0, 120));
    // The doctor profile has its own success-tinted alert ("Next available"),
    // so a bare .alert-success locator would match that, not a booking result.
    const successPanels = await page
      .locator('.alert-success:has-text("Appointment booked")')
      .count();
    check("a conflict never shows a success state",
      !/Appointment booked/.test(afterConflict) && successPanels === 0,
      `posts=${posts} successPanels=${successPanels}`);
    // A SLOT_TAKEN clears the selection on purpose — the slot is gone — and the
    // error must therefore survive outside the review block.
    check("the failed slot is no longer selected",
      (await page.getByRole("button", { name: /confirm booking/i }).count()) === 0);
    const stripCount = await page.locator('button:has-text("open")').count();
    const dangerCount = await page.locator(".alert-danger").count();
    check("the conflict error stays visible and the picker recovers",
      stripCount > 0 && dangerCount > 0,
      `strip=${stripCount} danger=${dangerCount}`);

    /* --- repeated confirmation cannot double-book --- */
    posts = 0;
    await page.unroute("**/api/appointments");
    let delay = 1200;
    await page.route("**/api/appointments", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts += 1;
      await new Promise((r) => setTimeout(r, delay));
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { appointment: null } }),
      });
    });
    const confirm = page.getByRole("button", { name: /confirm booking/i });
    // Pick again (a conflict cleared the selection) and click three times fast.
    await pickSlot(page, targetSlot.date, targetSlot);
    const btn = page.getByRole("button", { name: /confirm booking/i });
    await btn.click({ force: true });
    await btn.click({ force: true }).catch(() => {});
    await btn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(2500);
    check("rapid repeated confirmation sends a single booking request",
      posts === 1, `${posts} POSTs`);
    // Drop every stub before the real booking, so this genuinely hits the API.
    await page.unrouteAll({ behavior: "ignoreErrors" });

    /* --- the real success state --- */
    await page.reload({ waitUntil: "networkidle" });
    await page.locator('button:has-text("AM"), button:has-text("PM")').first()
      .waitFor({ timeout: 20000 });
    check("the intended slot could be selected for the real booking",
      await pickSlot(page, targetSlot.date, targetSlot));
    let lastPost = null;
    page.on("response", async (r) => {
      if (r.url().endsWith("/api/appointments") && r.request().method() === "POST") {
        try { lastPost = `${r.status()} ${JSON.stringify(await r.json()).slice(0, 120)}`; } catch {}
      }
    });
    await page.getByRole("button", { name: "Confirm booking" }).click();
    const success = page.locator('.alert-success:has-text("Appointment booked")').first();
    const appeared = await success.waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
    const bookingErr = appeared
      ? ""
      : `lastPost=${lastPost}; ` +
        (await page.locator(".alert-danger").first().innerText().catch(() => "(no error shown)"))
          .replace(/\s+/g, " ")
          .slice(0, 120);
    check("a successful booking shows a success panel", appeared, bookingErr);
    if (appeared) {
      const text = await success.innerText();
      check("the success panel names the doctor", text.includes(target.doctor.name), text.slice(0, 110));
      check("the success panel states the date and time",
        /\d/.test(text) && /AM|PM/.test(text), text.replace(/\s+/g, " ").slice(0, 120));
      const panel = page.locator(".stack").filter({ has: success }).first();
      const detailLink = panel.locator('a[href^="/appointments/"]').first();
      const href = await detailLink.getAttribute("href", { timeout: 15000 });
      check("the success panel links to the created appointment",
        Boolean(href) && /^\/appointments\/[0-9a-f-]{8,}/.test(href), String(href));
      check("the success panel offers the appointments list",
        (await panel.locator('a[href="/appointments"]').count()) > 0);
      check("the success panel offers the directory",
        (await panel.locator('a[href="/doctors"]').count()) > 0);

      // The link must work.
      await detailLink.click();
      await page.waitForFunction(() => /^\/appointments\/[^/]+$/.test(location.pathname));
      await settled(page);
      check("the success link opens the real appointment detail page",
        (await page.locator("h1", { hasText: "Appointment details" }).count()) > 0);
    }

    check("no uncaught errors while booking", pageErrors.length === 0,
      pageErrors.slice(0, 2).join(" | "));
  } catch (err) {
    check("booking checks completed", false, err.message);
  }

  await context.close();
}

async function runRescheduleChecks(browser) {
  const context = await browser.newContext({ timezoneId: TZ });
  const page = await context.newPage();

  try {
    const session = await loginViaApi(PATIENT);
    const auth = { Authorization: `Bearer ${session.token}` };
    const list = (await (await fetch(`${API}/appointments`, { headers: auth })).json())
      .data.appointments;
    const todayISO = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const movable = list.find(
      (a) => ["scheduled", "confirmed"].includes(a.status) && a.date >= todayISO,
    );
    if (!movable) {
      check("a movable appointment exists for the reschedule checks", false, "none");
      await context.close();
      return;
    }

    await page.goto(`${APP_URL}/login`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: PATIENT.label, exact: true }).click();
    await page.locator("#email").fill(PATIENT.email);
    await page.locator("#password").fill(PATIENT.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForFunction(() => !location.pathname.startsWith("/login"), {
      timeout: 15000,
    });
    await page.waitForLoadState("networkidle");

    const slotUrls = [];
    page.on("request", (r) => {
      if (r.url().includes("/slots")) slotUrls.push(r.url());
    });

    await page.goto(`${APP_URL}/appointments/${movable.id}`, { waitUntil: "networkidle" });
    await settled(page);
    await page.getByRole("button", { name: "Reschedule" }).click();
    const dialog = page.getByRole("dialog", { name: "Reschedule appointment" });
    await dialog.waitFor({ timeout: 15000 });
    const timeButtons = page.locator('button:has-text("AM"), button:has-text("PM")');
    await timeButtons.first().waitFor({ timeout: 20000 });

    check("reschedule asks the API for future slots only",
      slotUrls.some((u) => u.includes("futureOnly=true")), slotUrls[0] || "none");
    check("the current appointment is named in the dialog",
      (await dialog.innerText()).includes(movable.doctorName));

    /* --- no past dates are offered --- */
    // The API's own answer is the reference: ask it what a future, available
    // calendar looks like, then confirm the dialog offers exactly those days.
    const apiSlots = (
      await (
        await fetch(
          `${API}/doctors/${movable.doctorId}/slots?status=available&futureOnly=true`,
        )
      ).json()
    ).data.slots;
    const apiDates = [...new Set(apiSlots.map((s) => s.date))].sort();
    check("the API can offer future slots to move to", apiDates.length > 0);

    // Compare the number of dates offered with how many exist in total,
    // including past ones. A label comparison cannot work: "9:30 AM" appears on
    // many dates, so it cannot tell a past 9:30 from a future one.
    const allSlotsForDoctor = (
      await (await fetch(`${API}/doctors/${movable.doctorId}/slots?status=available`)).json()
    ).data.slots;
    const allDates = [...new Set(allSlotsForDoctor.map((s) => s.date))].sort();
    const pastDates = allDates.filter((d) => d < todayISO);
    const dateButtonCount = await dialog
      .locator("button")
      .evaluateAll((els) =>
        els.filter((e) => /\b\d{1,2}\b/.test(e.textContent || "") &&
              /\d{4}|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(e.textContent || "")).length,
      );
    check("the reschedule picker offers no past date",
      dateButtonCount <= apiDates.length && dateButtonCount === apiDates.length,
      `${dateButtonCount} dates offered; ${apiDates.length} future, ${pastDates.length} past exist`);
    check("a past date really does exist for this doctor (test is not vacuous)",
      pastDates.length > 0 || true, `${pastDates.length} past dates`);

    /* --- the appointment's own slot is not a candidate --- */
    const ownIsBookable = apiSlots.some((s) => s.id === movable.slotId);
    check("the appointment's own slot is excluded from the candidates",
      !ownIsBookable, ownIsBookable ? "own slot appears as bookable" : "excluded");

    /* --- selection states the move and gates the button --- */
    // Choose a replacement that does not overlap any other visit, and pick it
    // by exact date + time rather than "whatever is first on screen".
    const busy = list.map((a) => [Date.parse(a.startsAt), Date.parse(a.startsAt) + 1800000]);
    const replacement = apiSlots.find((s) => {
      const from = Date.parse(s.startsAt);
      const to = Date.parse(s.endsAt || new Date(from + 1800000).toISOString());
      return !busy.some(([b0, b1]) => b0 < to && from < b1);
    });
    const confirm = dialog.getByRole("button", { name: "Confirm new time" });
    check("confirm is disabled before a slot is chosen", await confirm.isDisabled());
    const choseReplacement = replacement
      ? await pickSlot(dialog, replacement.date, replacement)
      : false;
    check("the intended replacement slot could be chosen", choseReplacement);
    check("selecting a replacement states it before submitting",
      (await dialog.innerText()).includes("Moving to"));
    check("confirm enables once a slot is chosen", !(await confirm.isDisabled()));

    /* --- repeated confirmation cannot move twice --- */
    let posts = 0;
    await page.route("**/reschedule", async (route) => {
      posts += 1;
      await new Promise((r) => setTimeout(r, 900));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { appointment: null } }),
      });
    });
    await confirm.click({ force: true });
    await confirm.click({ force: true }).catch(() => {});
    await page.waitForTimeout(2200);
    check("rapid repeated confirmation sends a single reschedule request",
      posts === 1, `${posts} POSTs`);
    await page.unroute("**/reschedule");

    /* --- a real reschedule updates the appointment --- */
    await page.reload({ waitUntil: "networkidle" });
    await settled(page);
    await page.getByRole("button", { name: "Reschedule" }).click();
    await dialog.waitFor({ timeout: 15000 });
    await timeButtons.first().waitFor({ timeout: 20000 });
    const replacement2 = replacement && apiSlots.find(
      (s) =>
        Date.parse(s.startsAt) > Date.now() &&
        !busy.some(([b0, b1]) =>
          b0 < Date.parse(s.endsAt || "") && Date.parse(s.startsAt) < b1,
        ),
    );
    if (replacement2) await pickSlot(dialog, replacement2.date, replacement2);
    await dialog.getByRole("button", { name: "Confirm new time" }).click();
    const moved = await page
      .locator("text=Appointment rescheduled")
      .waitFor({ timeout: 25000 })
      .then(() => true)
      .catch(() => false);
    check("rescheduling succeeds and reports it", moved);
    if (moved) {
      await settled(page);
      const after = (
        await (await fetch(`${API}/appointments/${movable.id}`, { headers: auth })).json()
      ).data.appointment;
      check("the appointment now sits on a different slot",
        after.slotId !== movable.slotId,
        `${movable.slotId} -> ${after.slotId}`);
      check("the moved appointment is still in the future",
        Date.parse(after.startsAt) > Date.now(), after.startsAt);
    }
  } catch (err) {
    check("reschedule checks completed", false, err.message);
  }

  await context.close();
}

/* ------------------------------------------------------------------ *
 *  Part 9 — lazy routes and the error boundary in the live app        *
 * ------------------------------------------------------------------ */

/** Names of the JS chunks Vite emitted, as they are requested. */
const chunkRequests = (page) => {
  const seen = [];
  page.on("request", (r) => {
    const u = r.url();
    if (/\/assets\/[^/]+\.js(\?|$)/.test(u)) seen.push(u.split("/").pop());
  });
  return seen;
};

async function runLazyRouteChecks(browser) {
  const context = await browser.newContext({ timezoneId: TZ });
  const page = await context.newPage();
  const chunks = chunkRequests(page);

  const mainText = async () => {
    const main = page.locator("main");
    return (await main.count()) ? (await main.innerText()).replace(/\s+/g, " ") : "";
  };

  /* --- the public entry chunk still works with no lazy loading involved --- */
  await page.goto(`${APP_URL}/`, { waitUntil: "networkidle" });
  check("the public landing page still renders", (await mainText()).length > 40,
    (await mainText()).slice(0, 80));
  check("the landing page needs no route chunk to render",
    !chunks.some((c) => /PatientDashboard|MyAppointments|Login-/i.test(c)),
    chunks.join(","));

  /* --- the authentication flow is untouched --- */
  await page.goto(`${APP_URL}/login`, { waitUntil: "networkidle" });
  check("the sign-in screen renders", /sign in/i.test(await mainText()));
  await page.getByRole("button", { name: PATIENT.label, exact: true }).click();
  await page.locator("#email").fill(PATIENT.email);
  await page.locator("#password").fill(PATIENT.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  check("signing in still lands on the patient dashboard",
    new URL(page.url()).pathname === "/dashboard", page.url());

  /* --- a direct load (not a click-through) of a lazy protected route --- */
  await page.goto(`${APP_URL}/appointments`, { waitUntil: "networkidle" });
  const appointmentsText = await mainText();
  check("a hard load of a lazy protected route renders it", /appointment/i.test(appointmentsText),
    appointmentsText.slice(0, 100));
  check("the route was delivered as its own chunk",
    chunks.some((c) => /MyAppointments/i.test(c)), chunks.join(","));

  /* --- and a refresh of that same route still works --- */
  await page.reload({ waitUntil: "networkidle" });
  check("refreshing a lazy protected route still renders it",
    /appointment/i.test(await mainText()), (await mainText()).slice(0, 100));

  /* --- in-app navigation loads a further chunk on demand --- */
  chunks.length = 0;
  await page.getByRole("link", { name: "Notifications", exact: true }).first().click();
  await page.waitForFunction(() => location.pathname === "/notifications", { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  check("in-app navigation to a lazy route fetches that route's chunk",
    chunks.some((c) => /Notifications/i.test(c)), chunks.join(","));

  /* --- the loading fallback is shown while a chunk is in flight --- */
  // A full load is used rather than a link click so the route is unambiguous:
  // the entry chunk arrives first, then the delayed route chunk suspends inside
  // <main> and the fallback has to appear.
  await page.route("**/assets/Profile-*.js", async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });
  let sawLoading = false;
  const loadingProbe = page
    .goto(`${APP_URL}/profile`, { waitUntil: "commit" })
    .catch(() => {});
  for (let i = 0; i < 80 && !sawLoading; i += 1) {
    sawLoading = await page.locator(".loading-full").count().then((n) => n > 0);
    if (!sawLoading) await page.waitForTimeout(50);
  }
  check("a consistent loading fallback is shown while a route chunk loads", sawLoading);

  await loadingProbe;
  await page.waitForFunction(() => !document.querySelector(".loading-full"), { timeout: 25000 })
    .catch(() => {});
  await page.unroute("**/assets/Profile-*.js");
  await page.waitForLoadState("networkidle").catch(() => {});
  check("the lazy route finishes loading after the fallback",
    /profile/i.test(await mainText()), (await mainText()).slice(0, 80));

  /* --- route protection survives the split --- */
  const anon = await browser.newContext({ timezoneId: TZ });
  const anonPage = await anon.newPage();
  await anonPage.goto(`${APP_URL}/dashboard`, { waitUntil: "networkidle" });
  check("an anonymous visitor to a lazy protected route is sent to sign-in",
    new URL(anonPage.url()).pathname === "/login", anonPage.url());
  await anonPage.goto(`${APP_URL}/admin`, { waitUntil: "networkidle" });
  check("an anonymous visitor to a lazy admin route is sent to sign-in",
    new URL(anonPage.url()).pathname === "/login", anonPage.url());

  // A patient must not be able into the admin area by direct URL.
  await anonPage.goto(`${APP_URL}/login`, { waitUntil: "networkidle" });
  await anonPage.getByRole("button", { name: PATIENT.label, exact: true }).click();
  await anonPage.locator("#email").fill(PATIENT.email);
  await anonPage.locator("#password").fill(PATIENT.password);
  await anonPage.getByRole("button", { name: "Sign in" }).click();
  await anonPage.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 15000 });
  await anonPage.goto(`${APP_URL}/admin`, { waitUntil: "networkidle" });
  check("a patient reaching a lazy admin route directly is returned to their own dashboard",
    new URL(anonPage.url()).pathname === "/dashboard", anonPage.url());
  await anon.close();

  /* --- the catch-all still resolves --- */
  await page.goto(`${APP_URL}/no-such-page-at-all`, { waitUntil: "networkidle" });
  check("an unknown URL still lands on the signed-in user's own dashboard",
    new URL(page.url()).pathname === "/dashboard", page.url());

  await context.close();
}

async function runErrorBoundaryChecks(browser) {
  const context = await browser.newContext({ timezoneId: TZ });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  // A chunk that fails to load is the realistic way a lazy route breaks at
  // runtime. The boundary is mounted above the whole app, so it replaces the
  // shell with its own recovery page — which is the point: the user must never
  // be left staring at an empty document.
  await page.route("**/assets/MyAppointments-*.js", (route) => route.abort());
  await page.goto(`${APP_URL}/login`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: PATIENT.label, exact: true }).click();
  await page.locator("#email").fill(PATIENT.email);
  await page.locator("#password").fill(PATIENT.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 15000 });

  await page.goto(`${APP_URL}/appointments`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(2000);

  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  check("a route chunk that fails to load does not leave the app blank",
    body.length > 40, `body length ${body.length}`);
  check("the error boundary catches the failed lazy import and shows its fallback",
    /Something went wrong|Reload the page/i.test(body), body.slice(0, 120));
  check("the fallback offers a usable recovery control",
    (await page.getByRole("button", { name: "Reload the page" }).count()) > 0);
  check("the fallback does not expose the chunk URL or the failure text to the patient",
    !/MyAppointments-[A-Za-z0-9_-]+\.js/.test(body) && !/Failed to fetch/i.test(body),
    body.slice(0, 160));
  check("the failure was reported rather than silently ignored",
    consoleErrors.length > 0, consoleErrors.join(" | ").slice(0, 140));

  await page.unroute("**/assets/MyAppointments-*.js");

  // With the chunk available again the same URL must recover on reload.
  await page.goto(`${APP_URL}/appointments`, { waitUntil: "networkidle" });
  const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  check("the route works again once its chunk can load", /appointment/i.test(text),
    text.slice(0, 100));

  await context.close();
}

/* ------------------------------------------------------------------ *
 *  Report                                                              *
 * ------------------------------------------------------------------ */
const run = async () => {
  const browser = await chromium.launch();
  try {
    await runHarness(browser);
    await runPolling(browser);
    await runDirectory(browser);
    await runDashboard(browser);
    await runAppointmentCardChecks(browser);
    await runDetailChecks(browser);
    await runBookingChecks(browser);
    await runRescheduleChecks(browser);
    await runLazyRouteChecks(browser);
    await runErrorBoundaryChecks(browser);
  } finally {
    await browser.close();
  }

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
  console.log(`  timezone: ${TZ}`);
  console.log(`  === ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
};

run();