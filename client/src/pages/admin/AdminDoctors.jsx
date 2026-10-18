import { useCallback, useEffect, useState } from "react";
import api from "../../api/client";
import { useToast } from "../../context/ToastContext.jsx";
import {
  Alert,
  Avatar,
  EmptyState,
  Loading,
  Modal,
  Spinner,
} from "../../components/ui.jsx";
import { currency } from "../../utils/format";

export default function AdminDoctors() {
  const toast = useToast();
  const [doctors, setDoctors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null);
  const [fee, setFee] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await api.adminDoctors();
      setDoctors(res.doctors || []);
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

  const saveFee = async () => {
    setBusy(true);
    try {
      await api.adminUpdateDoctor(edit.id, { consultationFee: Number(fee) });
      toast.success("Consultation fee updated");
      setEdit(null);
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleAccepting = async (d) => {
    setBusy(true);
    try {
      await api.adminUpdateDoctor(d.id, { isAcceptingNew: !d.isAcceptingNew });
      toast.success(
        `${d.name} is now ${!d.isAcceptingNew ? "accepting" : "not accepting"} patients`,
      );
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading label="Loading doctors…" />;

  const filtered = search
    ? doctors.filter((d) =>
        [d.name, d.specialtyName, d.city, d.email].some((v) =>
          String(v ?? "")
            .toLowerCase()
            .includes(search.toLowerCase()),
        ),
      )
    : doctors;

  return (
    <div className="page page-glass-bg">
      <div className="container stack">
        <div className="page-head row-between">
          <div>
            <h1 style={{ marginBottom: "0.15rem" }}>Doctors</h1>
            <p className="small muted">
              Manage fees and accepting-new-patient status.
            </p>
          </div>
          <div className="row" style={{ gap: "0.5rem" }}>
            <input
              className="input"
              placeholder="Search doctors…"
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
                  <th>Doctor</th>
                  <th>Specialty</th>
                  <th>Location</th>
                  <th className="right">Fee</th>
                  <th className="right">Rating</th>
                  <th>Status</th>
                  <th className="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <div className="row">
                        <Avatar name={d.name} color={d.imageColor} size="sm" />
                        <div style={{ minWidth: 0 }}>
                          <div className="bold">{d.name}</div>
                          <div className="tiny muted">{d.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="muted">{d.specialtyName}</td>
                    <td className="muted">{d.city}</td>
                    <td className="right">{currency(d.consultationFee)}</td>
                    <td className="right">⭐ {d.rating}</td>
                    <td>
                      <span
                        className={`badge ${d.isAcceptingNew ? "badge-success" : ""}`}
                      >
                        {d.isAcceptingNew ? "Accepting" : "Paused"}
                      </span>
                    </td>
                    <td className="right">
                      <div
                        className="row"
                        style={{ gap: "0.35rem", justifyContent: "flex-end" }}
                      >
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setEdit(d);
                            setFee(String(d.consultationFee));
                          }}
                        >
                          Fee
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => toggleAccepting(d)}
                          disabled={busy}
                        >
                          {d.isAcceptingNew ? "Pause" : "Resume"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && (
            <EmptyState icon="🔍" title="No doctors match your search" />
          )}
        </div>
      </div>

      <Modal
        open={Boolean(edit)}
        onClose={() => setEdit(null)}
        title={`Consultation fee — ${edit?.name ?? ""}`}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setEdit(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={saveFee}
              disabled={busy || !fee || Number(fee) < 0}
            >
              {busy ? <Spinner /> : "Save"}
            </button>
          </>
        }
      >
        <div className="field">
          <label className="label" htmlFor="fee">
            Fee (INR)
          </label>
          <input
            id="fee"
            type="number"
            className="input"
            min={0}
            step={50}
            value={fee}
            onChange={(e) => setFee(e.target.value)}
          />
        </div>
      </Modal>
    </div>
  );
}
