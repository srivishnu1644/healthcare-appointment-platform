# MediCare v2 — CI/CD Plan

## Status: PENDING USER APPROVAL

**No CI/CD configuration exists in this repository, and none may be added until
it is explicitly authorised.** This document is a proposal.

There is deliberately:

- no `.github/workflows/`;
- no `.gitlab-ci.yml`;
- no `Jenkinsfile`;
- no build or deploy script that pushes anywhere.

What *does* exist is the local test entry points this plan would call, and a
schema verification that already supports being run against a disposable
database.

---

## 1. What would run, and why each step exists

| Stage | Command | Catches |
|---|---|---|
| Install | `npm ci` (server, client) | Lockfile drift, unresolvable deps |
| Lint / syntax | `node --check` across sources | Syntax errors before any suite runs |
| Schema | `npm run test:schema` | Constraint, index and migration breakage |
| Backend suites | 13 suites, see below | Behaviour regressions |
| Frontend build | `npm run build` (client) | Broken imports, missing exports |
| Docs accuracy | `npm run test:docs` | Documentation drifting from the router |
| Security | `npm audit` | Known vulnerabilities in the dependency tree |
| Secret scan | `gitleaks` / `trufflehog` | Committed credentials |
| Package build | `npm pack` into a publish step | Packaging mistakes |

### Backend suites

| Command | Covers |
|---|---|
| `test:security` | Authz, injection, IDOR, header leakage |
| `test:auth` | Registration, login, refresh rotation, RBAC |
| `test:directory` | Public reference data |
| `test:slots` | Slot generation, availability, blocking |
| `test:flow` | Doctor workflow end to end |
| `test:appointments` | Booking, reschedule, cancel, transitions, conflicts, concurrency |
| `test:queue` | Check-in, positions, call-next, completion, locks |
| `test:room` | Waiting-room model and privacy scoping |
| `test:notifications` | Events, dedupe, claims, outbox, reads |
| `test:assistant` | Knowledge base, injection refusal, consent, rate limit |
| `test:admin` | Role restrictions, visibility, filters |
| `test:validation` | Input validation and error contracts |
| `test:docs` | This documentation against the real router |
| `npm test` | Smoke |
| `test:schema` | Database invariants |

### Why the suites are run one at a time

The auth rate limiter is **per process** (100 logins / 10 min). Running suites
concurrently produces spurious `429`s and `undefined` token crashes. A CI job
must therefore run suites **sequentially**, with the API restarted between them,
and must not enable `npm run test:all`-style parallelism until the limiter is
made per-test-run.

This is a real constraint on the pipeline design, not a stylistic preference.

### Database service

Each job needs a PostgreSQL 16 service and a **disposable** database:

```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: medicare_test
    ports: ["5432:5432"]
    options: >-
      --health-cmd "pg_isready -U postgres"
      --health-interval 5s --health-timeout 5s --health-retries 10
```

Then `npm run db:migrate && npm run db:seed`, then the suites.

**Order matters.** `test:schema` asserts invariants about the *seeded* data
(among others: a finished appointment is never on a future slot, and the seed's
recorded booked-slot count matches reality). Running the behavioural suites first
leaves test fixtures behind that violate those invariants — four checks failed
for exactly this reason during this phase, with no defect involved.

Two consequences for the pipeline:

1. Run `test:schema` **first**, against a pristine seed; **or**
2. Give `test:schema` its own job with its own freshly seeded database.

Option 2 is cleaner and lets schema verification run in parallel with behaviour.

### Scheduler

The in-process scheduler must be off: `DISABLE_SCHEDULER=1`. The suites **assert**
it is off rather than assuming it, so a regression here fails loudly.

---

## 2. Proposed workflow design

Three workflows, not one. Separating them means a documentation failure cannot
block a security fix from merging.

### `ci.yml` — on every push and pull request

Triggers: `push` to any branch, `pull_request`.

1. Checkout
2. Set up Node 20
3. Start PostgreSQL 16 service, wait for readiness
4. `npm ci` in `server` and `client`
5. Migrate and seed a disposable database
6. Run backend suites **sequentially**
7. Run `test:schema` in a separate job on a fresh database
8. Build the client
9. Run the docs accuracy check
10. Upload logs as artefacts on failure

No secrets beyond the throwaway database password. Nothing is deployed.

### `security.yml` — on schedule and on pull request

1. `npm audit --audit-level=high` in both workspaces
2. Secret scan over full history
3. Dependency review on pull requests
4. Check that no `.env` file is tracked

Scheduled weekly, because advisories appear after code is merged.

### `release.yml` — on tag

**Gated.** See below.

---

## 3. Secret management

| Secret | Where it lives | Notes |
|---|---|---|
| `JWT_SECRET` | Repository secret → deployment environment | Must be identical across instances; changing it invalidates every session |
| `DATABASE_URL` | Repository secret | Prefer an injected secret over a `.env` file in the repository |
| `GEMINI_KEY`, `TWILIO_*`, `RESEND_API_KEY` | Repository secrets | **Optional.** The application is fully functional without them and reports its own degraded state |

Rules:

- Secrets are **never** passed as build arguments to the client. Anything in
  `VITE_*` is compiled into the bundle and is public. `VITE_API_URL` is the only
  client variable and it is not secret.
- Fork pull requests from outside collaborators must **not** receive secrets.
  GitHub does not pass them to `pull_request` runs from forks; do not work
  around that with `pull_request_target`, which would run untrusted code with
  repository access.
- A self-hosted runner is **not** recommended. Fork PRs execute code on it.

---

## 4. Migration safety

Migrations are **forward-only** — there is no `down`. This shapes the pipeline:

1. **Migrations run as a deploy step, not a build step.** The build produces an
   artefact; it must not touch a production schema.
2. **Migrate before serving**, never concurrently with live traffic on the same
   database. The application is single-process, so a rolling deployment means the
   old process must stop before migrations run.
3. **Every migration must be additive and backwards-compatible for one version**,
   so a rollback of the *application* does not require rolling back the *schema*.
   Removing a column happens in a later release, after the code that stopped
   reading it has shipped.
4. **Never run `db:migrate:reset` outside a disposable database.** It is
   `DROP SCHEMA CASCADE`; the pipeline should invoke it only against a service
   container.
5. **Migration compatibility is verified by `test:schema`** against a fresh
   database — that is the check that catches a broken migration.

### Backup before migrating

Take a backup and **confirm it can be restored** before any migration that is
not purely additive. Since there is no down migration, the restore is the only
way back.

---

## 5. Deployment approval gates

| Gate | Who | When |
|---|---|---|
| CI green | Automated | Required to merge |
| Code review | A human | Required to merge, no self-approval |
| Dependency + secret scan clean | Automated | Required to merge |
| Release approval | A human | Required to deploy to production |
| Migration approval | A human | Required for any non-additive migration |

Use GitHub **Environments** with required reviewers for `production`, so the
approval gate is enforced by the platform rather than by convention.

---

## 6. Rollback

Because there is no down migration, rollback is **artefact rollback, not schema
rollback**:

1. Stop the running process. It handles `SIGTERM` and shuts down gracefully.
2. Deploy the previous build artefact.
3. If the previous build cannot read the new schema, restore the database from
   the backup taken before migrating.

Additive-only migrations make step 3 unnecessary in practice. That constraint
is why step 3 exists but should rarely be needed.

**Rollback is untested.** No deployment has occurred, so no rollback has been
performed. Treat the procedure as a plan, not a known-good path.

---

## 7. Branch protection

Recommended for `main`:

- Require a pull request; forbid direct pushes.
- Require one approving review; disallow self-approval.
- Require CI to pass before merge.
- Require branches to be up to date before merging.
- Require signed commits.
- Do **not** allow bypassing with an admin override for routine work.

---

## 8. What this plan does not cover

- **Secrets rotation on a schedule** — no mechanism exists.
- **Blue/green or canary** — the single-process scheduler makes a second
  production instance undesirable; see the deployment guide.
- **Database migration rollback** — impossible by design.
- **Multi-region** — out of scope.
- **Infrastructure as code** — deliberately absent; no Docker, Kubernetes or
  Terraform is in this project.

---

## 9. Approval checklist

Before any of this becomes executable, confirm:

- [ ] CI/CD implementation is authorised
- [ ] The runner environment is decided (GitHub-hosted vs self-hosted)
- [ ] The deployment target is chosen
- [ ] The secret storage mechanism is agreed
- [ ] Someone owns the migration-approval gate
- [ ] A restore-from-backup drill has been performed at least once

Until every box is ticked, the repository stays as it is: local commands, no
automation.