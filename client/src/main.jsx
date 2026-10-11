import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { AuthProvider } from "./context/AuthContext.jsx";
import { ToastProvider } from "./context/ToastContext.jsx";
import { NotificationsProvider } from "./context/NotificationsContext.jsx";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import "./styles/index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          {/* One notification owner for the whole app: a single unread count
              and a single poller, instead of one per consumer. */}
          <NotificationsProvider>
            {/* Above everything the app renders, so a crash anywhere below
                still leaves the user a page with a working way out. */}
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </NotificationsProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
