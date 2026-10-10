import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { Header, Footer, homeFor } from "./components/Layout.jsx";
import { Loading } from "./components/ui.jsx";
import { useAuth } from "./context/AuthContext.jsx";
import { useNotifications } from "./hooks/useNotifications.js";

// public
import Home from "./pages/Home.jsx";
import Login from "./pages/Login.jsx";
import Register from "./pages/Register.jsx";
import DoctorDirectory from "./pages/DoctorDirectory.jsx";
import DoctorProfile from "./pages/DoctorProfile.jsx";

// patient
import MyAppointments from "./pages/MyAppointments.jsx";
import Notifications from "./pages/Notifications.jsx";
import Profile from "./pages/Profile.jsx";

// provider
import ProviderDashboard from "./pages/ProviderDashboard.jsx";

// admin
import AdminDashboard from "./pages/admin/AdminDashboard.jsx";
import AdminDoctors from "./pages/admin/AdminDoctors.jsx";
import AdminFacilities from "./pages/admin/AdminFacilities.jsx";
import AdminPatients from "./pages/admin/AdminPatients.jsx";
import AdminNotifications from "./pages/admin/AdminNotifications.jsx";

/* ------------------------------------------------------------------ *
 *  Route guard                                                       *
 * ------------------------------------------------------------------ */
function Protected({ children, roles }) {
  const { user, booting } = useAuth();
  const location = useLocation();

  if (booting) return <Loading label="Restoring your session…" />;
  if (!user) {
    // Remember where they were headed so login can bounce them back.
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (roles && !roles.includes(user.role)) {
    return <Navigate to={homeFor(user.role)} replace />;
  }
  return children;
}

/** Signed-in users skip the login/register screens. */
function GuestOnly({ children }) {
  const { user, booting } = useAuth();
  if (booting) return <Loading />;
  if (user) return <Navigate to={homeFor(user.role)} replace />;
  return children;
}

/* ------------------------------------------------------------------ *
 *  App shell                                                         *
 * ------------------------------------------------------------------ */
export default function App() {
  const { user, booting } = useAuth();
  const { unread } = useNotifications({ poll: Boolean(user) });

  // Land signed-in users on the dashboard for their role.
  useEffect(() => {
    if (!booting && user) document.title = `MediCare · ${user.role} dashboard`;
  }, [user, booting]);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <Header unread={unread} />

      <main style={{ flex: 1 }}>
        <Routes>
          {/* ---------- public ---------- */}
          <Route path="/" element={<Home />} />
          <Route
            path="/login"
            element={
              <GuestOnly>
                <Login />
              </GuestOnly>
            }
          />
          <Route
            path="/register"
            element={
              <GuestOnly>
                <Register />
              </GuestOnly>
            }
          />
          <Route path="/doctors" element={<DoctorDirectory />} />
          <Route path="/doctors/:id" element={<DoctorProfile />} />

          {/* ---------- patient ---------- */}
          <Route
            path="/appointments"
            element={
              <Protected roles={["patient"]}>
                <MyAppointments />
              </Protected>
            }
          />
          <Route
            path="/notifications"
            element={
              <Protected>
                <Notifications />
              </Protected>
            }
          />
          <Route
            path="/profile"
            element={
              <Protected>
                <Profile />
              </Protected>
            }
          />

          {/* ---------- provider ---------- */}
          <Route
            path="/provider"
            element={
              <Protected roles={["doctor"]}>
                <ProviderDashboard />
              </Protected>
            }
          />

          {/* ---------- admin ---------- */}
          <Route
            path="/admin"
            element={
              <Protected roles={["admin"]}>
                <AdminDashboard />
              </Protected>
            }
          />
          <Route
            path="/admin/doctors"
            element={
              <Protected roles={["admin"]}>
                <AdminDoctors />
              </Protected>
            }
          />
          <Route
            path="/admin/facilities"
            element={
              <Protected roles={["admin"]}>
                <AdminFacilities />
              </Protected>
            }
          />
          <Route
            path="/admin/patients"
            element={
              <Protected roles={["admin"]}>
                <AdminPatients />
              </Protected>
            }
          />
          <Route
            path="/admin/notifications"
            element={
              <Protected roles={["admin"]}>
                <AdminNotifications />
              </Protected>
            }
          />

          {/* ---------- fallbacks ---------- */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <Footer />
    </div>
  );
}
