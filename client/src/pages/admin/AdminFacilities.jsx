import { useCallback, useEffect, useState } from "react";
import api from "../../api/client";
import { useToast } from "../../context/ToastContext.jsx";
import {
  Alert,
  EmptyState,
  Loading,
  Modal,
  Spinner,
} from "../../components/ui.jsx";
import { currency, num } from "../../utils/format";

export default function AdminFacilities() {
  const toast = useToast();
  const [facilities, setFacilities] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    city: "",
    address: "",
    type: "Hospital",
  });

  const load = useCallback(async () => {
    try {
      const [f, s] = await Promise.all([
        api.adminFacilities(),
        api.adminServices().catch(() => ({ services: [] })),
      ]);
      setFacilities(f.facilities || []);
      setServices(s.services || []);
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

  const submit = async () => {
    setBusy(true);
    try {
      await api.adminCreateFacility({
        name: form.name.trim(),
        city: form.city.trim(),
        address: form.address.trim(),
        type: form.type,
      });
      toast.success("Facility created");
      setOpen(false);
      setForm({ name: "", city: "", address: "", type: "Hospital" });
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading label="Loading facilities…" />;

  return (
    <div className="page">
      <div className="container stack">
        <div className="page-head row-between">
          <div>
            <h1 style={{ marginBottom: "0.15rem" }}>Facilities & services</h1>
            <p className="small muted">
              Healthcare facilities and the services offered.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setOpen(true)}
          >
            + Add facility
          </button>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="grid grid-auto">
          {facilities.length === 0 ? (
            <div className="card">
              <EmptyState icon="🏥" title="No facilities yet" />
            </div>
          ) : (
            facilities.map((f) => (
              <div key={f.id} className="card card-pad stack-sm">
                <div className="row-between">
                  <strong>{f.name}</strong>
                  <span className="badge badge-brand">{f.type}</span>
                </div>
                <div className="tiny muted">
                  {f.address}, {f.city}
                </div>
                <div className="row row-wrap small" style={{ gap: "0.75rem" }}>
                  <span>👨‍⚕️ {f.doctorCount} doctors</span>
                  <span>📅 {num(f.appointmentCount)} appointments</span>
                  {f.rating ? <span>⭐ {f.rating}</span> : null}
                </div>
                <div className="tiny muted">{f.openHours}</div>
              </div>
            ))
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Services</h3>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Description</th>
                  <th className="right">Duration</th>
                  <th className="right">Price</th>
                  <th className="right">Doctors</th>
                </tr>
              </thead>
              <tbody>
                {services.map((s) => (
                  <tr key={s.id}>
                    <td className="bold">{s.name}</td>
                    <td className="muted">{s.description}</td>
                    <td className="right">{s.duration} min</td>
                    <td className="right">{currency(s.price, s.currency)}</td>
                    <td className="right">{s.doctorCount ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add facility"
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={submit}
              disabled={busy || !form.name || !form.city || !form.address}
            >
              {busy ? <Spinner /> : "Create"}
            </button>
          </>
        }
      >
        <div className="stack">
          <div className="field">
            <label className="label" htmlFor="f-name">
              Facility name
            </label>
            <input
              id="f-name"
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="MediCare City Hospital"
            />
          </div>
          <div className="grid grid-2">
            <div className="field">
              <label className="label" htmlFor="f-city">
                City
              </label>
              <input
                id="f-city"
                className="input"
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                placeholder="Bengaluru"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="f-type">
                Type
              </label>
              <select
                id="f-type"
                className="select"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
              >
                <option>Hospital</option>
                <option>Clinic</option>
                <option>Multispeciality</option>
                <option>Diagnostic Centre</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="f-address">
              Address
            </label>
            <input
              id="f-address"
              className="input"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="12 MG Road"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
