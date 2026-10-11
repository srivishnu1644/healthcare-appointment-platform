import { Suspense, lazy, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { Header, Footer, homeFor } from "./components/Layout.jsx";
import { Loading } from "./components/ui.jsx";
import { useAuth } from "./context/AuthContext.jsx";
import { useNotifications } from "./context/NotificationsContext.jsx";

// Eager: the landing page and the authentication screens are the critical path,
// so they stay in the entry chunk and never wait on a network round trip.
import PublicHome from "./pages/PublicHome.jsx";
import Login from "./pages/Login.jsx";
import Register from "./pages/Register.jsx";

// Lazy: every route reached after that becomes its own chunk, fetched on the
// first navigation to it. A patient who never opens the admin area never
// downloads it.
const DoctorDirectory = lazy(() => import("./pages/DoctorDirectory.jsx"));
const DoctorProfile = lazy(() => import("./pages/DoctorProfile.jsx"));

const PatientDashboard = lazy(() => import("./pages/PatientDashboard.jsx"));
const MyAppointments = lazy(() => import("./pages/MyAppointments.jsx"));
const AppointmentDetail = lazy(() => import("./pages/AppointmentDetail.jsx"));
const Notifications = lazy(() => import("./pages/Notifications.jsx"));
const Profile = lazy(() => import("./pages/Profile.jsx"));

const ProviderDashboard = lazy(() => import("./pages/ProviderDashboard.jsx"));

const AdminDashboard = lazy(() => import("./pages/admin/AdminDashboard.jsx"));
const AdminDoctors = lazy(() => import("./pages/admin/AdminDoctors.jsx"));
const AdminFacilities = lazy(() => import("./pages/admin/AdminFacilities.jsx"));
const AdminPatients = lazy(() => import("./pages/admin/AdminPatients.jsx"));
const AdminNotifications = lazy(() => import("./pages/admin/AdminNotifications.jsx"));

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
  const location = useLocation();
  if (booting) return <Loading />;

  // A guarded redirect to /login carries the page the visitor was trying to
  // reach, and the sign-in form navigates there itself once it succeeds.
  // Redirecting here as well races that: both run off the same `user` update,
  // so whichever lands first wins and the visitor is sent to their dashboard
  // instead of the page they asked for. Standing aside lets the form's own
  // navigation be the only one. Reaching /login without that state (a
  // signed-in user typing the URL) still redirects as before.
  const signInWillHandleIt =
    location.pathname === "/login" && Boolean(location.state?.from);

  if (user && !signInWillHandleIt) return <Navigate to={homeFor(user.role)} replace />;
  return children;
}

/* ------------------------------------------------------------------ *
 *  App shell                                                         *
 * ------------------------------------------------------------------ */
export default function App() {
  const { user, booting } = useAuth();
  // Subscribes to the app-wide notification state; the provider owns the
  // fetching and the polling.
  const { unread } = useNotifications();

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
        {/* One loading fallback for every lazy route. It sits inside <main> so
            the header and footer stay on screen while a chunk loads. */}
        <Suspense fallback={<Loading label="Loading page…" />}>
          <Routes>
          {/* ---------- public ---------- */}
          <Route path="/" element={<PublicHome />} />
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
            path="/dashboard"
            element={
              <Protected roles={["patient"]}>
                <PatientDashboard />
              </Protected>
            }
          />
          <Route
            path="/appointments"
            element={
              <Protected roles={["patient"]}>
                <MyAppointments />
              </Protected>
            }
          />
          <Route
            path="/appointments/:id"
            element={
              <Protected roles={["patient"]}>
                <AppointmentDetail />
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
          {/* Unknown URL: send a signed-in user to their own dashboard and an
              anonymous visitor to the public landing page. */}
          <Route
            path="*"
            element={<Navigate to={homeFor(user?.role)} replace />}
          />
        </Routes>
        </Suspense>
      </main>

      <Footer />
    </div>
  );
}
