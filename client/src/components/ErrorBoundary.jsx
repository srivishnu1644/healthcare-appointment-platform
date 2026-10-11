import { Component } from "react";
import { EmptyState } from "./ui.jsx";

/**
 * Top-level error boundary.
 *
 * A render or lifecycle error anywhere below this point would otherwise leave a
 * blank page with no way out. This catches it and offers a recovery action that
 * actually works.
 *
 * What it deliberately does NOT do:
 *
 *   * Swallow API errors. Pages fetch their own data and render failures as a
 *     visible `Alert`; those never reach a boundary, because they are values in
 *     state rather than thrown errors. Only a genuine crash lands here.
 *   * Show the error to a patient. A stack trace or an API message can name
 *     records, endpoints and internal identifiers, so the fallback stays
 *     generic. The detail is written to the console for a developer, and is
 *     only rendered when the build is a development one.
 *
 * Recovery offers two actions on purpose: "Try again" re-renders the tree and
 * is the right move when the crash came from transient state, while "Reload"
 * is the dependable one when the module itself was the problem.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleRetry = this.handleRetry.bind(this);
    this.handleReload = this.handleReload.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept in the console rather than the UI: it is useful to a developer and
    // is exactly the kind of thing that must not reach a patient.
    console.error("[MediCare] render error", error, info?.componentStack);
  }

  handleRetry() {
    this.setState({ error: null });
  }

  handleReload() {
    window.location.reload();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const devOnly = import.meta.env.DEV;

    return (
      <div className="container" style={{ padding: "3rem 1rem" }}>
        <div className="card">
          <div className="card-body">
            <EmptyState
              icon="🛟"
              title="Something went wrong on this screen"
              message={
                "The page ran into a problem it could not recover from. Reloading " +
                "usually fixes it. Your appointments and account are unaffected."
              }
              action={
                <div
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    justifyContent: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <button type="button" className="btn btn-primary" onClick={this.handleReload}>
                    Reload the page
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={this.handleRetry}>
                    Try again
                  </button>
                  <a className="btn btn-ghost" href="/">
                    Go to home
                  </a>
                </div>
              }
            />

            {devOnly && (
              <details style={{ marginTop: "1rem" }}>
                <summary className="small">Error details (development only)</summary>
                <pre
                  className="small"
                  style={{ whiteSpace: "pre-wrap", marginTop: "0.5rem" }}
                >
                  {String(error?.stack || error?.message || error)}
                </pre>
              </details>
            )}
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;