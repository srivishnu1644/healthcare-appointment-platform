import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "../api/client";
import { useAuth } from "../context/AuthContext.jsx";
import { DoctorCard } from "../components/DoctorCard.jsx";
import SymptomChecker from "../components/SymptomChecker.jsx";
import { Alert, SkeletonCard } from "../components/ui.jsx";

/* ------------------------------------------------------------------ *
 *  PublicHome — the anonymous landing page at "/".                     *
 *                                                                      *
 *  Split out of Home.jsx in Phase 7 (task 7.1). It is deliberately free *
 *  of any authenticated concern: no appointments, no notifications, no  *
 *  patient data. A signed-in patient never lands here — the header, the *
 *  nav and every post-auth redirect point at /dashboard, which is       *
 *  rendered by PatientDashboard. Anyone may still open "/" directly,    *
 *  signed in or not.                                                    *
 * ------------------------------------------------------------------ */
export default function PublicHome() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [specialties, setSpecialties] = useState([]);
  const [recommended, setRecommended] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [specRes, recRes] = await Promise.all([
        api.specialties(),
        api.recommended().catch(() => ({ recommendations: [] })),
      ]);
      setSpecialties(specRes.specialties || []);
      setRecommended((recRes.recommendations || []).slice(0, 6));
    } catch {
      /* the page still renders with empty states */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {/* hero */}
      <section
        style={{
          background:
            "linear-gradient(135deg, var(--brand-700) 0%, var(--brand-900) 100%)",
          color: "#fff",
          padding: "3.5rem 0 3.75rem",
        }}
      >
        <div className="container stack" style={{ maxWidth: 760 }}>
          <h1 style={{ color: "#fff", fontSize: "2.4rem", margin: 0 }}>
            Find the right doctor, book in seconds
          </h1>
          <p
            style={{
              color: "var(--brand-100)",
              fontSize: "1.05rem",
              margin: 0,
            }}
          >
            Search verified specialists, see live availability and manage your
            whole appointment journey — reminders, rescheduling and history in
            one place.
          </p>

          <div
            className="card"
            style={{ padding: "0.5rem", boxShadow: "var(--shadow-xl)" }}
          >
            <div className="row" style={{ gap: "0.5rem" }}>
              <input
                className="input"
                placeholder="Search by doctor, specialty or facility…"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    navigate(
                      `/doctors?q=${encodeURIComponent(e.target.value)}`,
                    );
                  }
                }}
                aria-label="Search doctors"
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={(e) => {
                  const input = e.currentTarget.previousSibling;
                  navigate(`/doctors?q=${encodeURIComponent(input.value)}`);
                }}
              >
                Search
              </button>
            </div>
          </div>

          <div className="row row-wrap" style={{ gap: "0.4rem" }}>
            <span className="small" style={{ color: "var(--brand-100)" }}>
              Popular:
            </span>
            {specialties.slice(0, 6).map((s) => (
              <Link
                key={s.id}
                to={`/doctors?specialty=${encodeURIComponent(s.name)}`}
                className="badge"
                style={{ background: "rgba(255,255,255,0.16)", color: "#fff" }}
              >
                {s.name}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* specialties */}
      <section className="page">
        <div className="container stack-lg">
          <div>
            <div className="section-title">
              <h2>Browse by specialty</h2>
              <Link to="/doctors" className="btn btn-ghost btn-sm">
                All doctors →
              </Link>
            </div>
            <div className="grid grid-auto">
              {loading
                ? Array.from({ length: 6 }).map((_, i) => (
                    <SkeletonCard key={i} height={90} />
                  ))
                : specialties.map((s) => (
                    <Link
                      key={s.id}
                      to={`/doctors?specialty=${encodeURIComponent(s.name)}`}
                      className="card card-hover card-pad stack-sm"
                      style={{ textDecoration: "none" }}
                    >
                      <strong>{s.name}</strong>
                      <span className="small muted">{s.description}</span>
                    </Link>
                  ))}
            </div>
          </div>

          <div className="split">
            <SymptomChecker />
            <div className="card card-pad stack">
              <h3 style={{ margin: 0 }}>Why MediCare?</h3>
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
                  "SMS and email updates on every change.",
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
                  <span style={{ fontSize: "1.2rem" }}>{icon}</span>
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
              <div className="section-title">
                <h2>Top rated specialists</h2>
                <Link to="/doctors" className="btn btn-ghost btn-sm">
                  See all →
                </Link>
              </div>
              <div className="grid grid-auto">
                {recommended.map((d) => (
                  <DoctorCard key={d.id} doctor={d} showMatch />
                ))}
              </div>
            </div>
          )}

          {!user && (
            <Alert tone="info" title="Prototype demo">
              Sign in with the demo accounts to explore the patient, doctor and
              admin dashboards.
            </Alert>
          )}
        </div>
      </section>
    </div>
  );
}