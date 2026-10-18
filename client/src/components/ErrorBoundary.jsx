import { Component } from "react";

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
 *     records, endpoints and internal identifiers, so the fallback carries a
 *     heading, one sentence and a way out, and nothing else. The detail goes
 *     to the console in `componentDidCatch`, which is the only channel a
 *     developer needs and the only one that cannot leak into a screenshot.
 *   * Claim more than it knows. The fallback states one fact — something threw
 *     while this screen was rendering — because that is the only fact a
 *     boundary holds. A paragraph here once added "Reloading usually fixes it"
 *     and "your appointments and account are unaffected": the first is a guess
 *     about someone else's situation and the second is a promise about data
 *     this component never inspects. Neither can be verified from inside an
 *     error boundary, so neither is said.
 *   * Offer a choice the user cannot really make. "Reload" and "Try again" both
 *     mean "get this screen working again", and only the reload works when the
 *     module itself failed to load. Two buttons split attention between them
 *     and make the reliable one look like half of an option, so there is one.
 *
 * Recovery is a single full-page reload: it is the only action that clears both
 * a transient state crash and a module that failed to evaluate.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleReload = this.handleReload.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept in the console rather than the UI: it is useful to a developer and
    // is exactly the kind of thing that must not reach a patient.
    console.error("[BookMyDoc] render error", error, info?.componentStack);
  }

  handleReload() {
    window.location.reload();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="page-glass-bg errpage">
        <div className="container">
          <div className="errpage-inner">
            <div className="errpage-mark" aria-hidden="true">
              🛟
            </div>

            <h1 className="errpage-title">Something went wrong on this screen</h1>

            {/* Says what a boundary can actually know, which is narrow: that
                something threw while this screen was rendering. The old copy
                went further than that - "reloading usually fixes it" and
                "your appointments and account are unaffected" - and both were
                assertions this component has no way to check. What is left is
                a true statement plus the action that follows from it. */}
            <p className="errpage-lede">
              Something broke while this screen was drawing. Reloading it
              usually clears that up.
            </p>

            {/* ONE recovery action, deliberately.

                This offered "Reload the page" and "Try again" side by side.
                They are not really a choice: a re-render only helps when the
                crash came from transient state, and does nothing at all when
                the module itself failed to load - in which case tapping it
                flashes the same screen straight back and invites a second tap.
                A reload covers both cases, so offering the other one alongside
                it split attention between two buttons that mean the same thing
                and made the reliable one look like half of an option. */}
            <div className="errpage-actions">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={this.handleReload}
              >
                Reload the page
              </button>
            </div>

            {/* A real route out, not decoration: a crash replaces the whole
                shell, so the header and every nav link are gone. This is the
                only way back for someone the buttons do not help. */}
            <a className="errpage-home" href="/">
              Go to home
            </a>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;