import { useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { Alert, Avatar, Spinner } from "../components/ui.jsx";
import { colorFrom, label } from "../utils/format";
import { cx } from "../utils/format";

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

/* Only sections the app actually has. The reference mockup lists more
   (addresses, payments, privacy), but those pages do not exist — a menu
   item that goes nowhere is decoration, not navigation. */
const SECTIONS = [
  { key: "personal", label: "Personal Information", icon: "👤" },
  { key: "medical", label: "Medical Information", icon: "🩺" },
];

/* Every field the form edits, used only to measure completeness from real,
   current values — nothing here is stored or sent anywhere new. */
const COMPLETENESS_FIELDS = [
  { key: "name", label: "Full name", section: "personal" },
  { key: "phone", label: "Phone number", section: "personal" },
  { key: "dateOfBirth", label: "Date of birth", section: "medical" },
  { key: "gender", label: "Gender", section: "medical" },
  { key: "bloodGroup", label: "Blood group", section: "medical" },
  { key: "address", label: "Address", section: "medical" },
  { key: "emergencyContact", label: "Emergency contact", section: "medical" },
  { key: "allergies", label: "Allergies", section: "medical" },
];

export default function Profile() {
  const { user, updateProfile } = useAuth();
  const toast = useToast();

  const [section, setSection] = useState("personal");
  const [form, setForm] = useState({
    name: user?.name || "",
    phone: user?.phone || "",
    dateOfBirth: user?.profile?.dateOfBirth || "",
    gender: user?.profile?.gender || "",
    bloodGroup: user?.profile?.bloodGroup || "",
    address: user?.profile?.address || "",
    emergencyContact: user?.profile?.emergencyContact || "",
    allergies: (user?.profile?.allergies || []).join(", "),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await updateProfile({
        name: form.name.trim(),
        phone: form.phone.trim(),
        profile: {
          dateOfBirth: form.dateOfBirth || null,
          gender: form.gender || null,
          bloodGroup: form.bloodGroup || null,
          address: form.address.trim(),
          emergencyContact: form.emergencyContact.trim(),
          allergies: form.allergies
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean),
        },
      });
      toast.success("Profile updated");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const filled = COMPLETENESS_FIELDS.filter((f) =>
    String(form[f.key] || "").trim(),
  ).length;
  const pct = Math.round((filled / COMPLETENESS_FIELDS.length) * 100);

  return (
    <div className="page page-glass-bg">
      <div className="container profile-layout">
        {/* ---------- identity cover ---------- */}
        <div className="card profile-cover">
          <div className="profile-cover-inner">
            <Avatar
              name={user?.name}
              color={colorFrom(user?.email)}
              size="xl"
              className="profile-avatar"
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row row-wrap" style={{ gap: "0.5rem" }}>
                <h1 className="profile-name">{user?.name}</h1>
              </div>
              <div className="small muted truncate">{user?.email}</div>
              <div
                className="row row-wrap"
                style={{ gap: "0.35rem", marginTop: "0.5rem" }}
              >
                <span className="badge badge-brand">{label(user?.role)}</span>
                {form.bloodGroup && (
                  <span className="badge badge-danger">
                    🩸 {form.bloodGroup}
                  </span>
                )}
                {form.dateOfBirth && (
                  <span className="badge">{form.dateOfBirth}</span>
                )}
              </div>
            </div>
            <div className="profile-complete-mini">
              <div className="stat-value" style={{ fontSize: "1.5rem" }}>
                {pct}%
              </div>
              <div className="tiny muted">complete</div>
            </div>
          </div>
        </div>

        <div className="profile-grid">
          {/* ---------- side rail ---------- */}
          <aside className="stack">
            <nav
              className="card card-pad stack-sm"
              role="tablist"
              aria-label="Profile sections"
            >
              {SECTIONS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  role="tab"
                  aria-selected={section === s.key}
                  className={cx(
                    "btn btn-block",
                    section === s.key ? "btn-primary" : "btn-ghost",
                  )}
                  style={{ justifyContent: "flex-start" }}
                  onClick={() => setSection(s.key)}
                >
                  <span aria-hidden="true">{s.icon}</span> {s.label}
                </button>
              ))}
            </nav>

            <div className="card card-pad">
              <div className="tiny muted">
                🔒 Your health details are only visible to you and the doctors
                you book with.
              </div>
            </div>
          </aside>

          {/* ---------- form ---------- */}
          <div className="card">
            <div className="card-head">
              <div>
                <h3>
                  {section === "personal"
                    ? "Personal information"
                    : "Medical information"}
                </h3>
                <p className="small muted" style={{ margin: 0 }}>
                  {section === "personal"
                    ? "How the clinic identifies and reaches you."
                    : "Helps your doctor prepare before the visit."}
                </p>
              </div>
            </div>
            <div className="card-body">
              <form onSubmit={submit} className="stack">
                {error && <Alert tone="danger">{error}</Alert>}

                {section === "personal" && (
                  <>
                    <div className="grid grid-2">
                      <div className="field">
                        <label className="label" htmlFor="p-name">
                          Full name
                        </label>
                        <input
                          id="p-name"
                          className="input"
                          value={form.name}
                          onChange={set("name")}
                          required
                        />
                      </div>
                      <div className="field">
                        <label className="label" htmlFor="p-phone">
                          Phone
                        </label>
                        <input
                          id="p-phone"
                          className="input"
                          value={form.phone}
                          onChange={set("phone")}
                          placeholder="+91…"
                        />
                      </div>
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="p-email">
                        Email
                      </label>
                      <input
                        id="p-email"
                        className="input"
                        value={user?.email || ""}
                        disabled
                      />
                      <span className="tiny muted">
                        Identifies your account — contact support to change it.
                      </span>
                    </div>
                  </>
                )}

                {section === "medical" && (
                  <>
                    <div className="grid grid-3">
                      <div className="field">
                        <label className="label" htmlFor="p-dob">
                          Date of birth
                        </label>
                        <input
                          id="p-dob"
                          type="date"
                          className="input"
                          value={form.dateOfBirth}
                          onChange={set("dateOfBirth")}
                        />
                      </div>
                      <div className="field">
                        <label className="label" htmlFor="p-gender">
                          Gender
                        </label>
                        <select
                          id="p-gender"
                          className="select"
                          value={form.gender}
                          onChange={set("gender")}
                        >
                          <option value="">Prefer not to say</option>
                          <option value="male">Male</option>
                          <option value="female">Female</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                      <div className="field">
                        <label className="label" htmlFor="p-blood">
                          Blood group
                        </label>
                        <select
                          id="p-blood"
                          className="select"
                          value={form.bloodGroup}
                          onChange={set("bloodGroup")}
                        >
                          <option value="">Unknown</option>
                          {BLOOD_GROUPS.map((b) => (
                            <option key={b} value={b}>
                              {b}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="field">
                      <label className="label" htmlFor="p-address">
                        Address
                      </label>
                      <input
                        id="p-address"
                        className="input"
                        value={form.address}
                        onChange={set("address")}
                        placeholder="Street, city"
                      />
                    </div>

                    <div className="grid grid-2">
                      <div className="field">
                        <label className="label" htmlFor="p-emergency">
                          Emergency contact
                        </label>
                        <input
                          id="p-emergency"
                          className="input"
                          value={form.emergencyContact}
                          onChange={set("emergencyContact")}
                          placeholder="Name + number"
                        />
                      </div>
                      <div className="field">
                        <label className="label" htmlFor="p-allergies">
                          Allergies
                        </label>
                        <input
                          id="p-allergies"
                          className="input"
                          value={form.allergies}
                          onChange={set("allergies")}
                          placeholder="Comma separated, e.g. Penicillin"
                        />
                      </div>
                    </div>
                  </>
                )}

                <div className="profile-savebar">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={busy}
                  >
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                  <span className="tiny muted">
                    Changes apply to your account immediately.
                  </span>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
