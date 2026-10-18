import { useCallback, useEffect, useMemo, useState } from "react";

import api from "../../api/client";
import { Alert, EmptyState, Loading, StatusBadge } from "../../components/ui.jsx";
import { Pagination, SearchInput } from "../../components/admin.jsx";
import { relativeDay } from "../../utils/format";

/**
 * Cross-clinic appointment view.
 *
 * READ-ONLY on purpose. An administrator can see every appointment in the
 * platform and search it, but cannot change one here: a mutation goes through
 * /appointments/:id/status, which enforces the same ownership, transition and
 * lock rules a provider gets. An admin screen that wrote directly would be a way
 * around all of them, which is precisely what Phase 12 must not introduce.
 *
 * The filters mirror what the endpoint actually supports, so the page cannot ask
 * for something the server will silently ignore.
 */
const STATUSES = [
  "scheduled",
  "confirmed",
  "in-progress",
  "completed",
  "cancelled",
  "no-show",
];

const SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "patient", label: "Patient A–Z" },
  { value: "doctor", label: "Doctor A–Z" },
  { value: "status", label: "Status" },
];

const PAGE_SIZE = 25;

export default function AdminAppointments() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState("newest");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      // First paint shows the skeleton; a filter change keeps the current rows on
      // screen instead of blanking the table on every keystroke.
      if (quiet) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await api.adminAppointments({
          search,
          status,
          from,
          to,
          sort,
          limit: PAGE_SIZE,
          offset,
        });
        setRows(res.appointments ?? []);
        setTotal(res.total ?? 0);
        setError(null);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [search, status, from, to, sort, offset],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Any filter change invalidates the current page number, so changing a filter
  // while on page 4 lands on page 1 rather than an empty result.
  const changeFilter = (setter) => (value) => {
    setter(value);
    setOffset(0);
  };

  const filtersActive = Boolean(search || status || from || to || sort !== "newest");
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const summary = useMemo(() => {
    const queued = rows.filter((r) => r.queueState === "waiting").length;
    const active = rows.filter((r) => r.queueState === "in-consultation").length;
    return { queued, active };
  }, [rows]);

  if (loading) return <Loading label="Loading appointments…" />;

  return (
    <div className="page page-glass-bg">
      <div className="container stack">
        <div className="page-head row-between row-wrap">
          <div>
            <h1 style={{ marginBottom: "0.15rem" }}>Appointments</h1>
            <p className="small muted" style={{ margin: 0 }}>
              Every appointment across the platform.{" "}
              {total > 0 ? `${total} match${total === 1 ? "es" : ""}.` : ""}
            </p>
          </div>
          <div className="row row-wrap" style={{ gap: "0.5rem" }}>
            {refreshing && <span className="tiny muted">Updating…</span>}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => load({ quiet: true })}
              disabled={refreshing}
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="card card-pad">
          <div className="row row-wrap" style={{ gap: "0.6rem" }}>
            <SearchInput
              value={search}
              onChange={changeFilter(setSearch)}
              placeholder="Search patient, doctor, email or id"
              label="Search appointments"
            />
            <select
              className="input"
              style={{ maxWidth: 170 }}
              value={status}
              onChange={(e) => changeFilter(setStatus)(e.target.value)}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/-/g, " ")}
                </option>
              ))}
            </select>
            <input
              type="date"
              className="input"
              style={{ maxWidth: 160 }}
              value={from}
              onChange={(e) => changeFilter(setFrom)(e.target.value)}
              aria-label="From date"
            />
            <input
              type="date"
              className="input"
              style={{ maxWidth: 160 }}
              value={to}
              onChange={(e) => changeFilter(setTo)(e.target.value)}
              aria-label="To date"
            />
            <select
              className="input"
              style={{ maxWidth: 190 }}
              value={sort}
              onChange={(e) => changeFilter(setSort)(e.target.value)}
              aria-label="Sort by"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            {filtersActive && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setSearch("");
                  setStatus("");
                  setFrom("");
                  setTo("");
                  setSort("newest");
                  setOffset(0);
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {error && (
          <Alert tone="danger">
            {error}{" "}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => load({ quiet: true })}
            >
              Retry
            </button>
          </Alert>
        )}

        {rows.length === 0 ? (
          <div className="card">
            <EmptyState
              icon="📅"
              title={filtersActive ? "Nothing matches those filters" : "No appointments yet"}
              message={
                filtersActive
                  ? "Try widening the date range, or clearing the search."
                  : "Appointments appear here as patients book them."
              }
              action={
                filtersActive ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setSearch("");
                      setStatus("");
                      setFrom("");
                      setTo("");
                      setSort("newest");
                      setOffset(0);
                    }}
                  >
                    Clear filters
                  </button>
                ) : null
              }
            />
          </div>
        ) : (
          <>
            <div className="card">
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Patient</th>
                      <th scope="col">Doctor</th>
                      <th scope="col">Mode</th>
                      <th scope="col">Status</th>
                      <th scope="col">Queue</th>
                      <th scope="col">Fee</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <div className="small nowrap">
                            {/* relativeDay wants an ISO instant; the API also
                                sends the clinic-zone calendar date, which is what
                                the patient actually booked. */}
                            {relativeDay(a.startsAt ?? a.date) || a.date}
                          </div>
                          <div className="tiny muted nowrap">{a.startTime}</div>
                        </td>
                        <td>
                          <div className="small truncate">{a.patientName}</div>
                          <div className="tiny muted truncate">{a.patientEmail}</div>
                        </td>
                        <td className="small truncate">{a.doctorName}</td>
                        <td className="small nowrap">{a.mode === "video" ? "Video" : "In person"}</td>
                        <td>
                          <StatusBadge status={a.status} />
                        </td>
                        <td className="small nowrap">
                          {a.queueState === "waiting" ? (
                            <span className="badge badge-info">
                              waiting{a.roomPosition ? ` #${a.roomPosition}` : ""}
                            </span>
                          ) : a.queueState === "in-consultation" ? (
                            <span className="badge badge-violet">in consultation</span>
                          ) : (
                            <span className="tiny muted">—</span>
                          )}
                        </td>
                        <td className="small nowrap">₹{Number(a.fee ?? 0).toLocaleString("en-IN")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="row-between row-wrap small muted">
              <span>
                {summary.queued > 0 || summary.active > 0
                  ? `${summary.queued} waiting and ${summary.active} in consultation on this page. `
                  : ""}
                Page {page} of {pages}.
              </span>
              <Pagination
                page={page}
                pages={pages}
                onChange={(p) => setOffset((p - 1) * PAGE_SIZE)}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}