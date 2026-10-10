# Healthcare Appointment Platform

A patient-centric healthcare appointment prototype: discover doctors, check live
availability, book / reschedule / cancel appointments, and track status — with
AI-assisted recommendations, provider scheduling tools, and an admin analytics
dashboard.

Built as a **working prototype** (React + Express, in-memory datastore), no
external services or API keys required.

---

## Quick start

Two terminals, from the project root.

```bash
# 1) API server  -> http://localhost:5000
cd server
npm install
npm run dev

# 2) Web client  -> http://localhost:5173
cd client
npm install
npm run dev
```

Open **http://localhost:5173**.

Verify the API end-to-end (with the server running):

```bash
cd server
node scripts/smoke.js     # 35 assertions across auth, discovery, booking, AI, admin
```

> The datastore persists to `server/.data/db.json`. Delete that file to reset to
> a fresh seed.

---

## Demo accounts

| Role    | Email                                    | Password     |
| ------- | ---------------------------------------- | ------------ |
| Patient | `patient@demo.com`                       | `patient123` |
| Patient | `ishita@demo.com`                        | `patient123` |
| Patient | `aman@demo.com`                          | `patient123` |
| Doctor  | `doctor1@demo.com` … `doctor12@demo.com` | `doctor123`  |
| Admin   | `admin@demo.com`                         | `admin123`   |

Sign in as each role to see the role-specific dashboards.

---

## Tech stack

**Client** — React 18, React Router 6, Vite 5. No UI framework; styling is a
hand-written design system in `client/src/styles/index.css`.

**Server** — Node.js, Express 4, JWT auth (`bcryptjs` + `jsonwebtoken`),
`express-rate-limit` on credential routes, `cors`, `morgan`.

**Data** — in-memory store with JSON file persistence
(`server/src/config/db.js`). No external database, so the prototype runs
anywhere. Swapping in MongoDB means replacing that one module.

**AI** — a deterministic, rule-based symptom triage engine
(`server/src/services/aiService.js`). No external LLM key needed; it maps
symptoms → urgency, suggested departments, and ranked doctors.

---

## Project layout

```
healthcare-appointment-platform/
├── client/
│   └── src/
│       ├── api/client.js          # typed fetch wrapper, token handling
│       ├── components/            # Layout, DoctorCard, SymptomChecker, ui primitives
│       ├── context/               # AuthContext, ToastContext
│       ├── hooks/                 # useNotifications (shared unread badge)
│       ├── pages/                 # patient + provider screens
│       │   └── admin/             # 5 admin screens
│       ├── styles/index.css       # design tokens + components
│       └── utils/format.js
└── server/
    ├── index.js                   # entry point
    ├── scripts/smoke.js           # end-to-end API test suite
    └── src/
        ├── app.js                 # express app wiring
        ├── config/                # env, db + seed data
        ├── controllers/           # auth, doctor, appointment, ai, notification, admin
        ├── middlewares/           # auth, validation, error handler
        ├── routes/                # one router per domain
        ├── services/              # appointment/slot logic, ai, notifications
        └── utils/                 # logger, response envelope
```

---

## Features, mapped to the brief

| Deliverable                                                         | Where it lives                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Registration & profile management                                   | `pages/Register.jsx`, `pages/Profile.jsx`, `PATCH /api/auth/me`             |
| Doctor & facility discovery                                         | `pages/DoctorDirectory.jsx`, `GET /api/doctors`                             |
| Search & filter by specialty / location / availability / fee / mode | `GET /api/doctors` filters + `DoctorDirectory` controls (synced to the URL) |
| Doctor profile & service info                                       | `pages/DoctorProfile.jsx`, `GET /api/doctors/:id`                           |
| Real-time (simulated) slot availability                             | `server/src/services/appointmentService.js`, `GET /api/doctors/:id/slots`   |
| Booking, rescheduling, cancellation                                 | `pages/MyAppointments.jsx`, `POST/PATCH /api/appointments`                  |
| AI-assisted recommendations                                         | `components/SymptomChecker.jsx`, `POST /api/ai/triage`                      |
| Appointment reminders & notifications                               | `services/notificationService.js`, `pages/Notifications.jsx`                |
| Appointment history & status tracking                               | `pages/MyAppointments.jsx` with status chips + timeline                     |
| Provider scheduling dashboard                                       | `pages/ProviderDashboard.jsx`, `GET /api/doctors/me/schedule`               |
| Admin dashboard (doctors, facilities, services, slots)              | `pages/admin/*`                                                             |
| Queue / waiting-time info                                           | `GET /api/appointments/queue`, check-in flow                                |
| Analytics (appointments, cancellations, no-shows, utilisation)      | `pages/admin/AdminDashboard.jsx`, `GET /api/admin/overview`                 |
| Secure handling of patient data                                     | JWT + bcrypt, role-based `requireRole` guards, field-whitelisted responses  |

---

## API reference

All responses use the envelope `{ success, message, data }`.

### Auth — `/api/auth`

| Method | Path        | Access                |
| ------ | ----------- | --------------------- |
| POST   | `/register` | public (rate-limited) |
| POST   | `/login`    | public (rate-limited) |
| GET    | `/me`       | any signed-in user    |
| PATCH  | `/me`       | any signed-in user    |

### Doctors — `/api/doctors`

| Method     | Path                                       | Access                                                                                                              |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| GET        | `/specialties`, `/services`, `/facilities` | public                                                                                                              |
| GET        | `/recommended`                             | public (personalised when signed in)                                                                                |
| GET        | `/`                                        | public — filters: `search`, `specialty`, `city`, `maxFee`, `minRating`, `language`, `mode`, `acceptingOnly`, `sort` |
| GET        | `/:id`, `/:id/slots`                       | public                                                                                                              |
| GET        | `/me/schedule`                             | doctor                                                                                                              |
| POST/PATCH | `/:id/slots`, `/:id/slots/:slotId`         | doctor, admin                                                                                                       |

### Appointments — `/api/appointments`

| Method | Path                                            | Access                                           |
| ------ | ----------------------------------------------- | ------------------------------------------------ |
| GET    | `/`                                             | signed-in (patient → own; doctor → own schedule) |
| GET    | `/:id`                                          | owner / doctor / admin                           |
| POST   | `/`                                             | patient                                          |
| PATCH  | `/:id/reschedule`, `/:id/cancel`, `/:id/status` | owner (doctor for status)                        |
| POST   | `/:id/check-in`                                 | patient                                          |
| GET    | `/queue`, `/availability`                       | signed-in                                        |

### AI — `/api/ai`

| Method | Path        | Access    |
| ------ | ----------- | --------- |
| GET    | `/provider` | public    |
| POST   | `/triage`   | signed-in |

### Notifications — `/api/notifications`

`GET /` · `PATCH /read-all` (user) · `POST /reminders/sweep` (admin)

### Admin — `/api/admin`

`GET /overview` · `GET /doctors` · `PATCH /doctors/:id` · `GET /facilities` ·
`POST /facilities` · `GET /services` · `GET /patients` · `GET /notifications`
— all admin-only.

---

## Design notes & known limitations

Prototype-scope trade-offs, deliberately made to keep the project runnable with
zero external dependencies:

- **JSON file datastore** — fine for a demo, not for concurrent writes. The
  `db.js` module is the single seam to swap in a real database.
- **Slot availability is simulated** — a generator seeds slots ahead of the
  current date rather than integrating a real calendar.
- **AI triage is rule-based**, not a trained model. It scores symptom keywords
  against specialties; it does not diagnose.
- **Notifications are stored and displayed in-app** — no email/SMS delivery.
- **Auth limiter is skipped when `NODE_ENV !== "production"`** so the smoke
  suite can be re-run freely. Production traffic stays rate-limited.

Accessibility, keyboard-navigable modals, empty/loading/error states, and
responsive layouts are handled in the client; the design tokens in
`styles/index.css` centralise colour and spacing.
