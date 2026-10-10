import { useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";
import { Alert, Avatar, Spinner, StatusBadge } from "./ui.jsx";
import { useToast } from "../context/ToastContext.jsx";

/**
 * AI symptom triage.
 *
 * Uses POST /api/ai/triage which returns:
 *   urgency, departments[], summary, followUpQuestions[], redFlags[],
 *   advice, recommendedDoctorIds[], provider
 */
export default function SymptomChecker() {
  const toast = useToast();
  const [text, setText] = useState("");
  const [age, setAge] = useState("");
  const [result, setResult] = useState(null);
  const [doctors, setDoctors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (text.trim().length < 3) {
      setError("Please describe your symptoms in a few more words.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.triage({
        description: text.trim(),
        ...(age ? { age: Number(age) } : {}),
      });
      setResult(res);

      // Hydrate the recommended doctor ids into cards.
      if (res.recommendedDoctorIds?.length) {
        const found = await Promise.all(
          res.recommendedDoctorIds.slice(0, 3).map((id) =>
            api
              .doctor(id)
              .then((d) => d.doctor)
              .catch(() => null),
          ),
        );
        setDoctors(found.filter(Boolean));
      } else {
        setDoctors([]);
      }
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setResult(null);
    setDoctors([]);
    setText("");
  };

  const urgencyTone =
    {
      emergency: "danger",
      urgent: "danger",
      high: "warning",
      moderate: "brand",
      low: "success",
    }[result?.urgency] || "brand";

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>🤖 AI symptom checker</h3>
          <p className="small muted" style={{ margin: 0 }}>
            Describe how you feel and we&apos;ll suggest the right department
            and doctors.
          </p>
        </div>
        {result?.provider && (
          <span className="badge badge-violet">
            {result.provider.startsWith("google") ? "Gemini" : "Rule-based"}
          </span>
        )}
      </div>

      <div className="card-body stack">
        {!result && (
          <>
            {error && <Alert tone="danger">{error}</Alert>}
            <form onSubmit={submit} className="stack">
              <div className="field">
                <label className="label" htmlFor="symptoms">
                  What are you experiencing?
                </label>
                <textarea
                  id="symptoms"
                  className="textarea"
                  placeholder="e.g. I have had chest pain and shortness of breath since yesterday, worse when I walk upstairs."
                  value={text}
                  maxLength={2000}
                  onChange={(e) => setText(e.target.value)}
                />
              </div>
              <div
                className="row"
                style={{ gap: "0.6rem", alignItems: "flex-end" }}
              >
                <div className="field" style={{ maxWidth: 120 }}>
                  <label className="label" htmlFor="age">
                    Age
                  </label>
                  <input
                    id="age"
                    type="number"
                    className="input"
                    placeholder="30"
                    min={1}
                    max={120}
                    value={age}
                    onChange={(e) => setAge(e.target.value)}
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={busy}
                  style={{ flex: 1 }}
                >
                  {busy ? <Spinner /> : "Analyse my symptoms"}
                </button>
              </div>
            </form>

            <div className="tiny muted">
              ⚠️ This is decision support for a prototype, not a medical
              diagnosis. Seek emergency care for severe symptoms.
            </div>
          </>
        )}

        {result && (
          <div className="stack">
            <div
              className={`alert alert-${urgencyTone === "brand" ? "info" : urgencyTone}`}
            >
              <span aria-hidden="true">
                {urgencyTone === "danger"
                  ? "🚨"
                  : urgencyTone === "warning"
                    ? "⚠️"
                    : "ℹ️"}
              </span>
              <div>
                <div
                  className="row"
                  style={{ gap: "0.5rem", marginBottom: "0.15rem" }}
                >
                  <strong style={{ textTransform: "capitalize" }}>
                    {result.urgency} urgency
                  </strong>
                  {result.departments?.map((d) => (
                    <span key={d} className="badge badge-brand">
                      {d}
                    </span>
                  ))}
                </div>
                <div className="small">{result.summary}</div>
              </div>
            </div>

            {result.redFlags?.length > 0 && (
              <Alert tone="danger" title="Warning signs — consider urgent care">
                <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.1rem" }}>
                  {result.redFlags.map((f, i) => (
                    <li key={i} className="small">
                      {f}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}

            {result.advice && (
              <div className="stack-sm">
                <span
                  className="tiny muted bold"
                  style={{ textTransform: "uppercase" }}
                >
                  What to do
                </span>
                <p className="small" style={{ margin: 0 }}>
                  {result.advice}
                </p>
              </div>
            )}

            {result.followUpQuestions?.length > 0 && (
              <div className="stack-sm">
                <span
                  className="tiny muted bold"
                  style={{ textTransform: "uppercase" }}
                >
                  The doctor may ask
                </span>
                <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                  {result.followUpQuestions.map((q, i) => (
                    <li key={i} className="small">
                      {q}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {doctors.length > 0 && (
              <div className="stack-sm">
                <span
                  className="tiny muted bold"
                  style={{ textTransform: "uppercase" }}
                >
                  Recommended doctors
                </span>
                {doctors.map((d) => (
                  <div
                    key={d.id}
                    className="row card"
                    style={{ padding: "0.7rem 0.85rem", boxShadow: "none" }}
                  >
                    <Avatar name={d.name} color={d.imageColor} size="sm" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="small bold truncate">{d.name}</div>
                      <div className="tiny muted truncate">
                        {d.specialtyName} · {d.facilityName}
                      </div>
                    </div>
                    <Link
                      to={`/doctors/${d.id}`}
                      className="btn btn-secondary btn-sm nowrap"
                    >
                      Book
                    </Link>
                  </div>
                ))}
              </div>
            )}

            <div className="row" style={{ gap: "0.5rem" }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={reset}
              >
                Start over
              </button>
              <Link to="/doctors" className="btn btn-ghost btn-sm">
                Browse all doctors →
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
