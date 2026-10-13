import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Alert, EmptyState, Loading } from "../components/ui.jsx";
import api from "../api/client";
import { useAuth } from "../context/AuthContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { cx } from "../utils/format";

/**
 * MediCare's help assistant.
 *
 * What this component is responsible for, and what it deliberately is not:
 *
 *   * It renders answers and nothing else. Every action it offers is a link to a
 *     page the user already has, or a suggestion chip that asks another question.
 *     There is no control that books, cancels or changes anything - the server
 *     does not provide one, and the UI does not fake it.
 *
 *   * It labels model-generated text. `generatedByModel` comes from the server,
 *     which knows whether a model was actually consulted. The UI never guesses,
 *     so an answer the application wrote itself is never dressed up as AI output,
 *     and an answer the model wrote is always marked.
 *
 *   * The disclaimer is shown permanently, not only on model answers. A patient
 *     reading "you are number 2 in the waiting room" and a patient reading a
 *     model's paragraph about headaches are looking at the same screen, and the
 *     screen should look equally careful.
 */
export default function Assistant() {
  const { user } = useAuth();
  const toast = useToast();

  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [infoError, setInfoError] = useState(null);

  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState([]);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState(null);

  const bottom = useRef(null);

  const loadInfo = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await api.assistantInfo());
      setInfoError(null);
    } catch (err) {
      setInfoError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInfo();
  }, [loadInfo]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length, asking]);

  const ask = useCallback(
    async (text) => {
      const q = String(text ?? "").trim();
      if (!q) return;
      // Two guards, because the button being disabled is not a guarantee: a
      // suggestion chip can still be clicked while the first request is in
      // flight, and the assistant endpoint bills upstream calls.
      if (asking) return;
      setAsking(true);
      setAskError(null);
      setTurns((t) => [...t, { q, pending: true }]);
      try {
        const res = await api.assistantAsk(q);
        setTurns((t) => [
          ...t.slice(0, -1),
          {
            q,
            answer: res.answer,
            generatedByModel: res.generatedByModel === true,
            intent: res.intent,
            refused: res.refused === true,
            suggestions: res.suggestions ?? [],
          },
        ]);
      } catch (err) {
        // The failed question stays on screen so the user can see what failed,
        // rather than vanishing as though it were never asked.
        setTurns((t) => t.slice(0, -1));
        setAskError(err.message);
        toast.error(err.message || "Could not reach the assistant");
      } finally {
        setAsking(false);
      }
    },
    [asking, toast],
  );

  const suggestions = useMemo(() => {
    const fromTurn = turns.filter((t) => t.suggestions?.length).at(-1)?.suggestions ?? [];
    return fromTurn.length ? fromTurn : (info?.suggestions ?? []).slice(0, 5);
  }, [turns, info]);

  if (loading) return <Loading label="Loading the assistant…" />;

  return (
    <div className="page">
      <div className="container stack" style={{ maxWidth: 820 }}>
        <div className="page-head">
          <h1 style={{ marginBottom: "0.15rem" }}>Help</h1>
          <p className="small muted">
            How MediCare works, and general healthcare information.
          </p>
        </div>

        {infoError && (
          <Alert tone="danger">
            {infoError}{" "}
            <button type="button" className="btn btn-secondary btn-sm" onClick={loadInfo}>
              Retry
            </button>
          </Alert>
        )}

        {/* The scope limit is stated before the first question, not discovered
            after one. A user who has already asked about a symptom is less able
            to judge the answer than one who has not. */}
        <Alert tone="info" title="What this can and cannot do">
          <span className="small">
            {info?.note ??
              "I can explain how MediCare works and answer general healthcare questions."}
          </span>
        </Alert>

        {!info?.modelAvailable && (
          <Alert tone="warning">
            <span className="small">
              Live language-model answers are not available right now. Questions
              about how MediCare works are answered from the application itself
              and are unaffected.
            </span>
          </Alert>
        )}

        <div
          className="card"
          style={{ display: "flex", flexDirection: "column", minHeight: 320, maxHeight: "58vh" }}
        >
          <div className="card-body stack-sm" style={{ overflowY: "auto", flex: 1 }}>
            {turns.length === 0 ? (
              <EmptyState
                icon="💬"
                title="Ask a question"
                message="Try one of the suggestions below, or ask in your own words."
              />
            ) : (
              turns.map((t, i) =>
                t.pending ? (
                  <div key={i} className="row" style={{ justifyContent: "flex-end" }}>
                    <div className="card card-pad" style={{ maxWidth: "80%" }}>
                      <div className="small">{t.q}</div>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="stack-sm">
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <div className="card card-pad" style={{ maxWidth: "80%" }}>
                        <div className="small">{t.q}</div>
                      </div>
                    </div>
                    <div
                      className={cx(
                        "card card-pad",
                        t.refused && "border-brand",
                      )}
                      style={{ maxWidth: "92%" }}
                    >
                      <div className="row-between row-wrap" style={{ gap: "0.4rem" }}>
                        {t.generatedByModel ? (
                          // Only model text carries this badge. Marking the
                          // application's own answers as AI output would be as
                          // misleading as failing to mark the model's.
                          <span className="badge badge-violet">
                            AI-generated · not medical advice
                          </span>
                        ) : (
                          <span className="badge badge-gray">From MediCare</span>
                        )}
                        {t.refused && (
                          <span className="badge badge-warning">Request not answered</span>
                        )}
                      </div>
                      <p className="small" style={{ whiteSpace: "pre-wrap", margin: "0.35rem 0 0" }}>
                        {t.answer}
                      </p>
                    </div>
                  </div>
                ),
              )
            )}
            {asking && (
              <p className="tiny muted" style={{ margin: 0 }}>
                Thinking…
              </p>
            )}
            <div ref={bottom} />
          </div>

          <div className="card-body" style={{ borderTop: "1px solid var(--gray-200)" }}>
            {askError && (
              <div className="stack-sm" style={{ marginBottom: "0.6rem" }}>
                <Alert tone="danger">
                  {askError}{" "}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => ask(question)}
                    disabled={asking}
                  >
                    Try again
                  </button>
                </Alert>
              </div>
            )}

            <div className="row row-wrap" style={{ gap: "0.4rem", marginBottom: "0.6rem" }}>
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="badge badge-info"
                  style={{ cursor: "pointer", border: "none" }}
                  onClick={() => ask(s)}
                  disabled={asking}
                >
                  {s}
                </button>
              ))}
            </div>

            <form
              className="row"
              style={{ gap: "0.5rem" }}
              onSubmit={(e) => {
                e.preventDefault();
                ask(question);
                setQuestion("");
              }}
            >
              <input
                id="assistant-question"
                className="input"
                style={{ flex: 1, minWidth: 0 }}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={
                  user ? "How do I check in?" : "Sign in to ask a question"
                }
                maxLength={info?.limits?.maxQuestionLength ?? 1000}
                disabled={asking || !user}
                aria-label="Your question"
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  asking || !user || question.trim().length < (info?.limits?.minQuestionLength ?? 3)
                }
              >
                {asking ? "Asking…" : "Ask"}
              </button>
            </form>
            {!user && (
              <p className="tiny muted" style={{ margin: "0.4rem 0 0" }}>
                You need to sign in to ask a question, so answers can be kept
                separate for each account.
              </p>
            )}
            {info?.limits && (
              <p className="tiny muted" style={{ margin: "0.4rem 0 0" }}>
                Questions are limited to {info.limits.maxQuestionLength} characters.
                {info.rateLimitPerMinute
                  ? ` Up to ${info.rateLimitPerMinute} a minute.`
                  : ""}
              </p>
            )}
          </div>
        </div>

        <p className="tiny muted" style={{ margin: 0 }}>
          {info?.disclaimer}
        </p>
      </div>
    </div>
  );
}