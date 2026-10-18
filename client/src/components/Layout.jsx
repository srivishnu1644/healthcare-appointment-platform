import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import api from "../api/client";
import { useAuth } from "../context/AuthContext.jsx";
import { Avatar } from "./ui.jsx";
import { colorFrom, cx } from "../utils/format";

/* ------------------------------------------------------------------ *
 *  Role-aware navigation                                             *
 * ------------------------------------------------------------------ *
 *
 * ONE ARRAY, TWO SURFACES — `barHidden`
 * ------------------------------------
 * `links` below feeds both the desktop bar (line 319) and the drawer (line
 * 517), which is deliberate: the two surfaces should never disagree about what
 * a role can reach.
 *
 * `barHidden: true` is the one exception, and it is an exception about the
 * DESKTOP BAR ONLY:
 *
 *   - Profile lives in the account dropdown on every desktop width. Listing it
 *     in the bar as well put the same page on screen twice, on the same row.
 *   - The drawer keeps it. Below the tier boundary the account dropdown does
 *     not exist — the whole cluster is inside the sheet's head — so the drawer
 *     is the ONLY place a tablet or phone user can reach their profile.
 *     Hiding it there would strand them.
 *
 * So the flag suppresses the bar link and nothing else. The drawer maps the
 * array unfiltered, which is why this has to be a flag on the entry rather than
 * a filter at the render site.
 */
const NAV = {
  patient: [
    { to: "/dashboard", label: "Dashboard", end: true },
    { to: "/doctors", label: "Find a doctor" },
    { to: "/appointments", label: "My appointments" },
    { to: "/notifications", label: "Notifications" },
    { to: "/profile", label: "Profile", barHidden: true },
  ],
  doctor: [
    { to: "/my-schedule", label: "My schedule", end: true },
    // No directory link: a doctor browsing every other doctor's listing, with
    // a "Book" button on each card including their own, is not a screen they
    // have any use for. Their patients reach them through a booking link.
    // The route itself stays public - the landing page, the symptom checker
    // and the doctor cards all still point at /doctors.
    { to: "/notifications", label: "Notifications" },
    { to: "/profile", label: "Profile", barHidden: true },
  ],
  admin: [
    { to: "/admin", label: "Dashboard", end: true },
    { to: "/admin/doctors", label: "Doctors" },
    { to: "/admin/facilities", label: "Facilities" },
    { to: "/admin/patients", label: "Patients" },
    { to: "/admin/appointments", label: "Appointments" },
    { to: "/admin/queue", label: "Waiting rooms" },
    { to: "/admin/notifications", label: "Notification log" },
    { to: "/profile", label: "Profile", barHidden: true },
  ],
};

/**
 * Sign-out glyph: a door on the left with the arrow leaving to the right.
 *
 * Drawn rather than typed as a character so it inherits `currentColor` and
 * therefore turns red with the label on hover, and so its stroke weight
 * matches the icon set instead of depending on whichever emoji font the
 * device happens to resolve.
 */
function SignOutIcon() {
  return (
    <svg
      className="signout-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

/**
 * Caret for the account menu, pointing down and rotating to point up when open.
 *
 * Drawn rather than typed, for the same reasons as `SignOutIcon`: it inherits
 * `currentColor`, so it matches the button's hover and focus states instead of
 * being a coloured emoji whose tint the browser chooses.
 */
function CaretIcon({ up = false }) {
  return (
    <svg
      className={cx("caret-icon", up && "caret-icon-up")}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/**
 * The behaviour every modal layer in the shell needs, in one implementation.
 *
 * Escape closes, Tab stays inside the panel, the page behind stops scrolling,
 * focus lands on the layer's own dismiss control when it opens and goes back to
 * whatever opened it when it closes.
 *
 * `openedOnce` is the load-bearing part: a layer that starts closed would
 * otherwise read the initial `open === false` as a close and spend the
 * not-yet-set opener trying to focus it. Focus only moves for a layer that has
 * actually been open, and only hands back on the close that follows.
 *
 * `returnRef` is optional — a layer with no opener to return to (the first-load
 * notice has none) simply skips the hand-back.
 */
function useModalLayer({ open, onClose, panelRef, closeRef, returnRef }) {
  const openedOnce = useRef(false);

  useEffect(() => {
    if (open) {
      openedOnce.current = true;
      if (returnRef) returnRef.current = document.activeElement;
      closeRef.current?.focus();
      return;
    }
    if (openedOnce.current) {
      openedOnce.current = false;
      returnRef?.current?.focus?.();
    }
  }, [open, closeRef, returnRef]);

  useEffect(() => {
    if (!open) return undefined;

    const onKey = (event) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = panel.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!panel.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose, panelRef]);
}

export function Header({ unread = 0 }) {
  const { user, logout, role } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  // Focus bookkeeping: the sheet takes focus when it opens and hands it back
  // to the toggle when it closes, so a keyboard user never falls behind the
  // overlay.
  const toggleRef = useRef(null);
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const openerRef = useRef(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // Close the mobile menu whenever the route changes.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  useModalLayer({
    open: menuOpen,
    onClose: closeMenu,
    panelRef,
    closeRef,
    returnRef: openerRef,
  });

  // Escape and Tab are handled above; this is the one rule that is the sheet's
  // alone: a window widened past the collapse breakpoint must not inherit a
  // menu that only exists for tablet and phone.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const wide = window.matchMedia("(min-width: 901px)");
    const onWide = (event) => {
      if (event.matches) closeMenu();
    };
    wide.addEventListener("change", onWide);
    return () => wide.removeEventListener("change", onWide);
  }, [menuOpen, closeMenu]);

  const links = user ? NAV[role] || NAV.patient : [];

  /* ------------------------------------------------------------------ *
   *  Account menu                                                      *
   * ------------------------------------------------------------------ *
   *  WHY THE ACCOUNT CLUSTER AND SIGN OUT WERE MERGED
   *  They were two separate things in the bar, and together they were 224px
   *  wide - the identity, plus a 100px button for the least-used control in
   *  the header. An admin's nav is eight nowrap links and 768px before the
   *  account gets anything, so somewhere around 1150px the bar ran out of
   *  room. `Sign out` was not the item that gave way: it had no `min-width: 0`,
   *  so it held its size, and the identity - which had `min-width: 0` for its
   *  ellipsis - was squeezed instead. It did not ellipsize. It collapsed to
   *  zero width, deforming the avatar into a tall oval and leaving a two-letter
   *  sliver of the name, while Sign out ran off the right edge of the screen.
   *
   *  Merging them is the fix, not a workaround. Identity becomes the control,
   *  so it is now one avatar-sized target instead of text that competes for
   *  width, and sign-out moves to where a once-a-session action belongs: one
   *  click inside the menu. The bar loses 124px, which is what the identity
   *  needed to survive at all, and the header stops growing every time a
   *  ninth admin link appears.
   * ------------------------------------------------------------------ */
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef(null);

  const closeAccount = useCallback(() => setAccountOpen(false), []);

  // Escape closes and hands focus back to the trigger, so a keyboard user is
  // never left stranded where the menu used to be.
  useEffect(() => {
    if (!accountOpen) return undefined;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      setAccountOpen(false);
      accountRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [accountOpen]);

  // Click-away, on `pointerdown` rather than `click`: a gesture that starts
  // outside and ends on the trigger would otherwise open and close in one go.
  // The wrapper is tested rather than the panel so the trigger's own click is
  // not mistaken for an outside one.
  useEffect(() => {
    if (!accountOpen) return undefined;
    const onPointerDown = (event) => {
      if (accountRef.current?.parentElement?.contains(event.target)) return;
      setAccountOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [accountOpen]);

  // A route change means the menu has done its job; leaving it open would hang
  // a panel over the page the user just asked for.
  useEffect(() => {
    setAccountOpen(false);
  }, [location.pathname]);

  // Past the width where the trigger stops rendering, an open panel would be
  // orphaned under a bar that no longer has it. The same rule the drawer
  // follows for itself.
  useEffect(() => {
    if (!accountOpen) return undefined;
    const wide = window.matchMedia("(min-width: 1025px)");
    const onWide = (event) => {
      if (event.matches) closeAccount();
    };
    wide.addEventListener("change", onWide);
    return () => wide.removeEventListener("change", onWide);
  }, [accountOpen, closeAccount]);

  // Sign-out is a round trip to the server, so the button shows its own
  // progress. Without this a second click starts a second logout while the
  // first is still in flight, and `navigate` can run before the session has
  // actually been dropped.
  const [signingOut, setSigningOut] = useState(false);

  const onLogout = async () => {
    if (signingOut) return;
    setSigningOut(true);
    // Awaited before navigating: /login is a guest-only route, so navigating
    // while `user` is still set would bounce straight back to the dashboard.
    // `api.logout()` never rejects - it clears local state either way - so
    // this cannot strand the user on a disabled button.
    await logout();
    setSigningOut(false);
    navigate("/login");
  };

  return (
    <header className="app-header">
      <div className="container row app-header-bar">
        <Link to="/" className="row app-header-brand">
          <img
            src="/logo-mark.svg"
            alt=""
            width="32"
            height="32"
            style={{
              display: "block",
              filter: "drop-shadow(0 2px 5px rgba(29, 78, 216, 0.3))",
            }}
          />
          <strong>BookMyDoc</strong>
        </Link>

        {user && (
          <nav className="row hide-sm" style={{ gap: "0.35rem", flex: 1 }}>
            {/* `barHidden` entries are dropped HERE and nowhere else. The
                drawer maps the same array unfiltered, so Profile stays
                reachable on tablet and phone where there is no account
                dropdown to reach it through. */}
            {links
              .filter((l) => !l.barHidden)
              .map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                className={({ isActive }) =>
                  cx("btn btn-ghost btn-sm", isActive && "nav-glass-active")
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
        )}

        <div className="spacer" />

        {user ? (
          <>
            {/* No bell. Notifications used to be the one control a patient got
                that nobody else did, which put a bare 🔔 on a bar otherwise made
                entirely of labelled links — and put the same page on screen
                twice on a row, next to the "Notifications" link already in
                `NAV.patient`. Patients still reach it from that link on a
                desktop and from the drawer on a phone, so nothing is stranded;
                the unread count survives there too. */}

            {/* The account menu. One control instead of an identity block and
                a sign-out button, which is what lets the identity survive a
                nine-link admin nav. `hide-sm` keeps it consistent with the
                rest of the bar: at ≤1024px the whole cluster moves into the
                drawer, whose head already shows the avatar, name and email. */}
            <div className="account hide-sm">
              <button
                type="button"
                ref={accountRef}
                className={cx("account-btn", accountOpen && "account-btn-open")}
                onClick={() => setAccountOpen((o) => !o)}
                aria-expanded={accountOpen}
                aria-haspopup="true"
                aria-label={`Account menu for ${user.name}`}
              >
                <Avatar
                  name={user.name}
                  color={colorFrom(user.email)}
                  size="sm"
                />
                {/* Name and role are a wide-viewport luxury, not the
                    identifier: the avatar carries identity, and the menu repeats
                    all three fields. Dropping the text is what guarantees the
                    trigger cannot be squeezed - `flex-shrink: 0` alone would
                    hold its size and push the bar into overflowing instead. */}
                <span className="account-text">
                  <span className="small bold">{user.name}</span>
                  <span className="tiny muted">{role}</span>
                </span>
                <CaretIcon up={accountOpen} />
              </button>

              {accountOpen && (
                <div className="account-menu">
                  <div className="account-menu-head">
                    <Avatar
                      name={user.name}
                      color={colorFrom(user.email)}
                      size="lg"
                    />
                    <div className="account-menu-id">
                      <div className="small bold truncate">{user.name}</div>
                      <div className="tiny muted truncate" style={{ textTransform: "capitalize" }}>
                        {role}
                      </div>
                      <div className="tiny muted truncate">{user.email}</div>
                    </div>
                  </div>

                  <div className="divider" />

                  <Link
                    to="/profile"
                    className="account-item"
                    onClick={closeAccount}
                  >
                    Profile
                  </Link>

                  <button
                    type="button"
                    className="account-item account-item-signout"
                    onClick={onLogout}
                    disabled={signingOut}
                    aria-busy={signingOut}
                  >
                    <SignOutIcon />
                    <span>{signingOut ? "Signing out…" : "Sign out"}</span>
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="row" style={{ gap: "0.5rem" }}>
            <Link to="/login" className="btn btn-ghost btn-sm">
              Sign in
            </Link>
            <Link to="/register" className="btn btn-primary btn-sm">
              Get started
            </Link>
          </div>
        )}

        {user && (
          <button
            type="button"
            ref={toggleRef}
            className="btn btn-secondary btn-icon show-sm menu-toggle"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? "app-menu" : undefined}
          >
            ☰
          </button>
        )}
      </div>

      {/* Mobile / tablet menu. Portalled to <body>: the sticky header owns a
          `backdrop-filter`, which makes it the containing block for fixed
          children, so a backdrop inside <header> could only ever dim the 64px
          bar — the page behind the menu stayed bright and every click on it
          missed the menu. Out here the overlay covers the real viewport, sits
          above the floating chat control, and closes on outside click. */}
      {user &&
        menuOpen &&
        createPortal(
          <>
            <div
              className="drawer-backdrop"
              onClick={() => setMenuOpen(false)}
              aria-hidden="true"
            />
            <div
              className="drawer-panel drawer-sheet"
              id="app-menu"
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label="Menu"
            >
              <div className="drawer-head">
                <div className="row" style={{ gap: "0.6rem" }}>
                  <Avatar
                    name={user.name}
                    color={colorFrom(user.email)}
                    size="sm"
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="small bold truncate">{user.name}</div>
                    <div className="tiny muted truncate">{user.email}</div>
                  </div>
                </div>
                <button
                  type="button"
                  ref={closeRef}
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => setMenuOpen(false)}
                  aria-label="Close menu"
                >
                  ✕
                </button>
              </div>
              <div className="drawer-role">{role}</div>
              <nav className="drawer-nav">
                {links.map((l, i) => (
                  <NavLink
                    key={l.to}
                    to={l.to}
                    end={l.end}
                    className={({ isActive }) =>
                      cx("drawer-link", isActive && "active")
                    }
                    style={{ animationDelay: `${40 + i * 35}ms` }}
                  >
                    {l.label}
                    {/* The unread count has nowhere else to live now that the
                        bar carries no bell, so this badge is the single place
                        it appears. */}
                    {l.to === "/notifications" && unread > 0 && (
                      <span className="drawer-badge">
                        {unread > 9 ? "9+" : unread}
                      </span>
                    )}
                  </NavLink>
                ))}
              </nav>
              <div className="drawer-foot">
                <div className="divider" style={{ margin: "0.6rem 0" }} />
                <button
                  type="button"
                  className="btn btn-block signout-btn"
                  onClick={onLogout}
                  disabled={signingOut}
                  aria-busy={signingOut}
                >
                  <SignOutIcon />
                  <span>{signingOut ? "Signing out…" : "Sign out"}</span>
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
    </header>
  );
}

/**
 * Where a signed-in user of `role` belongs. This is the single source of
 * truth for post-auth routing: the header logo, the route guards in App.jsx
 * and the login/register redirects all defer to it. A patient lands on their
 * own dashboard, never on the public landing page.
 */
export function homeFor(role) {
  if (role === "admin") return "/admin";
  if (role === "doctor") return "/my-schedule";
  if (role === "patient") return "/dashboard";
  return "/";
}

/* ------------------------------------------------------------------ *
 *  Footer                                                            *
 * ------------------------------------------------------------------ */
export function Footer() {
  return (
    <footer className="app-footer">
      <div className="container app-footer-inner">
        {/* The notice leads, and the marketing line it contradicted is gone rather
            than demoted. "Book appointments with trusted doctors" sitting one
            line above "this books nothing" reads as a disclaimer nobody
            believes, so the honest line has to come first and there has to be
            no claim underneath it to undo.

            Set as plain type, not as a panel - see the `.app-footer-notice`
            note in the stylesheet for why a red box was the wrong call. The
            four things it has to carry, in one sentence after the lead: it is
            a prototype, it is academic, the data is demo, and nothing here
            books anything or advises anyone. */}
        <p className="app-footer-notice">
          <strong>Prototype — not a real booking platform.</strong> BookMyDoc is
          an academic demonstration: the doctors, clinics and availability are
          demo data, and nothing here books a real appointment or gives
          medical advice.
        </p>

        <p className="app-footer-copy tiny muted">
          © {new Date().getFullYear()} BookMyDoc
        </p>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ *
 *  First-load prototype notice                                        *
 * ------------------------------------------------------------------ */

const NOTICE_KEY = "bookmydoc_prototype_notice";

/**
 * The footer's notice, said once on arrival instead of scrolled to.
 *
 * A footer disclaimer is only read by people who scroll to the end, and this
 * build looks enough like a real booking platform that the distinction has to
 * land before anyone types a real appointment into it. So the same wording,
 * once per browser session.
 *
 * sessionStorage rather than localStorage on purpose: a reminder that never
 * comes back is a reminder nobody reads, and a modal that reappears on every
 * single reload is the thing people learn to dismiss without looking at. A new
 * tab or a new session gets it again; navigating around this one does not.
 *
 * Portalled to `<body>` for the same reason as the menu sheet — the sticky
 * header owns a `backdrop-filter`, which makes it the containing block for
 * fixed children, so an overlay rendered inside it would be clipped to the
 * 64px bar.
 */
export function PrototypeNotice() {
  const [open, setOpen] = useState(() => {
    try {
      return !sessionStorage.getItem(NOTICE_KEY);
    } catch {
      // Storage blocked (private mode, disabled cookies): show it, rather than
      // let a failed read read as "already seen".
      return true;
    }
  });

  const panelRef = useRef(null);
  const dismissRef = useRef(null);

  const close = useCallback(() => {
    try {
      sessionStorage.setItem(NOTICE_KEY, "seen");
    } catch {
      // Nothing to persist to. It will simply be offered again next session,
      // which is the safe direction to fail.
    }
    setOpen(false);
  }, []);

  // No `returnRef`: nothing opened this, so there is nothing to hand focus
  // back to.
  useModalLayer({ open, onClose: close, panelRef, closeRef: dismissRef });

  if (!open) return null;

  return createPortal(
    <div className="notice-backdrop" onClick={close}>
      <div
        className="notice-card"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prototype-notice-title"
        aria-describedby="prototype-notice-body"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="notice-icon" aria-hidden="true">
          ⚠️
        </div>
        <h2 className="notice-title" id="prototype-notice-title">
          Prototype — not a real booking platform
        </h2>
        <p className="notice-body" id="prototype-notice-body">
          BookMyDoc is an academic demonstration: the doctors, clinics and
          availability are demo data, and nothing here books a real appointment
          or gives medical advice.
        </p>
        <button
          type="button"
          ref={dismissRef}
          className="btn btn-primary btn-block"
          onClick={close}
        >
          Got it
        </button>
      </div>
    </div>,
    document.body,
  );
}

export default Header;
