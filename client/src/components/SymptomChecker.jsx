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
    // While the confirmation panel is open, the choice belongs to its buttons:
    // a stray Enter key must not transmit without an answer.
    if (confirming) return;
    if (text.trim().length < 3) {
      setError("Please describe your symptoms in a few more words.");
      return;
    }
    // Ask first, transmit second - and only when something would actually be sent
    // somewhere else.
    if (sendsRemotely) {
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
    <div className="card sym-checker">
      <div className="sym-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tiny muted bold sym-eyebrow">AI-ASSISTED TRIAGE</div>
          <h3>Symptom checker</h3>
          <p className="small muted" style={{ margin: 0 }}>
            Describe how you feel — we&apos;ll point you to the right
            department and doctors.
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

            {confirming && (
              <Alert tone="warning" title="Send this to an AI service?">
                <span className="small">
                  Your description will leave BookMyDoc and be processed by
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
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => runTriage(true)}
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
                  className="textarea sym-textarea"
                  placeholder="e.g. I have had chest pain and shortness of breath since yesterday, worse when I walk upstairs."
                  value={text}
                  maxLength={2000}
                  onChange={(e) => setText(e.target.value)}
                />
                <div className="tiny muted right">{text.length}/2000</div>
              </div>
              <div className="sym-foot">
                <div className="field sym-age">
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
                    className="btn btn-primary btn-lg sym-submit"
                    disabled={busy}
                  >
                    {busy ? <Spinner /> : "Analyse my symptoms →"}
                  </button>
                )}
              </div>
            </form>

            <div className="tiny muted sym-note">
              ⚠️ This is decision support for a prototype, not a medical
              diagnosis. Seek emergency care for severe symptoms.
            </div>
          </>
        )}

        {result && (
          <div className="stack">
            <div className={`sym-urgency sym-urgency-${urgencyTone}`}>
              <div className="row" style={{ gap: "0.45rem", flexWrap: "wrap" }}>
                <StatusBadge status={result.urgency}>
                  {result.urgency} urgency
                </StatusBadge>
                {result.departments?.map((d) => (
                  <span key={d} className="badge">
                    {d}
                  </span>
                ))}
              </div>
              <div className="small">{result.summary}</div>
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
              <div className="sym-block">
                <span className="sym-block-title">What to do</span>
                <p className="small" style={{ margin: 0 }}>
                  {result.advice}
                </p>
              </div>
            )}

            {result.followUpQuestions?.length > 0 && (
              <div className="sym-block">
                <span className="sym-block-title">The doctor may ask</span>
                <ul className="sym-list">
                  {result.followUpQuestions.map((q, i) => (
                    <li key={i} className="small">
                      {q}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {doctors.length > 0 && (
              <div className="sym-block">
                <span className="sym-block-title">Recommended doctors</span>
                <div className="stack-sm">
                  {doctors.map((d) => (
                    <div key={d.id} className="sym-doctor">
                      <Avatar name={d.name} color={d.imageColor} size="sm" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="small bold truncate">{d.name}</div>
                        <div className="tiny muted truncate">
                          {d.specialtyName} · {d.facilityName}
                        </div>
                      </div>
                      <Link
                        to={`/doctors/${encodeURIComponent(d.id)}`}
                        className="btn btn-secondary btn-sm nowrap"
                      >
                        Book
                      </Link>
                    </div>
                  ))}
                </div>
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
