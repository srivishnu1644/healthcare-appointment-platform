import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "../api/client";
import { DoctorCard } from "../components/DoctorCard.jsx";
import SymptomChecker from "../components/SymptomChecker.jsx";
import { Alert } from "../components/ui.jsx";
import { num } from "../utils/format";
import { useAuth } from "../context/AuthContext.jsx";
import { homeFor } from "../components/Layout.jsx";
import SplitText from "../components/bits/SplitText.jsx";

/* Real-life photos for the benefit cards (Unsplash, same source as the
   doctor portraits in utils/doctorPhotos.js). Every ID below was verified
   live (HTTP 200 + image/jpeg) before being added. */
const benefitImg = (id) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=640&h=640&q=70`;

const BENEFITS = [
  {
    title: "Symptom\ntriage",
    body: "Describe how you feel and get matched to the right department and doctors.",
    photo: benefitImg("1576091160399-112ba8d25d1d"),
    alt: "Doctor reviewing notes on a tablet during a consultation",
  },
  {
    title: "Doctor\ndiscovery",
    body: "Search verified specialists by speciality, city, fee and language.",
    photo: benefitImg("1559839734-2b71ea197ec2"),
    alt: "Smiling doctor in a white coat",
  },
  {
    title: "Live\navailability",
    body: "Real-time slots with in-person and video consultation options.",
    photo: benefitImg("1506784983877-45594efa4cbe"),
    alt: "Desk planner showing scheduled appointments",
  },
  {
    title: "Instant\nbooking",
    body: "Pick a slot and confirm in seconds, with conflict checks built in.",
    photo: benefitImg("1576091160550-2173dba999ef"),
    alt: "Doctor confirming details on a digital tablet",
  },
  {
    title: "Queue\nmanagement",
    body: "Check in, see your real position and know when you are called.",
    photo: benefitImg("1519494026892-80bbd2d6fd0d"),
    alt: "Bright modern clinic corridor",
  },
  {
    title: "Automatic\nreminders",
    body: "In-app and email updates the moment anything changes.",
    photo: benefitImg("1512941937669-90a1b58e7e9c"),
    alt: "Hand holding a smartphone receiving a notification",
  },
];

/* ------------------------------------------------------------------ *
 *  Search glyph: a magnifier — a ring with the handle running down and  *
 *  to the right out of it.                                            *
 *                                                                     *
 *  Drawn rather than typed for the same reasons as the icons in        *
 *  components/Layout.jsx: it inherits `currentColor`, so it stays white *
 *  on the brand-filled pill instead of being an emoji whose tint the    *
 *  browser picks, and its stroke weight matches the rest of the set.   *
 * ------------------------------------------------------------------ */
function SearchIcon() {
  return (
    <svg
      className="landing-search-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 *  PublicHome — the anonymous landing page at "/".                     *
 *                                                                      *
 *  Split out of Home.jsx in Phase 7 (task 7.1). It is deliberately free *
 *  of any authenticated concern: no appointments, no notifications, no  *
 *  patient data. A signed-in patient never lands here — the header, the *
 *  nav and every post-auth redirect point at /dashboard, which is       *
 *  rendered by PatientDashboard. Anyone may still open "/" directly,    *
 *  signed in or not.                                                    *
 *                                                                      *
 *  All calls to action point at existing routes only: /doctors (with    *
 *  optional ?q= / ?specialty=), /login, /register, /doctors/:id and the *
 *  role dashboard via homeFor(). No duplicate auth or booking flows.    *
 * ------------------------------------------------------------------ */
export default function PublicHome() {
  const navigate = useNavigate();
  const { user, role } = useAuth();

  const [specialties, setSpecialties] = useState([]);
  const [recommended, setRecommended] = useState([]);
  const [totalDoctors, setTotalDoctors] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const load = async () => {
    try {
      const [specRes, recRes, docRes] = await Promise.all([
        api.specialties(),
        api.recommended().catch(() => ({ recommendations: [] })),
        // Total only. The directory fetch is the same endpoint the search page
        // uses, so the hero figure and the "Found N doctors" count below can
        // never disagree.
        api.doctors({}).catch(() => ({ total: 0 })),
      ]);
      setSpecialties(specRes.specialties || []);
      setRecommended((recRes.recommendations || []).slice(0, 6));
      setTotalDoctors(docRes.total ?? docRes.count ?? 0);
    } catch {
      /* the page still renders with empty states */
      setLoadError(
        "We could not load live directory stats. You can still search doctors below.",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dashboardHome = user ? homeFor(role) : null;

  return (
    <div>
      {/* ---------- hero ---------- */}
      <section className="oris-hero landing-hero" aria-labelledby="landing-hero-heading">
        <div className="oris-hero-inner landing-hero-simple">
          <div
            className="stack"
            style={{ gap: "1.4rem", alignItems: "center", textAlign: "center" }}
          >
            <h1 id="landing-hero-heading" className="landing-hero-title">
              <SplitText
                text="Book Appointments with "
                mode="words"
                stagger={45}
                className="oris-display"
              />
              <SplitText
                text="Trusted Doctors"
                mode="words"
                stagger={45}
                delay={180}
                className="oris-display landing-hero-accent"
              />
            </h1>
            <p className="oris-lead" style={{ maxWidth: "56ch" }}>
              Get expert care from qualified doctors. Book appointments online,
              manage your health records, and take a step towards a healthier
              life.
            </p>
            <form
              className="landing-search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                const value = new FormData(e.currentTarget).get("q");
                navigate(
                  `/doctors?q=${encodeURIComponent(String(value || ""))}`,
                );
              }}
            >
              <input
                name="q"
                className="landing-search-input"
                placeholder="Search doctors, specialities or symptoms…"
                aria-label="Search doctors"
              />
              <button type="submit" className="oris-pill landing-search-btn">
                <SearchIcon />
                Search
              </button>
            </form>
            <div
              className="row"
              style={{
                gap: "0.6rem",
                flexWrap: "wrap",
                justifyContent: "center",
              }}
            >
              <Link to="/doctors" className="oris-pill">
                <span className="dot" aria-hidden="true" />
                Book an appointment
              </Link>
              {user ? (
                <Link to={dashboardHome} className="oris-pill landing-pill-outline">
                  Go to your dashboard
                </Link>
              ) : (
                <Link to="/register" className="oris-pill landing-pill-outline">
                  Get started
                </Link>
              )}
            </div>
            {!user && (
              <p className="small muted">
                New here? <Link to="/register">Create an account</Link> in
                seconds · Already have an account?{" "}
                <Link to="/login">Sign in</Link>
              </p>
            )}
            <ul
              className="landing-trust"
              style={{ justifyContent: "center" }}
            >
              <li>In-person &amp; video</li>
              <li>Automatic reminders</li>
              <li>Secure by design</li>
            </ul>
          </div>

          <div className="oris-stat-card landing-hero-stats">
            <div>
              <h3>{num(totalDoctors)}+</h3>
              <p>Verified specialists</p>
            </div>
            <div>
              <h3>{num(specialties.length || 0)}</h3>
              <p>Specialities</p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- services / key benefits ---------- */}
      <section
        className="page page-glass-bg"
        style={{ paddingTop: "5vw", paddingBottom: "3.5rem" }}
        aria-labelledby="landing-benefits-heading"
      >
        <div className="container">
          <div className="oris-eyebrow">
            <span className="dot" />
            <span>What BookMyDoc offers</span>
          </div>
          <h2
            id="landing-benefits-heading"
            style={{
              fontSize: "3vw",
              margin: "1.5rem 0 0.5rem",
              maxWidth: "18ch",
            }}
          >
            Care designed for every step of your journey
          </h2>
          <p className="muted" style={{ maxWidth: "52ch" }}>
            From finding the right specialist to managing your visits,
            everything stays organised and on time.
          </p>
        </div>

        <div className="container" style={{ marginTop: "2.5rem" }}>
          <div className="oris-marquee oris-marquee-auto">
            <div className="oris-marquee-track">
              {[...BENEFITS, ...BENEFITS].map(
                ({ title, body, photo, alt }, i) => (
                  <article
                    key={`${title}-${i}`}
                    className="oris-marquee-card"
                    aria-hidden={i >= BENEFITS.length || undefined}
                  >
                    <div className="oris-marquee-visual">
                      <img
                        src={photo}
                        alt={i < BENEFITS.length ? alt : ""}
                        loading="lazy"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    </div>
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </article>
                ),
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section
        className="page landing-section landing-alt"
        style={{ paddingTop: "1.5rem" }}
        aria-labelledby="landing-how-heading"
      >
        <div className="container stack-lg">
          <div>
            <div className="oris-eyebrow">
              <span className="dot" />
              <span>How it works</span>
            </div>
            <h2
              id="landing-how-heading"
              style={{ margin: "1rem 0 0.5rem", maxWidth: "24ch" }}
            >
              Find a doctor, book a slot, manage your visit
            </h2>
            <p className="muted" style={{ maxWidth: "56ch", margin: 0 }}>
              Three steps, one app. Every action below opens an existing page —
              nothing here is a mock.
            </p>
          </div>

          <ol className="grid grid-3 landing-steps">
            <li className="card card-pad stack-sm">
              <span
                className="landing-step-num"
                aria-hidden="true"
              >
                1
              </span>
              <h3 style={{ margin: 0 }}>Find your doctor</h3>
              <p className="small muted" style={{ margin: 0 }}>
                Search verified specialists by speciality, city, fee, language
                and consultation mode.
              </p>
              <Link to="/doctors" className="btn btn-secondary btn-sm">
                Browse doctors →
              </Link>
            </li>
            <li className="card card-pad stack-sm">
              <span
                className="landing-step-num"
                aria-hidden="true"
              >
                2
              </span>
              <h3 style={{ margin: 0 }}>Book instantly</h3>
              <p className="small muted" style={{ margin: 0 }}>
                Pick a live slot and confirm in seconds. Conflicts and past
                slots are checked for you.
              </p>
              <Link to="/doctors" className="btn btn-secondary btn-sm">
                See live availability →
              </Link>
            </li>
            <li className="card card-pad stack-sm">
              <span
                className="landing-step-num"
                aria-hidden="true"
              >
                3
              </span>
              <h3 style={{ margin: 0 }}>Manage your visit</h3>
              <p className="small muted" style={{ margin: 0 }}>
                Check in on arrival, see your queue position, and get reminders
                when anything changes.
              </p>
              {user ? (
                <Link to={dashboardHome} className="btn btn-secondary btn-sm">
                  Open your dashboard →
                </Link>
              ) : (
                <Link to="/login" className="btn btn-secondary btn-sm">
                  Sign in to manage →
                </Link>
              )}
            </li>
          </ol>
        </div>
      </section>

      {/* ---------- specialties ---------- */}
      <section
        className="page landing-section"
        style={{ paddingTop: "2.5rem" }}
        aria-labelledby="landing-specialties-heading"
      >
        <div className="container stack-lg">
          <div>
            <div className="row-between">
              <div className="oris-eyebrow">
                <span className="dot" />
                <span id="landing-specialties-heading">
                  Browse by speciality
                </span>
              </div>
              <Link to="/doctors" className="btn btn-ghost btn-sm">
                All doctors →
              </Link>
            </div>
            {loadError && (
              <div style={{ marginTop: "1rem" }}>
                <Alert tone="warning">{loadError}</Alert>
              </div>
            )}
            <div className="mock-pills" style={{ marginTop: "1.25rem" }}>
              {loading
                ? Array.from({ length: 8 }).map((_, i) => (
                    <span
                      key={i}
                      className="skeleton"
                      style={{ width: 120, height: 34 }}
                    />
                  ))
                : specialties.map((s) => (
                    <Link
                      key={s.id}
                      to={`/doctors?specialty=${encodeURIComponent(s.name)}`}
                      className="mock-pill"
                    >
                      {s.name}
                    </Link>
                  ))}
            </div>
          </div>

          <div className="split">
            <SymptomChecker />
            <div className="card card-pad stack">
              <h3 style={{ margin: 0 }}>Why BookMyDoc?</h3>
              {[
                [
                  "🎯",
                  "AI-guided discovery",
                  "Describe symptoms and get matched to the right department.",
                ],
                [
                  "⚡",
                  "Live availability",
                  "Real-time slots with in-person and video options.",
                ],
                [
                  "🔔",
                  "Automatic reminders",
                  "Email updates on every change, SMS ready when configured.",
                ],
                [
                  "🔒",
                  "Secure by design",
                  "Role-based access for patients, doctors and admins.",
                ],
              ].map(([icon, title, body]) => (
                <div
                  key={title}
                  className="row"
                  style={{ alignItems: "flex-start" }}
                >
                  <span style={{ fontSize: "1.2rem" }} aria-hidden="true">
                    {icon}
                  </span>
                  <div>
                    <div className="small bold">{title}</div>
                    <div className="tiny muted">{body}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {recommended.length > 0 && (
            <div>
              <div className="row-between">
                <div className="oris-eyebrow">
                  <span className="dot" />
                  <span>Top rated specialists</span>
                </div>
                <Link to="/doctors" className="btn btn-ghost btn-sm">
                  See all →
                </Link>
              </div>
              <p className="small muted" style={{ marginTop: "0.6rem" }}>
                Live picks from the directory — ratings and fees shown are the
                same ones you will see when booking.
              </p>
              <div className="stack" style={{ marginTop: "1.25rem" }}>
                {recommended.map((d) => (
                  <DoctorCard key={d.id} doctor={d} />
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ---------- why choose ---------- */}
      <section
        className="page landing-section landing-why"
        aria-labelledby="landing-why-heading"
      >
        <div className="container stack-lg">
          <div>
            <div className="oris-eyebrow">
              <span className="dot" />
              <span>Why choose BookMyDoc</span>
            </div>
            <h2 id="landing-why-heading" style={{ margin: "1rem 0 0.5rem" }}>
              Built for the part after booking
            </h2>
            <p className="muted" style={{ maxWidth: "56ch", margin: 0 }}>
              Booking is easy. Waiting, updates and follow-through are not —
              so that is where BookMyDoc helps most.
            </p>
          </div>
          <div className="grid grid-3">
            {[
              [
                "📅",
                "Booking without clashes",
                "One transaction holds the slot, so two patients racing for it produce one booking — not two.",
              ],
              [
                "🔔",
                "Reminders that follow through",
                "Booking, reschedule, cancellation and queue updates land in your notifications inbox.",
              ],
              [
                "🔒",
                "Private by construction",
                "You see only your own appointments and position. Providers and admins see only what their role allows.",
              ],
            ].map(([icon, title, body]) => (
              <article key={title} className="card card-pad stack-sm">
                <span
                  className="landing-why-icon"
                  aria-hidden="true"
                >
                  {icon}
                </span>
                <h3 style={{ margin: 0, fontSize: "1rem" }}>{title}</h3>
                <p className="small muted" style={{ margin: 0 }}>
                  {body}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- final CTA ---------- */}
      <section
        className="page landing-section"
        style={{ paddingTop: "2.5rem" }}
        aria-labelledby="landing-cta-heading"
      >
        <div className="container">
          <div className="landing-cta">
            <div>
              <div className="oris-eyebrow landing-cta-eyebrow">
                <span className="dot" />
                <span>Get started</span>
              </div>
              <h2 id="landing-cta-heading">Ready to book your visit?</h2>
              <p>
                Create an account in seconds, find a verified specialist, and
                keep every appointment, reminder and queue update in one place.
              </p>
            </div>
            <div className="landing-cta-actions">
              {user ? (
                <Link to={dashboardHome} className="btn btn-lg landing-cta-primary">
                  Go to your dashboard
                </Link>
              ) : (
                <Link
                  to="/register"
                  className="btn btn-lg landing-cta-primary"
                >
                  Get started
                </Link>
              )}
              <Link to="/doctors" className="btn btn-lg landing-cta-secondary">
                Browse doctors
              </Link>
              {!user && (
                <p className="small" style={{ margin: 0 }}>
                  Already have an account?{" "}
                  <Link to="/login" className="landing-cta-link">
                    Sign in
                  </Link>
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
