import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { homeFor } from "../components/Layout.jsx";
import { Alert, Spinner } from "../components/ui.jsx";

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
      // Where they were trying to reach wins; otherwise their own dashboard.
      // The query string travels too, so a doctor page opened with ?book=1
      // comes back on the booking tab rather than the overview.
      const from = location.state?.from;
      navigate(
        from ? `${from.pathname}${from.search || ""}` : homeFor(user.role),
        { replace: true },
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page-glass-bg">
      <div className="container auth-wrap">
        <div className="card card-pad stack">
          <div className="auth-brand">
            <img
              className="mark"
              src="/logo-mark.svg"
              alt=""
              width="34"
              height="34"
            />
            <strong style={{ fontSize: "1.1rem" }}>BookMyDoc</strong>
          </div>
          <div className="center">
            <h1 style={{ marginBottom: "0.2rem" }}>Welcome Back</h1>
            <p className="small muted">Login to your account</p>
          </div>

          {error && <Alert tone="danger">{error}</Alert>}

          <form onSubmit={submit} className="stack">
            <div className="field">
              <label className="label" htmlFor="email">
                Email Address
              </label>
              <input
                id="email"
                type="email"
                className="input"
                autoComplete="email"
                placeholder="Enter your email"
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
                placeholder="Enter your password"
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
              {busy ? <Spinner /> : "Login"}
            </button>
          </form>

          <p className="small center muted">
            Don&apos;t have an account? <Link to="/register">Sign Up</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
