import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Alert, Loading } from "../components/ui.jsx";
import api from "../api/client";
import { useAuth } from "../context/AuthContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { cx } from "../utils/format";

/**
 * Floating chatbot widget.
 *
 * Mounted once in App.jsx, and only for patients and signed-out visitors — the
 * provider and admin consoles never render it. Click the robot icon
 * bottom-right to open the assistant popup; click again to close it.
 *
 * Same contract as before: /ai/assist for discovery and questions, must be
 * signed in to ask, model-generated text is labelled, refusals are labelled.
 * Nothing here books, cancels or changes any record.
 */
export default function ChatWidget() {
  const { user } = useAuth();
  const toast = useToast();

  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [infoError, setInfoError] = useState(null);

  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState([]);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState(null);

  const chatEnd = useRef(null);
  const [open, setOpen] = useState(false);

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

  // Keep the transcript scrolled to the most recent message.
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length, asking]);

  const ask = useCallback(
    async (text) => {
      const q = String(text ?? "").trim();
      if (!q) return;
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

  const unread = turns.filter((t) => !t.read).length;

  return (
    <>
      {/* ---------- floating button ---------- */}
      <button
        type="button"
        className="chat-float-btn"
        aria-label={open ? "Close assistant" : "Open assistant"}
        onClick={() => setOpen((o) => !o)}
        title={open ? "Close assistant" : "Open assistant"}
      >
        <span className="chat-float-icon">🤖</span>
        {unread > 0 && <span className="chat-float-badge">{unread}</span>}
      </button>

      {/* ---------- popup ---------- */}
      {open && (
        <div className="chat-popup-backdrop"
          onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="chat-popup">
            {/* header */}
            <header className="chat-header">
              <div className="chat-brand">
                <div>
                  <div className="chat-title">BookMyDoc Assistant</div>
                </div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
                Close
              </button>
            </header>

            {infoError && (
              <Alert tone="danger">
                {infoError}{" "}
                <button type="button" className="btn btn-secondary btn-sm" onClick={loadInfo}>
                  Retry
                </button>
              </Alert>
            )}

            {/* ---------- transcript ---------- */}
            <div className="chat-window" ref={chatEnd}>
              {turns.length === 0 ? (
                <div className="chat-empty">
                  <div className="chat-empty-icon">💬</div>
                  <div className="chat-empty-title">Ask a question</div>
                  <div className="chat-empty-desc">
                    Try one of the suggestions below, or ask in your own words.
                  </div>
                  <div className="chat-empty-chips">
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="chat-chip"
                        disabled={asking}
                        onClick={() => ask(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                turns.map((t, i) => (
                  <>
                    {/* User message */}
                    <div key={`${i}-u`} className="chat-msg chat-msg-user">
                      <div className="chat-bubble chat-bubble-user">{t.q}</div>
                    </div>

                    {/* Assistant reply */}
                    {!t.pending && (
                      <div key={i} className="chat-msg chat-msg-assistant">
                        <div className="chat-bubble chat-bubble-assistant">
                          <div className="chat-meta">
                            {t.generatedByModel ? (
                              <span className="badge badge-violet">
                                AI-generated · not medical advice
                              </span>
                            ) : (
                              <span className="badge">From BookMyDoc</span>
                            )}
                            {t.refused && (
                              <span className="badge badge-warning">
                                Request not answered
                              </span>
                            )}
                          </div>
                          <p className="chat-text" style={{ whiteSpace: "pre-wrap" }}>
                            {t.answer}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Optimistic user bubble while waiting */}
                    {t.pending && (
                      <div className="chat-msg chat-msg-user">
                        <div className="chat-bubble chat-bubble-user">{t.q}</div>
                      </div>
                    )}
                  </>
                ))
              )}

              {asking && (
                <div className="chat-msg chat-msg-assistant">
                  <div className="chat-bubble chat-bubble-assistant chat-typing">
                    <span></span>
                    <span></span>
                    <span></span>
                    <span className="chat-typing-text">Assistant is typing</span>
                  </div>
                </div>
              )}
              <div ref={chatEnd} />
            </div>

            {/* ---------- input ---------- */}
            <footer className="chat-input-area">
              {askError && (
                <div className="stack-sm" style={{ marginBottom: "0.6rem" }}>
                  <Alert tone="danger">
                    {askError}
                    {/* Retry only where a retry can work. With no session the
                        failure is "Authentication required" and asking again
                        returns the same 401, so the button is a dead control —
                        the sign-in note below is the way forward instead. */}
                    {user && (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => ask(question)}
                          disabled={asking}
                        >
                          Try again
                        </button>
                      </>
                    )}
                  </Alert>
                </div>
              )}

              <form
                className="chat-form"
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
                    asking ||
                    !user ||
                    question.trim().length < (info?.limits?.minQuestionLength ?? 3)
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
            </footer>
          </div>
        </div>
      )}
    </>
  );
}