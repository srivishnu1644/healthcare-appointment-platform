import { useCallback, useEffect, useState } from "react";
import api from "../../api/client";
import { Alert, Avatar, EmptyState, Loading } from "../../components/ui.jsx";
import { colorFrom, formatDate, num } from "../../utils/format";
import { Pagination, SearchInput } from "../../components/admin.jsx";

const PAGE_SIZE = 25;

export default function AdminPatients() {
  const [patients, setPatients] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");

  // Searching happens on the SERVER.
  //
  // The previous version downloaded every patient and filtered in the browser.
  // That is fine for forty rows and not for forty thousand: it sends the whole
  // directory - names, emails, phone numbers, blood groups - over the wire on
  // every visit to a page whose job is to show twenty-five of them. The count
  // shown is now the server's true total, so "page 2" means what it says.
  const load = useCallback(async () => {
    try {
      const res = await api.adminPatients({
        search,
        sort,
        limit: PAGE_SIZE,
        offset,
      });
      setPatients(res.patients || []);
      setTotal(res.total ?? res.count ?? (res.patients || []).length);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [search, sort, offset]);

  useEffect(() => {
    load();
  }, [load]);

  // Any filter change invalidates the page number.
  const changeFilter = (setter) => (value) => {
    setter(value);
    setOffset(0);
  };

  if (loading) return <Loading label="Loading patients…" />;

  const filtered = patients;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="page page-glass-bg">
      <div className="container stack">
        <div className="page-head row-between">
          <div>
            <h1 style={{ marginBottom: "0.15rem" }}>Patients</h1>
            <p className="small muted">
              Appointment behaviour per patient. Passwords are never exposed.
            </p>
          </div>
          <div className="row" style={{ gap: "0.5rem" }}>
            <SearchInput
              value={search}
              onChange={changeFilter(setSearch)}
              placeholder="Search by name, email or phone"
              label="Search patients"
              width={240}
            />
            <select
              className="input"
              style={{ maxWidth: 150 }}
              value={sort}
              onChange={(e) => changeFilter(setSort)(e.target.value)}
              aria-label="Sort patients"
            >
              <option value="name">Name A–Z</option>
              <option value="name_desc">Name Z–A</option>
              <option value="email">Email</option>
              <option value="newest">Newest first</option>
            </select>
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

        {/* The count is the SERVER's, so the page number means something even
            though only this page's rows were sent. */}
        <div className="row-between row-wrap small muted">
          <span>
            {total} patient{total === 1 ? "" : "s"} · page {page} of {pages}
          </span>
          <Pagination
            page={page}
            pages={pages}
            onChange={(p) => setOffset((p - 1) * PAGE_SIZE)}
            label="Patient pages"
          />
        </div>
      </div>
    </div>
  );
}
