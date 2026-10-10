# MediCare — Feature Matrix

`FEATURE | CURRENT STATUS | REUSABLE? | V2 CHANGE | PRIORITY`

**Status legend**

| Mark | Meaning |
| --- | --- |
| ✅ Works | Exercised during the audit; no defect found |
| ⚠️ Partial | Works, with a reproduced defect |
| ❌ Broken | Reproduced failure |
| 🚧 Stubbed | UI exists, underlying logic does not |
| ➖ Absent | Does not exist in the codebase |

**Priority legend:** P0 blocks the migration · P1 core v2 value · P2 polish · P3 optional.

Only features actually present in the code, or clearly required by it, are listed. Absent
features are marked ➖ so the matrix is explicit about gaps.

---

## 1. Authentication & identity

| Feature | Current status | Reusable? | V2 change | Priority |
| --- | --- | --- | --- | --- |
| Patient registration | ⚠️ Works, but `role:"provider"` escalates to doctor (S-05) | Logic yes | Server assigns role; patient-only; Zod validation | **P0** |
| Login | ⚠️ Works; passwords are `` `hashed:${plain}` `` (S-02) | Logic yes | bcrypt verify; short access + rotating refresh token | **P0** |
| Password hashing | ❌ `bcryptjs` present, `bcrypt.hash` called **zero** times | No | Implement; migrate `hashed:` on first login; add a DB `CHECK` | **P0** |
| `GET /api/auth/me` | ⚠️ Works; leaks `doctor.user.password` (S-04) | Logic yes | Project through a whitelist | **P0** |
| `PATCH /api/auth/me` | ⚠️ Works; unvalidated `profile` merge (S-08) | Logic yes | Strict schema, unknown keys rejected | **P0** |
| Logout | ⚠️ Client-only; no server call, no revocation | UI yes | Server revokes the refresh token | P1 |
| Token refresh | ➖ Absent | — | Add rotating refresh tokens | P1 |
| Password reset / forgot | ➖ Absent | — | New (email token) | P3 |
| Server-side session revocation | ➖ Absent (7-day JWT) | — | `token_version` + refresh-token deny-list | P1 |
| Role enforcement (RBAC) | ✅ Verified 403 on admin, provider and slot-write routes | ✅ Keep | Keep; add `requireAppointmentAccess` for ownership | **P0** |
| Uniform login error (no user enumeration) | ✅ "Invalid email or password" for both cases | ✅ Keep | Keep | — |
| Registration rate limiting | ⚠️ Present but disabled unless `NODE_ENV=production` (S-10) | ✅ Keep | Always on; shared store | **P0** |
| Demo account hints | ❌ `/api/demo-accounts` serves plaintext passwords (S-01) | No | Delete the route | **P0** |

## 2. Doctor discovery

| Feature | Current status | Reusable? | V2 change | Priority |
| --- | --- | --- | --- | --- |
| Doctor directory list | ⚠️ Works; `limit` ignored, no pagination | UI yes | SQL filtering, sorting, real pagination | P1 |
| Search by name/facility/bio | ✅ Works | ✅ Keep | Move to SQL `ILIKE`/full-text | P1 |
| Filter by specialty / city | ✅ Works; accepts comma-separated lists | ✅ Keep | Move to SQL `IN (…)` | P1 |
| Filter by max fee / min rating | ✅ Works | ✅ Keep | SQL range predicates | P1 |
| Filter by language | ✅ Works (JS array scan) | ✅ Keep | `doctor_languages` table | P1 |
| Filter by consultation mode | ✅ Works | ✅ Keep | SQL join on `slots.mode` | P1 |
| Filter: accepting new patients only | ✅ Works | ✅ Keep | Partial index | P1 |
| Sorting (fee / experience / rating / soonest) | ✅ Works | ✅ Keep | SQL `ORDER BY` | P1 |
| URL-synced filters + debounce | ✅ `DoctorDirectory.jsx` — best page in the repo | ✅ Keep | Keep as-is | — |
| Doctor profile page | ⚠️ Works; "Next appointments" sidebar is dead (D3) | UI yes | Fix or remove; **never expose `patientName` publicly** | P1 |
| Recommended doctors | ✅ Works (deterministic scoring) | ✅ Keep | SQL scoring; can later personalise from history | P2 |
| Specialty browsing | ✅ Works | ✅ Keep | Keep | — |
| Facility listing | ✅ Works; `city` / `search` filters | ✅ Keep | SQL | P2 |
| Service catalogue | ✅ Works | ✅ Keep | **Link services to slots** — today `duration`/`price` are unused by booking | P2 |
| Doctor ratings | 🚧 Synthetic seed integers; admin-writable (S-17) | No | `reviews` table + derived view | P3 |
| Public synthetic stats ("patients treated", "repeat rate") | 🚧 Arithmetic on seed data, served publicly (S-18) | No | Derive from real data or delete | P2 |

## 3. Slots & availability

| Feature | Current status | Reusable? | V2 change | Priority |
| --- | --- | --- | --- | --- |
| Doctor availability feed | ✅ Works (14 days of generated slots) | Logic yes | Generate from `doctor_availability` templates | P1 |
| Availability summary per date | ✅ Works (available/booked/blocked, utilisation) | ✅ Keep | SQL aggregate | P1 |
| Availability summary for a doctor | ✅ Works | ✅ Keep | SQL aggregate | P1 |
| "Next available slot" | ✅ Works | ✅ Keep | SQL `MIN(starts_at)` | P1 |
| Provider slot blocking / unblocking | ✅ Verified 200; 403 for a patient | ✅ Keep | Keep, add to history/audit | P1 |
| Provider bulk slot generation | ✅ Works; dedupes via read-then-write (no constraint) | ✅ Keep | Unique index makes dedupe free | P1 |
| Recurring availability templates | ➖ Absent — slots are generated per date | — | **New** `doctor_availability` + generator job | P1 |
| Slot overlap prevention | ❌ Nothing prevents a provider creating 09:00 and 09:15 overlapping slots (D-B1) | No | `EXCLUDE USING gist` | **P0** |

## 4. Appointment booking

| Feature | Current status | Reusable? | V2 change | Priority |
| --- | --- | --- | --- | --- |
| Booking flow (UI + API) | ✅ Verified 201 | ✅ Keep | Keep the flow, rebuild the service | P1 |
| Same-slot double booking | ⚠️ Blocked in-process (409 verified); **no protection across processes** | Logic yes | `FOR UPDATE` + partial unique index | **P0** |
| Concurrent booking safety | ❌ Check-then-set on a shared object; no lock, no constraint | No | Transaction + `FOR UPDATE` | **P0** |
| Patient overlapping bookings | ❌ **Reproduced — 09:00 and 09:15 both accepted** (D-B1) | No | `EXCLUDE (patient_id, period)` | **P0** |
| Booking a blocked slot | ✅ Blocked (400 `SLOT_BLOCKED`) | ✅ Keep | Keep, map from the status enum | — |
| Booking a past date | ✅ Blocked (400 `SLOT_IN_PAST`) | ✅ Keep | Keep | — |
| Invalid doctor/slot pair | ✅ Blocked (400 `SLOT_MISMATCH`) | ✅ Keep | Derive `doctor_id` from the slot, ignore the request | P1 |
| Mode mismatch (client override) | ❌ **Reproduced** — an in-person slot booked as video (D-B6) | No | Take `mode` from the slot only | **P0** |
| Reschedule | ⚠️ Works; allows past dates (D-B3), stale fee (D-B5) | Logic yes | Same transaction; re-validate and re-price | **P0** |
| Cancellation | ⚠️ Works via `/cancel`; **leaks the slot via `/status` (D-B2)** | Logic yes | One cancellation path | **P0** |
| Fee snapshot | ⚠️ Taken at booking; never refreshed on reschedule (D-B5) | ✅ Keep | Refresh inside the transaction | P1 |
| Appointment status machine | ✅ `ALLOWED_TRANSITIONS` works and is a genuine asset | ✅ Keep | Single source of truth in the service | P1 |
| Appointment status history | ➖ Absent — status is overwritten in place | — | **New** `appointment_status_history` | P1 |
| Timeline in the UI | 🚧 `MyAppointments` has no timeline, despite the README claiming one | — | Render from the history table | P2 |
| Queue position on the appointment | ⚠️ Triplicated across three stores | No | `queue_entries` | P1 |
| Appointment listing / filtering | ⚠️ Works; in-memory filters, no pagination | ✅ Keep | SQL + pagination | P1 |
| Appointment detail | ⚠️ Works; **returns the raw doctor object (S-03)** | Logic yes | Whitelisted projection | **P0** |

## 5. Check-in & queue

| Feature | Current status | Reusable? | V2 change | Priority |
| --- | --- | --- | --- | --- |
| Patient check-in | ❌ **IDOR — no ownership check (S-06)** | No | Ownership middleware | **P0** |
| Check-in on a future appointment | ❌ **Allowed for a 2031 date (D-B4)** | No | Reject unless `starts_at <= now()` | **P0** |
| Live queue endpoint | ⚠️ Works; readable for any doctor by any user (S-16) | Logic yes | Scope by role; Realtime (Phase 9) | P1 |
| Wait-time estimate | 🚧 `queue.length × 15 min` — a hardcoded constant | UI yes | Compute from actual `called_at` deltas | P2 |
| Queue capacity (`maxQueue`) | 🚧 Written on every slot, **never read** | No | Enforce via `queue_unique_position` | P1 |
| Queue position inflation | ❌ `slot.currentQueue` only ever increments (`appointmentService.js:384`), never decrements | No | Derive position; unique index | **P0** |
| Queue advance / dequeue | ➖ Absent — nothing moves an entry past `waiting` | — | **New** — provider calls next patient | P1 |
| Doctor-side queue view | ➖ Absent — no UI shows the queue | — | **New** with Realtime | P1 |
| Realtime queue updates | ➖ Absent — 30 s polling only | — | **New** Supabase Realtime | P1 |

## 6. Notifications

| Feature | Current status | Reusable? | V2 change | Priority |
| --- | --- | --- | --- | --- |
| In-app notifications | ✅ Works; created on book/reschedule/cancel/status | ✅ Keep | Keep, write via the outbox | P1 |
| Notification list + unread count | ✅ Works | ✅ Keep | SQL + partial index | P1 |
| Mark all read | ⚠️ Works; **never calls `persist()` (D8)** | Logic yes | `UPDATE … SET read_at` | P1 |
| Header unread badge | ✅ Works | ✅ Keep | Realtime-driven | P2 |
| Notification scoping | ❌ `?patientId=` honoured for non-admins (S-07) | No | Admin only | **P0** |
| Per-channel delivery tracking | 🚧 One row with `channel:"both"` and a `results[]` blob | No | `notification_deliveries` per channel | P2 |
| Reminder sweep | ⚠️ Works manually via an admin endpoint | ✅ Keep | Scheduled job + outbox; dedupe on `reminder_sent_at` | P1 |
| Email delivery (Resend) | 🚧 Implemented, inert without a key | ✅ Keep | Outbox drain; log-only fallback | P3 |
| SMS delivery (Twilio) | 🚧 Implemented, inert without a key | ✅ Keep | Outbox drain; log-only fallback | P3 |
| Transactional delivery guarantee | ❌ Notification rows are written outside the booking transaction | No | **New** transactional outbox | P1 |
| Notification retention | ❌ Hardcoded cap: `db.notifications.length = 500` drops the oldest | No | Scheduled retention job | P2 |
| Notification icons | 🚧 `EVENT_ICON` keys never match real `event` values (D4) | No | Fix the keys or move to a shared enum | P2 |
| `channels.simulated` badge | 🚧 Backend never returns `simulated` (D5) | No | Return it, or delete the branch | P3 |

## 7. AI triage

| Feature | Current status | Reusable? | V2 change | Priority |
| --- | --- | --- | --- | --- |
| Symptom checker UI | ⚠️ Works when signed in; **401 on the public landing page (D2)** | ✅ Keep | Decide: public or authenticated, then make both agree | P1 |
| Gemini integration | ⚠️ Works via raw `fetch`; **API key in the URL query string** | Logic yes | Key in a header; upgrade off retired `gemini-1.5-flash` | P1 |
| Rule-based fallback | ✅ Works; 10 keyword groups → specialty + urgency | ✅ Keep | Keep as the deterministic fallback | P1 |
| Timeout + graceful degradation | ✅ 8 s `AbortController` → warn → rule-based | ✅ Keep | Keep; add retry/backoff | P1 |
| Response validation | 🚧 Parses the first `{`…last `}` out of a string | No | Zod-validate the model output; discard on failure | P1 |
| Doctor recommendation grounding | ✅ Recommended ids always resolve to real doctors | ✅ Keep | Keep — good design | P1 |
| Urgency + red flags + follow-up questions | ✅ Works; the prompt explicitly forbids diagnosis | ✅ Keep | Keep the framing; persist to `triage_sessions` | P1 |
| "Recommendation, not diagnosis" framing | ⚠️ Present in the prompt and the UI disclaimer, but not enforced | ✅ Keep | Enforce in the copy **and** in `triage_sessions` audit records | P1 |
| Prompt-injection exposure | ⚠️ Free-text `description` is interpolated into the prompt; output is constrained to the specialty list | ⚠️ | Keep the whitelist mapping; validate the output schema | P2 |
| Public `GET /api/ai/provider` | 🚧 Exposes the model name and liveness unauthenticated | No | Auth-gate in production | P2 |
| Triage analytics | ➖ Absent | — | New `triage_sessions` | P3 |
| AI rate limiting | ✅ 20 req/min, always on | ✅ Keep | Keep | — |

## 8. Admin

| Feature | Current status | Reusable? | V2 change | Priority |
| --- | --- | --- | --- | --- |
| Admin dashboard KPIs | ⚠️ Works; ~130 full-array scans per request | ✅ Keep | SQL aggregates | P1 |
| 14-day trend | ⚠️ Works; computed with a JS loop | UI yes | `generate_series` + `LEFT JOIN` | P1 |
| By-specialty breakdown | ⚠️ Works | ✅ Keep | `GROUP BY` with `COUNT FILTER` | P1 |
| Top doctors + revenue | ⚠️ Works | ✅ Keep | SQL | P1 |
| Slot utilisation | ⚠️ Works | ✅ Keep | SQL | P1 |
| Manage doctors (fee, accepting flag) | ✅ Verified 200 | ✅ Keep | Remove `rating` from the allow-list (S-17) | P1 |
| Manage facilities (list + create) | ✅ Verified 201 | ✅ Keep | Keep | P2 |
| Services list | ✅ Works | ✅ Keep | Keep | — |
| Patient administration list | ⚠️ Works; exposes email, phone, blood group, allergies | ✅ Keep | Add an access log (S-19) | P1 |
| Notification log | ✅ Works | ✅ Keep | Keep | P2 |
| Manual reminder sweep trigger | ✅ Works | ✅ Keep | Keep for testing; add the scheduled job | P2 |
| Create doctors | ➖ Absent — admin can only patch | — | New (invite flow). Required once S-05 is fixed | P1 |
| Audit log | ➖ Absent | — | **New** `audit_logs` | P1 |

## 9. Patient & provider dashboards

| Feature | Current status | Reusable? | V2 change | Priority |
| --- | --- | --- | --- | --- |
| Patient home (upcoming + activity) | ✅ Works | ✅ Keep | Realtime; split from the 435-line `Home.jsx` | P1 |
| Provider dashboard (today + buckets) | ✅ Works | ✅ Keep | Keep; add the queue view | P1 |
| Provider slot management UI | ✅ Works | ✅ Keep | Add recurring templates | P1 |
| Provider status actions | ✅ Works; mirrors the server state machine | ⚠️ | Derive allowed actions from the server's state machine rather than duplicating it in `STATUS_ACTIONS` | P1 |
| Role-based navigation | ✅ Works; `NAV` map per role | ✅ Keep | Keep | — |
| Route guards | ✅ Correct — verified redirect + role behaviour | ✅ Keep | Extract and unit-test | — |
| Loading / empty / error states | ✅ Consistent across every page | ✅ Keep | Make uniform via TanStack Query states | — |
| Accessibility | ⚠️ Partial — `aria-label`s present; no keyboard trap handling in `Modal`; no focus management | ✅ Keep | Add focus trap + restore | P2 |
| Responsive layout | ✅ CSS classes + `hide-sm` | ✅ Keep | Re-implement in Tailwind | P2 |
| Error boundary | ➖ Absent — a render throw blanks the app | — | **New** | P1 |
| Route-level code splitting | ➖ Absent — one 262 KB bundle | — | **New** `React.lazy` | P2 |

## 10. Cross-cutting

| Feature | Current status | Reusable? | V2 change | Priority |
| --- | --- | --- | --- | --- |
| Response envelope | ✅ Consistent `{success,message,data}` | ✅ Keep | Keep; normalise the rate-limiter responses | P1 |
| Centralised error handling | ✅ `AppError` + `asyncHandler` + `errorHandler`; no internal leakage | ✅ Keep | Extend; add 23505/23P01 mapping | P1 |
| Request validation | ⚠️ Hand-rolled; does not strip unknown keys (S-08) | Pattern yes | Replace with Zod, strict mode | P1 |
| Logging | ⚠️ Console; `logger.tag()` prints a nested array (D7); no request id | ✅ Keep | Structured JSON + `requestId` | P1 |
| Security headers | ❌ No Helmet, no CSP, no HSTS (S-13) | No | **New** `helmet` | P1 |
| CORS | ⚠️ `origin \|\| true` + credentials; masked by a localhost default (S-11) | ✅ Keep | Strict allow-list, required in production | **P0** |
| Graceful shutdown | ✅ SIGINT/SIGTERM handled | ✅ Keep | Keep | — |
| Health endpoint | ✅ Works; leaks row counts publicly (S-15) | ✅ Keep | Trim in production | P2 |
| Swagger / OpenAPI | ➖ Absent | — | **New** — spec as the source of truth | P1 |
| Automated tests (Jest/Supertest) | ➖ Absent — only a manual smoke script | — | **New** | **P0** |
| CI/CD | ➖ Absent | — | **New** | P1 |
| Docker | ➖ Absent | — | **New** | P2 |
| Data layer | ⚠️ In-memory JSON, no interface, whole-file sync writes | **Partly** | `config/db.js` → pg pool + repositories | **P0** |

---

## 11. Effort summary

| Priority | Count | Notes |
| --- | --- | --- |
| **P0 — blocks the migration** | 21 | Auth correctness (8), booking concurrency (5), data layer (3), validation, authz scoping, build fix |
| **P1 — core v2 value** | 47 | SQL repositories, pagination, status history, queue, outbox, Realtime, admin CRUD, tests, OpenAPI |
| **P2 — polish** | 21 | Timeline, icon fixes, code splitting, a11y focus trap, containerisation |
| **P3 — optional** | 8 | Password reset, reviews, real SMS/email, triage analytics |

**Highest-risk cluster:** the 8 auth defects. All are cheap to fix, but four of them (S-01,
S-03, S-04, S-06) are independently exploitable **right now** against a running deployment.
They should be fixed before anything else ships, not merely before the migration.