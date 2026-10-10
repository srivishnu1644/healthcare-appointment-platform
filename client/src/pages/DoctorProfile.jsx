import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import api from "../api/client";
import { BookingPanel } from "../components/DoctorCard.jsx";
import {
  Alert,
  Avatar,
  EmptyState,
  Loading,
  ProgressBar,
  Stat,
  StatusBadge,
  Tabs,
} from "../components/ui.jsx";
import { currency, formatDay, formatTime, relativeDay } from "../utils/format";

export default function DoctorProfile() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(params.get("book") ? "book" : "overview");

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.doctor(id);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (loading) return <Loading label="Loading doctor profile…" />;

  if (error || !data?.doctor) {
    return (
      <div className="page">
        <div className="container">
          <Alert tone="danger">{error || "Doctor not found"}</Alert>
          <Link
            to="/doctors"
            className="btn btn-secondary btn-sm"
            style={{ marginTop: "1rem" }}
          >
            ← Back to directory
          </Link>
        </div>
      </div>
    );
  }

  const {
    doctor,
    facility,
    services,
    availability,
    upcomingAppointments,
    stats,
  } = data;
  const nextSlot = availability?.find((a) => a.nextAvailableSlot);

  return (
    <div className="page">
      <div className="container stack">
        <Link
          to="/doctors"
          className="btn btn-ghost btn-sm"
          style={{ alignSelf: "flex-start" }}
        >
          ← All doctors
        </Link>

        {/* ---------- header ---------- */}
        <div className="card card-pad">
          <div
            className="row row-wrap"
            style={{ alignItems: "flex-start", gap: "1.15rem" }}
          >
            <Avatar name={doctor.name} color={doctor.imageColor} size="xl" />

            <div style={{ flex: 1, minWidth: 240 }}>
              <div className="row row-wrap" style={{ gap: "0.5rem" }}>
                <h1 style={{ margin: 0 }}>{doctor.name}</h1>
                {doctor.isAcceptingNew ? (
                  <span className="badge badge-success">
                    <span className="dot dot-pulse" /> Accepting patients
                  </span>
                ) : (
                  <span className="badge">Not accepting</span>
                )}
              </div>
              <div className="small muted">{doctor.specialtyName}</div>
              <div className="small muted">
                {doctor.qualification} · {doctor.experience} years experience
              </div>

              <div
                className="row row-wrap small"
                style={{ gap: "0.85rem", marginTop: "0.5rem" }}
              >
                <span>
                  ⭐ <strong>{doctor.rating}</strong> ({doctor.reviewCount}{" "}
                  reviews)
                </span>
                <span className="bold">{currency(doctor.consultationFee)}</span>
                <span className="muted">{doctor.languages?.join(", ")}</span>
              </div>
            </div>

            <div style={{ minWidth: 210 }}>
              {nextSlot ? (
                <div
                  className="alert alert-success"
                  style={{ padding: "0.6rem 0.8rem" }}
                >
                  <span>🕐</span>
                  <div className="small">
                    <strong>Next available</strong>
                    <div>
                      {formatDay(nextSlot.nextAvailableSlot.date)} at{" "}
                      {formatTime(nextSlot.nextAvailableSlot.time)}
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  className="alert alert-warning"
                  style={{ padding: "0.6rem 0.8rem" }}
                >
                  <span>⚠️</span>
                  <div className="small">
                    No open slots in the next two weeks
                  </div>
                </div>
              )}
              <button
                type="button"
                className="btn btn-primary btn-block"
                style={{ marginTop: "0.6rem" }}
                onClick={() => setTab("book")}
              >
                Book appointment
              </button>
            </div>
          </div>
        </div>

        <Tabs
          tabs={[
            { key: "overview", label: "Overview" },
            { key: "book", label: "Book" },
            { key: "slots", label: "Availability" },
          ]}
          active={tab}
          onChange={setTab}
        />

        <div className="split">
          <div className="stack">
            {tab === "overview" && (
              <>
                <div className="card card-pad">
                  <h3>About</h3>
                  <p className="small">{doctor.bio}</p>
                  <div className="divider" />
                  <div className="grid grid-3">
                    <Stat
                      label="Patients treated"
                      value={stats?.patientsTreated ?? "—"}
                    />
                    <Stat
                      label="Repeat rate"
                      value={stats?.repeatRate ?? "—"}
                    />
                    <Stat label="Reviews" value={stats?.totalReviews ?? "—"} />
                  </div>
                </div>

                <div className="card">
                  <div className="card-head">
                    <h3>Services offered</h3>
                  </div>
                  <div className="card-body stack-sm">
                    {services?.length ? (
                      services.map((s) => (
                        <div
                          key={s.id}
                          className="row-between"
                          style={{
                            padding: "0.4rem 0",
                            borderBottom: "1px solid var(--gray-100)",
                          }}
                        >
                          <div>
                            <div className="small bold">{s.name}</div>
                            <div className="tiny muted">{s.description}</div>
                          </div>
                          <div className="right nowrap">
                            <div className="small bold">
                              {currency(s.price, s.currency)}
                            </div>
                            <div className="tiny muted">{s.duration} min</div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="small muted">No services listed.</p>
                    )}
                  </div>
                </div>

                {facility && (
                  <div className="card card-pad">
                    <h3>Location</h3>
                    <div className="stack-sm">
                      <div className="row">
                        <span>🏥</span>
                        <div>
                          <div className="small bold">{facility.name}</div>
                          <div className="tiny muted">{facility.type}</div>
                        </div>
                      </div>
                      <div className="row">
                        <span>📍</span>
                        <div className="small">
                          {facility.address}, {facility.city}
                        </div>
                      </div>
                      <div className="row">
                        <span>🕘</span>
                        <div className="small">{facility.openHours}</div>
                      </div>
                      {facility.queueEnabled && (
                        <div className="row">
                          <span>🚶</span>
                          <div className="small">Walk-in queue supported</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            {tab === "book" && (
              <div className="card">
                <div className="card-head">
                  <h3>Book an appointment</h3>
                </div>
                <div className="card-body">
                  <BookingPanel doctorId={doctor.id} onBooked={load} />
                </div>
              </div>
            )}

            {tab === "slots" && (
              <div className="card">
                <div className="card-head">
                  <h3>Next 14 days</h3>
                </div>
                <div className="card-body stack">
                  {availability?.length ? (
                    availability.map((d) => (
                      <div key={d.date} className="stack-sm">
                        <div className="row-between">
                          <strong className="small">
                            {formatDay(d.date)}{" "}
                            <span className="muted">
                              ({relativeDay(d.date)})
                            </span>
                          </strong>
                          <span className="small muted">
                            {d.available} open / {d.totalSlots} total
                          </span>
                        </div>
                        <ProgressBar
                          value={d.utilizationPercent}
                          tone={
                            d.utilizationPercent > 80
                              ? "danger"
                              : d.utilizationPercent > 50
                                ? "warning"
                                : "success"
                          }
                        />
                        <div
                          className="row tiny muted"
                          style={{ gap: "0.75rem" }}
                        >
                          <span>Booked {d.booked}</span>
                          <span>Blocked {d.blocked}</span>
                          {d.nextAvailableSlot && (
                            <span className="badge badge-success">
                              Next {formatTime(d.nextAvailableSlot.time)}
                            </span>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <EmptyState icon="🗓️" title="No availability published" />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ---------- sidebar ---------- */}
          <div className="stack sticky-side">
            <div className="card card-pad stack-sm">
              <h4 style={{ margin: 0 }}>Consultation</h4>
              <div className="row-between">
                <span className="small muted">Fee</span>
                <strong>{currency(doctor.consultationFee)}</strong>
              </div>
              <div className="row-between">
                <span className="small muted">Modes</span>
                <span className="row" style={{ gap: "0.3rem" }}>
                  <span className="badge badge-brand">In person</span>
                  <span className="badge badge-violet">Video</span>
                </span>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-block"
                onClick={() => setTab("book")}
              >
                Book now
              </button>
            </div>

            {upcomingAppointments?.length > 0 && (
              <div className="card">
                <div className="card-head">
                  <h4>Next appointments</h4>
                </div>
                <div className="card-body stack-sm">
                  {upcomingAppointments.slice(0, 5).map((a) => (
                    <div key={a.id} className="row-between small">
                      <div>
                        <div className="bold">{a.patientName}</div>
                        <div className="tiny muted">
                          {formatDay(a.date)} · {formatTime(a.startTime)}
                        </div>
                      </div>
                      <StatusBadge status={a.status} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
