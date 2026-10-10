import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { Alert, Spinner } from "../components/ui.jsx";

export default function Register() {
  const { register } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    phone: "",
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        phone: form.phone.trim(),
      });
      toast.success("Account created — welcome to MediCare");
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div
        className="container"
        style={{ maxWidth: 440, paddingTop: "2rem", paddingBottom: "3rem" }}
      >
        <div className="card card-pad stack">
          <div>
            <h1 style={{ marginBottom: "0.2rem" }}>Create your account</h1>
            <p className="small muted">
              Book and manage appointments with doctors near you.
            </p>
          </div>

          {error && <Alert tone="danger">{error}</Alert>}

          <form onSubmit={submit} className="stack">
            <div className="field">
              <label className="label" htmlFor="name">
                Full name
              </label>
              <input
                id="name"
                className="input"
                placeholder="Rahul Verma"
                value={form.name}
                onChange={set("name")}
                minLength={2}
                required
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="input"
                placeholder="you@example.com"
                value={form.email}
                onChange={set("email")}
                required
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="phone">
                Phone <span className="muted">(for reminders)</span>
              </label>
              <input
                id="phone"
                className="input"
                placeholder="+91 90000 00000"
                value={form.phone}
                onChange={set("phone")}
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
                placeholder="At least 6 characters"
                value={form.password}
                onChange={set("password")}
                minLength={6}
                required
              />
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={busy}
            >
              {busy ? <Spinner /> : "Create account"}
            </button>
          </form>

          <p className="small center muted">
            Already registered? <Link to="/login">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
