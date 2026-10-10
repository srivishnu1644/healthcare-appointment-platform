import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "../api/client";
import { DoctorCard } from "../components/DoctorCard.jsx";
import { EmptyState, SkeletonCard, Alert } from "../components/ui.jsx";
import { currency, cx, num } from "../utils/format";

const SORTS = [
  { key: "relevance", label: "Best match" },
  { key: "rating", label: "Highest rated" },
  { key: "fee-low", label: "Fee: low to high" },
  { key: "experience", label: "Most experienced" },
];

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
    sort: params.get("sort") || "relevance",
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
      if (v && v !== "relevance" && v !== false) next[k] = String(v);
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
      sort: "relevance",
    });
  };

  const activeCount =
    Object.entries(filters).filter(
      ([k, v]) =>
        v && v !== "relevance" && !(k === "acceptingOnly" && v === false),
    ).length + (search ? 1 : 0);

  return (
    <div className="page">
      <div className="container">
        <div className="page-head">
          <h1>Find a doctor</h1>
          <p>
            {loading
              ? "Searching…"
              : `${num(total)} specialist(s) match your filters`}
          </p>
        </div>

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
                Specialty
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
                Max consultation fee
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
                Consultation mode
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
              <span className="small muted">
                {loading ? "Loading…" : `${num(doctors.length)} shown`}
              </span>
              <div className="row" style={{ gap: "0.5rem" }}>
                <label className="small muted" htmlFor="sort">
                  Sort
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
              <div className="grid grid-auto">
                {Array.from({ length: 6 }).map((_, i) => (
                  <SkeletonCard key={i} height={170} />
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
              <div className="grid grid-auto">
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
