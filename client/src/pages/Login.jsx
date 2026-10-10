import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { Alert, Spinner } from "../components/ui.jsx";

/** One-click fill so reviewers can jump between the three roles fast. */
const DEMO = [
  { label: "Patient", email: "patient@demo.com", password: "patient123" },
  { label: "Doctor", email: "doctor1@demo.com", password: "doctor123" },
  { label: "Admin", email: "admin@demo.com", password: "admin123" },
];

export default function Login() {
  const { login } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(email.trim(), password);
      toast.success(`Welcome back, ${user.name.split(" ")[0]}`);
      const fallback =
        user.role === "admin"
          ? "/admin"
          : user.role === "doctor"
            ? "/provider"
            : "/";
      navigate(location.state?.from?.pathname || fallback, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const useDemo = (d) => {
    setEmail(d.email);
    setPassword(d.password);
    setError(null);
  };

  return (
    <div className="page">
      <div
        className="container"
        style={{ maxWidth: 440, paddingTop: "2rem", paddingBottom: "3rem" }}
      >
        <div className="card card-pad stack">
          <div>
            <h1 style={{ marginBottom: "0.2rem" }}>Welcome back</h1>
            <p className="small muted">Sign in to manage your appointments.</p>
          </div>

          {error && <Alert tone="danger">{error}</Alert>}

          <form onSubmit={submit} className="stack">
            <div className="field">
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="input"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="input"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={busy}
            >
              {busy ? <Spinner /> : "Sign in"}
            </button>
          </form>

          <p className="small center muted">
            New here? <Link to="/register">Create a patient account</Link>
          </p>

          <div className="divider" />

          <div className="stack-sm">
            <span
              className="tiny muted bold"
              style={{ textTransform: "uppercase" }}
            >
              Demo accounts — click to fill
            </span>
            <div className="row" style={{ gap: "0.4rem" }}>
              {DEMO.map((d) => (
                <button
                  key={d.label}
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ flex: 1 }}
                  onClick={() => useDemo(d)}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <p className="tiny muted" style={{ margin: 0 }}>
              patient@demo.com · doctor1@demo.com · admin@demo.com
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
