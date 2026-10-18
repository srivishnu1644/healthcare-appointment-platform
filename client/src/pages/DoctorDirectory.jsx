import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "../api/client";
import { DoctorCard } from "../components/DoctorCard.jsx";
import { EmptyState, SkeletonCard, Alert } from "../components/ui.jsx";
import { currency, cx, num } from "../utils/format";

/**
 * Sort options offered in the UI.
 *
 * These keys are sent verbatim as ?sort= and are checked against an enum by the
 * API, so every value here must be one the server accepts. The list used to
 * include `relevance`, which the server does not implement: the request was
 * rejected with 422 and the directory rendered nothing at all.
 *
 * There is no relevance ranking server-side. When `sort` is absent the API
 * falls back to rating descending, then review count — identical to the
 * `rating` option — so "Best match" was never anything else. Dropping it is
 * honest; sending `rating` and labelling it "Best match" would have been a lie
 * with two identical options.
 *
 * `soonest` is also accepted by the API but is not offered here yet.
 */
const SORTS = [
  { key: "rating", label: "Highest rated" },
  { key: "fee-low", label: "Fee: low to high" },
  { key: "experience", label: "Most experienced" },
];

const SORT_KEYS = SORTS.map((s) => s.key);

/** The default ordering, which is also what the API uses when sort is absent. */
const DEFAULT_SORT = "rating";

/**
 * Coerce any sort value into one the API accepts.
 *
 * Bookmarkable URLs can carry a value this build no longer offers — including
 * `?sort=relevance` from before the fix. Sending it through unchanged would
 * reproduce the original 422, so anything unrecognised falls back to the
 * default rather than failing the whole request.
 */
const normaliseSort = (value) =>
  SORT_KEYS.includes(value) ? value : DEFAULT_SORT;

export default function DoctorDirectory() {
  const [params, setParams] = useSearchParams();

  const [search, setSearch] = useState(params.get("q") || "");
  const [filters, setFilters] = useState({
    specialty: params.get("specialty") || "",
    city: params.get("city") || "",
    maxFee: params.get("maxFee") || "",
    minRating: params.get("minRating") || "",
    language: params.get("language") || "",
    mode: params.get("mode") || "",
    acceptingOnly: params.get("acceptingOnly") === "true",
    sort: normaliseSort(params.get("sort")),
  });

  const [meta, setMeta] = useState({ cities: [], specialties: [] });
  const [doctors, setDoctors] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const setFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }));

  const runSearch = useCallback(
    async (override) => {
      setLoading(true);
      setError(null);
      try {
        const query = {
          ...(override || filters),
          ...(search ? { search } : {}),
        };
        const res = await api.doctors(query);
        setDoctors(res.doctors || []);
        setTotal(res.total ?? res.count ?? 0);
        setMeta(res.filters || { cities: [], specialties: [] });
      } catch (err) {
        setError(err.message);
        setDoctors([]);
      } finally {
        setLoading(false);
      }
    },
    [filters, search],
  );

  // Keep the URL shareable/bookmarkable.
  useEffect(() => {
    const next = {};
    if (search) next.q = search;
    Object.entries(filters).forEach(([k, v]) => {
      if (v && v !== DEFAULT_SORT && v !== false) next[k] = String(v);
    });
    setParams(next, { replace: true });
  }, [filters, search, setParams]);

  useEffect(() => {
    const t = setTimeout(() => runSearch(), 250);
    return () => clearTimeout(t);
  }, [runSearch]);

  const clearAll = () => {
    setSearch("");
    setFilters({
      specialty: "",
      city: "",
      maxFee: "",
      minRating: "",
      language: "",
      mode: "",
      acceptingOnly: false,
      sort: DEFAULT_SORT,
    });
  };

  const activeCount =
    Object.entries(filters).filter(
      ([k, v]) =>
        v && v !== DEFAULT_SORT && !(k === "acceptingOnly" && v === false),
    ).length + (search ? 1 : 0);

  return (
    <div className="page page-glass-bg">
      <div className="container">
        <div className="split-left">
          {/* ---------------- filters ---------------- */}
          <aside className="card card-pad stack sticky-side">
            <div className="row-between">
              <strong className="small">Filters</strong>
              {activeCount > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={clearAll}
                >
                  Clear ({activeCount})
                </button>
              )}
            </div>

            <div className="field">
              <label className="label" htmlFor="f-search">
                Search
              </label>
              <input
                id="f-search"
                className="input"
                placeholder="Name or facility"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="f-spec">
                Specialization
              </label>
              <select
                id="f-spec"
                className="select"
                value={filters.specialty}
                onChange={(e) => setFilter("specialty", e.target.value)}
              >
                <option value="">All specialties</option>
                {(meta.specialties || []).map((s) =>
                  typeof s === "string" ? (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ) : (
                    <option key={s.id || s.name} value={s.name || s}>
                      {s.name || s}
                    </option>
                  ),
                )}
              </select>
            </div>

            <div className="field">
              <label className="label" htmlFor="f-city">
                City
              </label>
              <select
                id="f-city"
                className="select"
                value={filters.city}
                onChange={(e) => setFilter("city", e.target.value)}
              >
                <option value="">All cities</option>
                {(meta.cities || []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="label" htmlFor="f-fee">
                Fees Range
              </label>
              <input
                id="f-fee"
                type="number"
                className="input"
                placeholder="e.g. 1000"
                min={0}
                value={filters.maxFee}
                onChange={(e) => setFilter("maxFee", e.target.value)}
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="f-rating">
                Minimum rating
              </label>
              <select
                id="f-rating"
                className="select"
                value={filters.minRating}
                onChange={(e) => setFilter("minRating", e.target.value)}
              >
                <option value="">Any rating</option>
                <option value="4">4.0 and above</option>
                <option value="4.5">4.5 and above</option>
              </select>
            </div>

            <div className="field">
              <label className="label" htmlFor="f-lang">
                Language
              </label>
              <select
                id="f-lang"
                className="select"
                value={filters.language}
                onChange={(e) => setFilter("language", e.target.value)}
              >
                <option value="">Any language</option>
                <option value="English">English</option>
                <option value="Hindi">Hindi</option>
                <option value="Kannada">Kannada</option>
              </select>
            </div>

            <div className="field">
              <label className="label" htmlFor="f-mode">
                Consultation Type
              </label>
              <select
                id="f-mode"
                className="select"
                value={filters.mode}
                onChange={(e) => setFilter("mode", e.target.value)}
              >
                <option value="">Any mode</option>
                <option value="in-person">In person</option>
                <option value="video">Video</option>
              </select>
            </div>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={filters.acceptingOnly}
                onChange={(e) => setFilter("acceptingOnly", e.target.checked)}
              />
              Accepting new patients only
            </label>
          </aside>

          {/* ---------------- results ---------------- */}
          <div className="stack">
            <div className="row-between">
              <div>
                <h1 style={{ margin: 0 }}>Doctors</h1>
                <p className="small muted" style={{ margin: 0 }}>
                  {loading
                    ? "Searching…"
                    : `Found ${num(total)} doctors`}
                </p>
              </div>
              <div className="row" style={{ gap: "0.5rem" }}>
                <label className="small muted" htmlFor="sort">
                  Sort by:
                </label>
                <select
                  id="sort"
                  className="select"
                  style={{ width: "auto" }}
                  value={filters.sort}
                  onChange={(e) => setFilter("sort", e.target.value)}
                >
                  {SORTS.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {error && <Alert tone="danger">{error}</Alert>}

            {loading ? (
              <div className="stack">
                {Array.from({ length: 4 }).map((_, i) => (
                  <SkeletonCard key={i} height={150} />
                ))}
              </div>
            ) : doctors.length === 0 ? (
              <div className="card">
                <EmptyState
                  icon="🔍"
                  title="No doctors match your filters"
                  message="Try widening the fee range or clearing the specialty filter."
                  action={
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={clearAll}
                    >
                      Clear all filters
                    </button>
                  }
                />
              </div>
            ) : (
              <div className="stack">
                {doctors.map((d) => (
                  <DoctorCard key={d.id} doctor={d} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
