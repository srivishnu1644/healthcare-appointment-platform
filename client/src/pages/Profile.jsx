import { useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { Alert, Avatar, Spinner } from "../components/ui.jsx";
import { colorFrom, label } from "../utils/format";

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

export default function Profile() {
  const { user, updateProfile } = useAuth();
  const toast = useToast();

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

  return (
    <div className="page">
      <div className="container" style={{ maxWidth: 640 }}>
        <div className="page-head">
          <h1>My profile</h1>
          <p>
            Keep your contact and health details up to date for better care.
          </p>
        </div>

        <div className="card">
          <div className="card-head">
            <div className="row">
              <Avatar
                name={user?.name}
                color={colorFrom(user?.email)}
                size="lg"
              />
              <div>
                <h3 style={{ margin: 0 }}>{user?.name}</h3>
                <div className="small muted">{user?.email}</div>
                <span className="badge badge-brand">{label(user?.role)}</span>
              </div>
            </div>
          </div>

          <div className="card-body">
            <form onSubmit={submit} className="stack">
              {error && <Alert tone="danger">{error}</Alert>}

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

              <Alert tone="info">
                🔒 Your health details are only visible to you and the doctors
                you book with. Never share passwords with anyone.
              </Alert>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy}
                style={{ alignSelf: "flex-start" }}
              >
                {busy ? <Spinner /> : "Save changes"}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
