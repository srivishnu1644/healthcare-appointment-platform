import { useEffect, useState } from "react";
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
 *
 * WHY THIS ASKS TWICE
 * -------------------
 * When the API has an AI model configured, the description a patient types is sent
 * to that model - a third party, outside this application. That was happening on
 * a single click with nothing on screen saying so, which is not consent and is
 * not informed either.
 *
 * So the first press stops and shows exactly what would be sent and who would
 * receive it; only the second press transmits anything. The server enforces this
 * too: `/ai/triage` refuses with CONSENT_REQUIRED when consent is absent and a
 * model is configured, so the rule cannot be bypassed by another client.
 *
 * When no model is configured the whole engine is local and rule-based, nothing
 * leaves the machine, and the extra step is skipped - asking to consent to a
 * disclosure that is not happening would be noise.
 */
export default function SymptomChecker() {
  const toast = useToast();
  const [text, setText] = useState("");
  const [age, setAge] = useState("");
  const [result, setResult] = useState(null);
  const [doctors, setDoctors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Set after the first press, when an external model is in play.
  const [confirming, setConfirming] = useState(false);
  const [sendsRemotely, setSendsRemotely] = useState(false);

  const runTriage = async (consent) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.triage({
        description: text.trim(),
        ...(age ? { age: Number(age) } : {}),
        // Sent either way; the server only requires it when a model is configured.
        consent,
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
      setConfirming(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (text.trim().length < 3) {
      setError("Please describe your symptoms in a few more words.");
      return;
    }
    // Ask first, transmit second - and only when something would actually be sent
    // somewhere else.
    if (!confirming && sendsRemotely) {
      setConfirming(true);
      return;
    }
    await runTriage(true);
  };

  const reset = () => {
    setResult(null);
    setDoctors([]);
    setText("");
    setConfirming(false);
    setError(null);
  };

  // Whether an external model is configured, so the disclosure can be shown only
  // when it is true. Falls back to showing it, because under-disclosing is the
  // worse failure.
  useEffect(() => {
    let live = true;
    api
      .aiProvider()
      .then((p) => {
        if (live) setSendsRemotely(p?.isLive === true);
      })
      .catch(() => {
        if (live) setSendsRemotely(true);
      });
    return () => {
      live = false;
    };
  }, []);

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

            {/* The disclosure is stated before the box, not after the result. */}
            {sendsRemotely && (
              <Alert tone="info" title="Before you submit">
                <span className="small">
                  If you submit this, the description you write - and the age, if
                  you give one - will be sent to Google&apos;s Gemini AI service so
                  it can suggest a department. Your name, account, appointments
                  and medical records are never included.
                </span>
              </Alert>
            )}

            {confirming && (
              <Alert tone="warning" title="Send this to an AI service?">
                <span className="small">
                  Your description will leave MediCare and be processed by
                  Google. You can type something less specific instead, or go
                  back and edit it.
                </span>
                <div className="row" style={{ gap: "0.5rem", marginTop: "0.5rem" }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setConfirming(false)}
                    disabled={busy}
                  >
                    Go back and edit
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={busy}
                  >
                    {busy ? <Spinner /> : "Yes, send it"}
                  </button>
                </div>
              </Alert>
            )}

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
                {/* While confirming, the choice lives in the confirmation panel
                    above; a second identical button here would invite a click
                    that skips it. */}
                {!confirming && (
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={busy}
                    style={{ flex: 1 }}
                  >
                    {busy ? <Spinner /> : "Analyse my symptoms"}
                  </button>
                )}
                {confirming && <div style={{ flex: 1 }} />}
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
