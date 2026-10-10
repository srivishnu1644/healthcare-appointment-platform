import { useCallback, useEffect, useState } from "react";
import api from "../../api/client";
import { Alert, Avatar, EmptyState, Loading } from "../../components/ui.jsx";
import { colorFrom, formatDate, num } from "../../utils/format";

export default function AdminPatients() {
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await api.adminPatients();
      setPatients(res.patients || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading label="Loading patients…" />;

  const filtered = search
    ? patients.filter((p) =>
        [p.name, p.email, p.bloodGroup].some((v) =>
          String(v ?? "")
            .toLowerCase()
            .includes(search.toLowerCase()),
        ),
      )
    : patients;

  return (
    <div className="page">
      <div className="container stack">
        <div className="page-head row-between">
          <div>
            <h1 style={{ marginBottom: "0.15rem" }}>Patients</h1>
            <p className="small muted">
              Appointment behaviour per patient. Passwords are never exposed.
            </p>
          </div>
          <div className="row" style={{ gap: "0.5rem" }}>
            <input
              className="input"
              placeholder="Search patients…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 220 }}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={load}
            >
              Refresh
            </button>
          </div>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Contact</th>
                  <th>Blood group</th>
                  <th>Allergies</th>
                  <th className="right">Total</th>
                  <th className="right">Completed</th>
                  <th className="right">No-show</th>
                  <th className="right">Cancelled</th>
                  <th className="right">Last visit</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="row">
                        <Avatar
                          name={p.name}
                          color={colorFrom(p.email)}
                          size="sm"
                        />
                        <strong>{p.name}</strong>
                      </div>
                    </td>
                    <td>
                      <div className="tiny">{p.email}</div>
                      <div className="tiny muted">{p.phone}</div>
                    </td>
                    <td>
                      {p.bloodGroup ? (
                        <span className="badge">{p.bloodGroup}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {p.allergies?.length ? (
                        <span className="badge badge-danger">
                          {p.allergies.join(", ")}
                        </span>
                      ) : (
                        <span className="muted">None</span>
                      )}
                    </td>
                    <td className="right">{p.totalAppointments}</td>
                    <td className="right" style={{ color: "var(--success)" }}>
                      {p.completed}
                    </td>
                    <td className="right" style={{ color: "var(--warning)" }}>
                      {p.noShow}
                    </td>
                    <td className="right" style={{ color: "var(--danger)" }}>
                      {p.cancelled}
                    </td>
                    <td className="right muted">
                      {p.lastVisit ? formatDate(p.lastVisit) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && (
            <EmptyState icon="🔍" title="No patients match your search" />
          )}
        </div>
      </div>
    </div>
  );
}
