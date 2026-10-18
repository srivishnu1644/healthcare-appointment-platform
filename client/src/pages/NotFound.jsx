import { Link } from "react-router-dom";

import { useAuth } from "../context/AuthContext.jsx";
import { homeFor } from "../components/Layout.jsx";
import NotFoundArt from "../components/NotFoundArt.jsx";

/**
 * NotFound — what an unknown URL renders.
 *
 * WHY A PAGE AND NOT A REDIRECT
 * -----------------------------
 * The catch-all used to bounce straight to the visitor's home, which is silent.
 * A mistyped URL, a stale bookmark or a broken link all produced the same result
 * as "this page does not exist and nobody knows why" — the visitor lands on a
 * dashboard that has nothing to do with where they were trying to go, with no
 * way to tell a typo from a broken link.
 *
 * The route it is mounted at is the catch-all, so this renders IN PLACE and the
 * address bar keeps the path that was not found. The path is deliberately NOT
 * echoed back into the page as well: it is already on screen in the URL bar, and
 * a second copy of it turned a short, calm explanation into something that reads
 * like an error report.
 *
 * There is deliberately no `/not-found` route of its own either: a canonical URL
 * for "not found" would invite links to it, which then 404 as well.
 */
export default function NotFound() {
  const { user, booting } = useAuth();
  const home = homeFor(user?.role);

  return (
    <div className="page page-glass-bg nf">
      <div className="container">
        <div className="nf-grid">
          <div className="nf-art">
            <NotFoundArt className="nf-art-svg" />
          </div>

          <div className="nf-copy">
            <h1 className="nf-title">
              {booting ? "Checking your session…" : "We can't find that page"}
            </h1>

            <p className="nf-lede">
              {booting
                ? "One moment while we work out where you should go."
                : "The link may be mistyped, or the page may have moved since you saved it. Nothing is wrong on your side."}
            </p>

            {/* Held back until the session restore settles: sending a signed-in
                visitor to "/" because their role had not loaded yet would show a
                signed-out landing page to someone who is very much signed in. */}
            {!booting && (
              <div className="nf-actions">
                <Link to={home} className="btn btn-primary">
                  {user ? "Back to my dashboard" : "Back to home"}
                </Link>
                <Link to="/doctors" className="btn btn-secondary">
                  Browse doctors
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
