import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import api from "../api/client";
import { useAuth } from "../context/AuthContext.jsx";
import { Avatar } from "./ui.jsx";
import { colorFrom, cx } from "../utils/format";

/* ------------------------------------------------------------------ *
 *  Role-aware navigation                                             *
 * ------------------------------------------------------------------ */
const NAV = {
  patient: [
    { to: "/dashboard", label: "Dashboard", end: true },
    { to: "/doctors", label: "Find a doctor" },
    { to: "/appointments", label: "My appointments" },
    { to: "/notifications", label: "Notifications" },
    { to: "/help", label: "Help" },
    { to: "/profile", label: "Profile" },
  ],
  doctor: [
    { to: "/provider", label: "My schedule" },
    { to: "/doctors", label: "Directory" },
    { to: "/notifications", label: "Notifications" },
    { to: "/help", label: "Help" },
    { to: "/profile", label: "Profile" },
  ],
  admin: [
    { to: "/admin", label: "Dashboard", end: true },
    { to: "/admin/doctors", label: "Doctors" },
    { to: "/admin/facilities", label: "Facilities" },
    { to: "/admin/patients", label: "Patients" },
    { to: "/admin/notifications", label: "Notification log" },
    { to: "/profile", label: "Profile" },
  ],
};

export function Header({ unread = 0 }) {
  const { user, logout, role } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile menu whenever the route changes.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const links = user ? NAV[role] || NAV.patient : [];

  const onLogout = async () => {
    // Awaited before navigating: /login is a guest-only route, so navigating
    // while `user` is still set would bounce straight back to the dashboard.
    await logout();
    navigate("/login");
  };

  return (
    <header
      style={{
        height: "var(--header-h)",
        background: "#fff",
        borderBottom: "1px solid var(--gray-200)",
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}
    >
      <div className="container row" style={{ height: "100%", gap: "1.5rem" }}>
        <Link
          to={user ? homeFor(role) : "/"}
          className="row"
          style={{ gap: "0.55rem", flexShrink: 0 }}
        >
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              background:
                "linear-gradient(135deg, var(--brand-600), var(--brand-900))",
              color: "#fff",
              display: "grid",
              placeItems: "center",
              fontWeight: 800,
              fontSize: "0.95rem",
            }}
          >
            +
          </span>
          <strong style={{ fontSize: "1.05rem" }}>MediCare</strong>
        </Link>

        {user && (
          <nav className="row hide-sm" style={{ gap: "0.35rem", flex: 1 }}>
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                className={({ isActive }) =>
                  cx("btn btn-ghost btn-sm", isActive && "btn-secondary")
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
            {role === "patient" && (
              <Link
                to="/notifications"
                className="btn btn-ghost btn-icon hide-sm"
                title="Notifications"
                style={{ position: "relative" }}
              >
                🔔
                {unread > 0 && (
                  <span
                    style={{
                      position: "absolute",
                      top: 2,
                      right: 2,
                      minWidth: 15,
                      height: 15,
                      padding: "0 3px",
                      borderRadius: 999,
                      background: "var(--danger)",
                      color: "#fff",
                      fontSize: "0.62rem",
                      fontWeight: 700,
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </Link>
            )}

            <div className="row hide-sm" style={{ gap: "0.5rem" }}>
              <Avatar
                name={user.name}
                color={colorFrom(user.email)}
                size="sm"
              />
              <div style={{ lineHeight: 1.25 }}>
                <div className="small bold">{user.name}</div>
                <div
                  className="tiny muted"
                  style={{ textTransform: "capitalize" }}
                >
                  {role}
                </div>
              </div>
            </div>

            <button
              type="button"
              className="btn btn-secondary btn-sm hide-sm"
              onClick={onLogout}
            >
              Sign out
            </button>
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
            className="btn btn-ghost btn-icon"
            style={{ display: menuOpen ? "none" : undefined }}
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
          >
            ☰
          </button>
        )}
      </div>

      {/* mobile drawer */}
      {user && menuOpen && (
        <div
          className="card"
          style={{
            position: "absolute",
            top: "var(--header-h)",
            left: 0,
            right: 0,
            borderRadius: 0,
            boxShadow: "var(--shadow-lg)",
            zIndex: 99,
          }}
        >
          <div className="card-body stack-sm">
            <div className="row">
              <Avatar
                name={user.name}
                color={colorFrom(user.email)}
                size="sm"
              />
              <div>
                <div className="small bold">{user.name}</div>
                <div className="tiny muted">{user.email}</div>
              </div>
            </div>
            <div className="divider" />
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                className={({ isActive }) =>
                  cx("btn btn-ghost", isActive && "btn-secondary")
                }
                style={{ justifyContent: "flex-start" }}
              >
                {l.label}
              </NavLink>
            ))}
            <div className="divider" />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onLogout}
            >
              Sign out
            </button>
          </div>
        </div>
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
  if (role === "doctor") return "/provider";
  if (role === "patient") return "/dashboard";
  return "/";
}

/* ------------------------------------------------------------------ *
 *  Footer                                                            *
 * ------------------------------------------------------------------ */
export function Footer() {
  return (
    <footer
      style={{
        borderTop: "1px solid var(--gray-200)",
        background: "#fff",
        padding: "1.5rem 0",
        marginTop: "auto",
      }}
    >
      <div className="container row-between small muted">
        <span>© {new Date().getFullYear()} MediCare — academic prototype</span>
        <span>Demo data only. Not for real patient care.</span>
      </div>
    </footer>
  );
}

export default Header;
