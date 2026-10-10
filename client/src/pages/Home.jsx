import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "../api/client";
import { useAuth } from "../context/AuthContext.jsx";
import { useNotifications } from "../hooks/useNotifications.js";
import { DoctorCard } from "../components/DoctorCard.jsx";
import SymptomChecker from "../components/SymptomChecker.jsx";
import {
  Alert,
  Avatar,
  EmptyState,
  SkeletonCard,
  StatusBadge,
} from "../components/ui.jsx";
import {
  colorFrom,
  currency,
  formatDay,
  formatTime,
  relativeDay,
  todayISO,
} from "../utils/format";

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { notifications, unread, markAllRead } = useNotifications({
    poll: true,
  });

  const [specialties, setSpecialties] = useState([]);
  const [recommended, setRecommended] = useState([]);
  const [upcoming, setUpcoming] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [specRes, recRes] = await Promise.all([
        api.specialties(),
        api.recommended().catch(() => ({ recommendations: [] })),
      ]);
      setSpecialties(specRes.specialties || []);
      setRecommended((recRes.recommendations || []).slice(0, 6));

      if (user?.role === "patient") {
        // `from` filters to today onward; the API sorts newest-first, so flip
        // it here to show the next appointment at the top.
        const appts = await api
          .appointments({ from: todayISO() })
          .catch(() => ({ appointments: [] }));
        setUpcoming(
          [...(appts.appointments || [])]
            .filter(
              (a) => !["cancelled", "completed", "no-show"].includes(a.status),
            )
            .sort((x, y) =>
              x.date === y.date
                ? x.startTime.localeCompare(y.startTime)
                : x.date.localeCompare(y.date),
            )
            .slice(0, 3),
        );
      }
    } catch {
      /* the page still renders with empty states */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  /* ---------------- signed-in patient view ---------------- */
  if (user?.role === "patient") {
    return (
      <div className="page">
        <div className="container stack-lg">
          {/* greeting */}
          <div className="row-between">
            <div className="row">
              <Avatar
                name={user.name}
                color={colorFrom(user.email)}
                size="lg"
              />
              <div>
                <h1 style={{ marginBottom: 0 }}>
                  Hello, {user.name.split(" ")[0]}
                </h1>
                <p className="small muted" style={{ margin: 0 }}>
                  Here&apos;s what&apos;s coming up.
                </p>
              </div>
            </div>
            {unread > 0 && (
              <div className="card card-pad" style={{ padding: "0.7rem 1rem" }}>
                <div className="small">
                  <strong>{unread}</strong> unread notification
                  {unread > 1 ? "s" : ""}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={markAllRead}
                >
                  Mark all read
                </button>
              </div>
            )}
          </div>

          <div className="split">
            <div className="stack">
              {/* upcoming appointments */}
              <div className="card">
                <div className="card-head">
                  <h3>Upcoming appointments</h3>
                  <Link to="/appointments" className="btn btn-ghost btn-sm">
                    View all →
                  </Link>
                </div>
                <div className="card-body stack-sm">
                  {loading && <SkeletonCard height={70} />}
                  {!loading && upcoming.length === 0 && (
                    <EmptyState
                      icon="📅"
                      title="No upcoming appointments"
                      message="Find a doctor and book your first slot."
                      action={
                        <Link to="/doctors" className="btn btn-primary btn-sm">
                          Find a doctor
                        </Link>
                      }
                    />
                  )}
                  {!loading &&
                    upcoming.map((a) => (
                      <div
                        key={a.id}
                        className="row card"
                        style={{ padding: "0.75rem 0.9rem", boxShadow: "none" }}
                      >
                        <div
                          className="center"
                          style={{
                            width: 52,
                            flexShrink: 0,
                            padding: "0.3rem 0",
                            background: "var(--brand-50)",
                            borderRadius: 8,
                          }}
                        >
                          <div className="tiny muted bold">
                            {formatDay(a.date).split(",")[0]}
                          </div>
                          <div className="bold" style={{ lineHeight: 1.1 }}>
                            {formatDay(a.date).split(" ")[1]}
                          </div>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="row" style={{ gap: "0.4rem" }}>
                            <strong className="truncate">{a.doctorName}</strong>
                            <StatusBadge status={a.status} />
                          </div>
                          <div className="small muted truncate">
                            {formatTime(a.startTime)} · {a.specialtyName} ·{" "}
                            {a.facilityName}
                          </div>
                          <div className="tiny muted">
                            {relativeDay(a.date)} ·{" "}
                            {a.mode === "video" ? "Video" : "In person"}
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              </div>

              {/* recent notifications */}
              {notifications.length > 0 && (
                <div className="card">
                  <div className="card-head">
                    <h3>Recent activity</h3>
                    <Link to="/notifications" className="btn btn-ghost btn-sm">
                      All →
                    </Link>
                  </div>
                  <div className="card-body stack-sm">
                    {notifications.slice(0, 4).map((n) => (
                      <div
                        key={n.id}
                        className="row"
                        style={{ alignItems: "flex-start" }}
                      >
                        <span
                          className="dot"
                          style={{
                            marginTop: 7,
                            color: n.read
                              ? "var(--gray-300)"
                              : "var(--brand-600)",
                          }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="small bold">{n.subject}</div>
                          <div className="tiny muted">{n.body}</div>
                        </div>
                        <StatusBadge status={n.status} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* sidebar */}
            <div className="stack sticky-side">
              <SymptomChecker />
              <div className="card card-pad stack-sm">
                <h4 style={{ margin: 0 }}>Quick actions</h4>
                <Link to="/doctors" className="btn btn-secondary btn-block">
                  🔍 Find a doctor
                </Link>
                <Link
                  to="/appointments"
                  className="btn btn-secondary btn-block"
                >
                  📅 My appointments
                </Link>
                <Link to="/profile" className="btn btn-secondary btn-block">
                  👤 My profile
                </Link>
              </div>
            </div>
          </div>

          {/* recommended doctors */}
          <div>
            <div className="section-title">
              <h2>Recommended for you</h2>
              <Link to="/doctors" className="btn btn-ghost btn-sm">
                See all →
              </Link>
            </div>
            <div className="grid grid-auto">
              {loading
                ? Array.from({ length: 3 }).map((_, i) => (
                    <SkeletonCard key={i} />
                  ))
                : recommended.map((d) => (
                    <DoctorCard key={d.id} doctor={d} showMatch />
                  ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- public landing view ---------------- */
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
