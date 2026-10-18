import { Suspense, lazy, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { Header, Footer, PrototypeNotice, homeFor } from "./components/Layout.jsx";
import { Loading } from "./components/ui.jsx";
import { useAuth } from "./context/AuthContext.jsx";
import { useNotifications } from "./context/NotificationsContext.jsx";
import ChatWidget from "./components/ChatWidget.jsx";

// Eager: the landing page and the authentication screens are the critical path,
// so they stay in the entry chunk and never wait on a network round trip.
import PublicHome from "./pages/PublicHome.jsx";
import Login from "./pages/Login.jsx";
import Register from "./pages/Register.jsx";

/** Renders the catch-all. Eager, not lazy: it is the route every unmatched URL
 *  lands on, so lazy-loading it would put a spinner in front of the one page
 *  whose whole job is to explain that nothing loaded. It costs about a kilobyte
 *  in the entry chunk. */
import NotFound from "./pages/NotFound.jsx";

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
const AdminAppointments = lazy(() => import("./pages/admin/AdminAppointments.jsx"));
const AdminQueue = lazy(() => import("./pages/admin/AdminQueue.jsx"));
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
 *  Scroll restoration                                                 *
 * ------------------------------------------------------------------ */

/**
 * Start a new page at its top.
 *
 * A single-page app does not get this for free: the browser restores the
 * previous document's scroll offset on a real page load, but a client-side
 * navigation reuses the same document, so arriving at a new route from the
 * bottom of a long list leaves the viewport where the old page was scrolled to.
 * Reading a row of that list's table then looks like a blank page.
 *
 * Keyed on `pathname` and NOT on the whole location: `/doctors/:id?book=1`
 * switches the doctor profile between its overview and booking tabs, and that is
 * the same page. Resetting scroll there would throw the visitor to the top of
 * the tab they just opened.
 *
 * `instant` is deliberate. React Router's own scroll restoration animates,
 * which turns every navigation into a visible glide from the old position; this
 * is a jump to a known-good offset and should not be animated.
 */
function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [pathname]);

  return null;
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
    if (!booting && user) document.title = `BookMyDoc · ${user.role} dashboard`;
  }, [user, booting]);

  // The assistant helps people find care and understand their appointments, so
  // it is the patient side of the product only: a doctor or admin signing in
  // and the console they land on never see it. Signed-out visitors still get
  // it on the public pages, where asking stays blocked until they sign in.
  // Hidden while the session is being restored so staff never watch it appear
  // for a frame before it is taken away again.
  const showChat = !booting && (!user || user.role === "patient");

  return (
    <div
      // The floating assistant is fixed to the bottom-right of the viewport,
      // so it sits on top of the footer's last line. The shell says whether it
      // is mounted and the footer reserves room accordingly - doctor and admin
      // never render the widget, so they should not carry the empty space.
      className={`app-shell${showChat ? " has-chat-widget" : ""}`}
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <Header unread={unread} />

      <main style={{ flex: 1 }}>
        {/* Mounted above <Routes> so it sees the committed location. */}
        <ScrollToTop />
        {/* One loading fallback for every lazy route. It sits inside <main> so
            the header and footer stay on screen while a chunk loads. */}
        <Suspense fallback={<Loading label="Loading page…" />}>
          <Routes>
          {/* ---------- public ---------- */}
          {/* The landing page is consumer marketing: how to book, who the
              doctors are, why this is worth using. Staff do not book anything,
              so showing it to them is showing them a sales page for a product
              they already work inside. A signed-in doctor or admin who lands on
              `/` - by typing it, by an old bookmark, by the brand logo - is
              sent straight to their own console instead.

              Patients are deliberately NOT redirected. They are the audience
              the page is written for, and bouncing a patient off the marketing
              page they chose to read would be the same mistake in reverse.

              Waited on `booting` rather than redirecting from `user` alone: on
              a cold load the session is not known yet, and redirecting on the
              `!user` that comes back before the session restore resolves would
              send a signed-in doctor to the public page for a frame, then back
              again. */}
          <Route
            path="/"
            element={
              booting ? (
                <Loading label="Restoring your session…" />
              ) : user && user.role !== "patient" ? (
                <Navigate to={homeFor(user.role)} replace />
              ) : (
                <PublicHome />
              )
            }
          />
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

          {/* Open to signed-out visitors: it only explains how the product works
              and cannot see or do anything on an account. Asking a question
              needs a session, which the page explains in place. */}
          {/* The assistant is now a floating widget on every page instead. */}

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
          {/* `/my-schedule`, not `/provider`. The nav has always called this
              screen "My schedule", and the patient side already pairs a plain
              route with a `My …` label (`/appointments` → "My appointments"),
              so this follows a convention the app had rather than inventing
              one. It also keeps the doctor's private area clearly distinct from
              the public `/doctors/:id` profiles, which `/doctor` would have
              put one letter away. */}
          <Route
            path="/my-schedule"
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
          <Route
            path="/admin/appointments"
            element={
              <Protected roles={["admin"]}>
                <AdminAppointments />
              </Protected>
            }
          />
          <Route
            path="/admin/queue"
            element={
              <Protected roles={["admin"]}>
                <AdminQueue />
              </Protected>
            }
          />

          {/* ---------- fallbacks ---------- */}
          {/* An unknown URL renders the not-found page IN PLACE, keeping the
              path the visitor asked for on screen. It used to redirect to the
              role's home, which was silent: a mistyped URL, a stale bookmark and
              a broken link all looked identical to "nothing is here", with no
              way for the visitor to tell a typo from a dead link.

              `booting` matters — NotFound waits for the session restore before
              offering a destination, so a signed-in visitor is never briefly
              shown a signed-out landing page as their way out. */}
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
      </main>

      <Footer />

      {/* Said once on arrival rather than left in the footer to be scrolled
          to. Renders above the assistant, which it does not gate. */}
      <PrototypeNotice />

      {showChat && <ChatWidget />}
    </div>
  );
}
