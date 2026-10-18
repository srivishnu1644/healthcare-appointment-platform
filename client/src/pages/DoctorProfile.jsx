import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import api from "../api/client";
import { BookingPanel } from "../components/DoctorCard.jsx";
import {
  Alert,
  DoctorPhoto,
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
    // Blank the page only for the FIRST load. After a booking the panel calls
    // back to refresh the profile, and replacing the page with a full-page
    // spinner would unmount BookingPanel — destroying the confirmation it has
    // just been told to show. A refresh keeps what is already on screen.
    if (!data) setLoading(true);
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

  const goBook = () => {
    setTab("book");
    document
      .getElementById("doc-profile-tabs")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

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

  const facts = [
    doctor.rating ? `⭐ ${doctor.rating} · ${doctor.reviewCount ?? 0} reviews` : null,
    doctor.experience ? `🕐 ${doctor.experience} yrs experience` : null,
    facility
      ? `📍 ${facility.name}, ${facility.city}`
      : [doctor.qualification, doctor.facilityName].filter(Boolean).join(" · ") || null,
    doctor.languages?.length ? `🗣 ${doctor.languages.join(", ")}` : null,
  ].filter(Boolean);

  return (
    <div className="page doc-profile-page">
      <div className="container stack">
        <Link
          to="/doctors"
          className="btn btn-ghost btn-sm"
          style={{ alignSelf: "flex-start" }}
        >
          ← Back to search
        </Link>

        {/* ---------- profile header ---------- */}
        <div className="card doc-profile-cover">
          <div className="doc-profile-head">
            <DoctorPhoto
              doctor={doctor}
              size="xl"
              className="doc-profile-photo"
            />

            <div className="doc-profile-info">
              <div className="row row-wrap" style={{ gap: "0.5rem" }}>
                {doctor.isAcceptingNew ? (
                  <span className="badge badge-success">
                    <span className="dot dot-pulse" /> Accepting patients
                  </span>
                ) : (
                  <span className="badge">Not accepting</span>
                )}
                <span className="badge badge-brand">{doctor.specialtyName}</span>
              </div>
              <h1 className="doc-profile-name">{doctor.name}</h1>
              <div className="doc-profile-facts">
                {facts.map((f) => (
                  <span key={f} className="doc-profile-fact">
                    {f}
                  </span>
                ))}
              </div>
            </div>

            <div className="doc-profile-cta">
              <button
                type="button"
                className="btn btn-primary"
                onClick={goBook}
                disabled={!doctor.isAcceptingNew}
              >
                Book appointment
              </button>
            </div>
          </div>
        </div>

        <div id="doc-profile-tabs">
          <Tabs
            tabs={[
              { key: "overview", label: "Overview" },
              { key: "book", label: "Book" },
              { key: "slots", label: "Availability" },
            ]}
            active={tab}
            onChange={setTab}
          />
        </div>

        <div className="split">
          <div className="stack">
            {tab === "overview" && (
              <>
                <div className="card card-pad">
                  <h3>About</h3>
                  <p className="small">{doctor.bio}</p>
                  {services?.length > 0 && (
                    <>
                      <div className="divider" />
                      <h4 style={{ marginBottom: "0.5rem" }}>Specializations</h4>
                      <div className="mock-pills">
                        {services.map((s) => (
                          <span key={s.id} className="oris-chip">{s.name}</span>
                        ))}
                      </div>
                    </>
                  )}
                  <div className="divider" />
                  <h4 style={{ marginBottom: "0.5rem" }}>Consultation details</h4>
                  <div className="doc-profile-details">
                    <div className="doc-profile-detail">
                      <span aria-hidden="true">💰</span>
                      <div>
                        <div className="bold">{currency(doctor.consultationFee)}</div>
                        <div className="tiny muted">Consultation fee</div>
                      </div>
                    </div>
                    <div className="doc-profile-detail">
                      <span aria-hidden="true">⏱</span>
                      <div>
                        <div className="bold">{services?.[0]?.duration ?? 30} mins</div>
                        <div className="tiny muted">Average consultation</div>
                      </div>
                    </div>
                  </div>
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
                    <h3>Clinic location</h3>
                    <div className="doc-profile-location">
                      <div className="row">
                        <span aria-hidden="true">🏥</span>
                        <div>
                          <div className="small bold">{facility.name}</div>
                          <div className="tiny muted">{facility.type}</div>
                        </div>
                      </div>
                      <div className="row">
                        <span aria-hidden="true">📍</span>
                        <div className="small">
                          {facility.address}, {facility.city}
                        </div>
                      </div>
                      <div className="row">
                        <span aria-hidden="true">🕘</span>
                        <div className="small">{facility.openHours}</div>
                      </div>
                      {facility.queueEnabled && (
                        <div className="row">
                          <span aria-hidden="true">🚶</span>
                          <div className="small">
                            Walk-in queue supported — check in on arrival
                          </div>
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
                  <div>
                    <h3>Book an appointment</h3>
                    <p className="small muted" style={{ margin: 0 }}>
                      With {doctor.name} · {currency(doctor.consultationFee)}
                    </p>
                  </div>
                </div>
                <div className="card-body">
                  <BookingPanel
                    doctorId={doctor.id}
                    doctor={doctor}
                    onBooked={load}
                  />
                </div>
              </div>
            )}

            {tab === "slots" && (
              <div className="card">
                <div className="card-head">
                  <div>
                    <h3>Availability</h3>
                    <p className="small muted" style={{ margin: 0 }}>
                      Open slots across the next 14 days
                    </p>
                  </div>
                </div>
                <div className="card-body stack">
                  {availability?.length ? (
                    availability.map((d) => (
                      <div key={d.date} className="doc-profile-day">
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

          {/* ---------- sticky booking summary ---------- */}
          <div className="stack sticky-side">
            <div className="card card-pad doc-profile-bookcard">
              <div className="tiny muted bold doc-profile-bookcard-eyebrow">
                BOOK A VISIT
              </div>
              <div className="doc-profile-fee">
                {currency(doctor.consultationFee)}
              </div>
              <div className="tiny muted">per consultation</div>
              <div className="divider" />
              <div className="stack-sm small">
                <div className="row-between">
                  <span className="muted">Availability</span>
                  <strong>Live slots</strong>
                </div>
                <div className="row-between">
                  <span className="muted">Modes</span>
                  <strong>In-person &amp; video</strong>
                </div>
                <div className="row-between">
                  <span className="muted">Status</span>
                  {doctor.isAcceptingNew ? (
                    <span className="badge badge-success">Accepting</span>
                  ) : (
                    <span className="badge">Not accepting</span>
                  )}
                </div>
              </div>
              <p className="tiny muted center" style={{ marginTop: "0.6rem" }}>
                Slots update in real time.
              </p>
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
