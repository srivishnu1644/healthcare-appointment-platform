import { useCallback, useEffect, useState } from "react";

import api from "../../api/client";
import { Alert, EmptyState, Loading } from "../../components/ui.jsx";
import { Pagination } from "../../components/admin.jsx";
import { relativeDay } from "../../utils/format";

/**
 * Live waiting-room monitoring.
 *
 * Deliberately read-only. The doctor dashboard owns moving a room along, through
 * the same endpoints a provider uses. An admin screen that could call "next" from
 * here would be a second path to the room's advisory lock, and the locking
 * contract in queueService assumes there is only one caller per room.
 *
 * Polls rather than sitting still, because the question this page answers -
 * "is anyone waiting?" - is only interesting while it changes.
 */

const POLL_MS = 15000;
const PAGE_SIZE = 25;

export default function AdminQueue() {
  const [data, setData] = useState(null);
  const [scheduler, setScheduler] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [offset, setOffset] = useState(0);
  const [paused, setPaused] = useState(false);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!quiet) setLoading(true);
      try {
        const [rooms, sched] = await Promise.all([
          api.adminQueue({ limit: PAGE_SIZE, offset }),
          api.adminScheduler().catch(() => null),
        ]);
        setData(rooms);
        setScheduler(sched);
        setError(null);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [offset],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Polling, matching the notification provider's rules: one timer for this
  // component, never overlapping itself, paused while the tab is hidden, and
  // torn down on unmount.
  useEffect(() => {
    if (paused) return undefined;
    let timer = null;
    let cancelled = false;

    const tick = async () => {
      if (!document.hidden && !cancelled) await load({ quiet: true });
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load, paused]);

  if (loading) return <Loading label="Loading waiting rooms…" />;

  const rooms = data?.rooms ?? [];
  const total = data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const deliveries = scheduler?.notifications?.deliveries ?? {};

  return (
    <div className="page page-glass-bg">
      <div className="container stack">
        <div className="page-head row-between row-wrap">
          <div>
            <h1 style={{ marginBottom: "0.15rem" }}>Waiting rooms</h1>
            <p className="small muted" style={{ margin: 0 }}>
              Every provider with somebody in the room. Updates itself.
            </p>
          </div>
          <div className="row row-wrap" style={{ gap: "0.5rem" }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPaused((p) => !p)}
              aria-pressed={paused}
            >
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => load({ quiet: true })}
            >
              Refresh
            </button>
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

        {scheduler && (
          <div className="row row-wrap small muted" style={{ gap: "0.75rem" }}>
            <span>
              Background passes:{" "}
              <strong>{scheduler.running ? "running" : "stopped"}</strong>
            </span>
            <span>
              Outbox: {deliveries.queued ?? 0} queued · {deliveries.failed ?? 0} failed
            </span>
            {scheduler.lastRun && (
              <span>
                Last reminder sweep: {scheduler.lastRun.processed ?? 0} sent
              </span>
            )}
          </div>
        )}

        {rooms.length === 0 ? (
          <div className="card">
            <EmptyState
              icon="🕒"
              title="Nobody is waiting"
              message="A room appears here as soon as a patient checks in."
            />
          </div>
        ) : (
          <>
            <div className="card">
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Provider</th>
                      <th scope="col">Day</th>
                      <th scope="col">Waiting</th>
                      <th scope="col">In consultation</th>
                      <th scope="col">Oldest waiting</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rooms.map((r) => (
                      <tr key={`${r.doctorId}-${r.clinicDate}`}>
                        <td className="small truncate">{r.doctorName}</td>
                        <td className="small nowrap">{relativeDay(r.clinicDate) || r.clinicDate}</td>
                        <td>
                          {r.waiting > 0 ? (
                            <span className="badge badge-info">{r.waiting} waiting</span>
                          ) : (
                            <span className="tiny muted">—</span>
                          )}
                        </td>
                        <td>
                          {r.activeConsultation ? (
                            <span className="badge badge-violet">
                              {r.activeConsultation.patientName}
                            </span>
                          ) : (
                            <span className="tiny muted">—</span>
                          )}
                        </td>
                        <td className="small nowrap">
                          {r.oldestWaitingAt
                            ? new Date(r.oldestWaitingAt).toLocaleTimeString()
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {pages > 1 && (
              <div className="row-between row-wrap small muted">
                <span>
                  Page {page} of {pages} · {total} room(s)
                </span>
                <Pagination
                  page={page}
                  pages={pages}
                  onChange={(p) => setOffset((p - 1) * PAGE_SIZE)}
                  label="Waiting room pages"
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}