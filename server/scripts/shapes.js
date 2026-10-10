/** Dump the exact response shape of every endpoint the client consumes. */
const BASE = "http://localhost:5000/api";

const call = async (p, opts = {}) => {
  const res = await fetch(`${BASE}${p}`, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  return res.json();
};

const login = async (email, password) =>
  (await call("/auth/login", { method: "POST", body: { email, password } }))
    .data.token;

const keysOf = (o) =>
  o && typeof o === "object" ? Object.keys(o).join(", ") : `<${typeof o}>`;

const show = async (label, p, opts) => {
  const j = await call(p, opts);
  const d = j.data;
  console.log(`\n### ${label}`);
  console.log(`  top: ${keysOf(d)}`);
  if (Array.isArray(d)) {
    console.log(`  [0]: ${keysOf(d[0])}`);
  } else if (d) {
    for (const [k, v] of Object.entries(d)) {
      if (Array.isArray(v)) console.log(`  .${k}[]: ${keysOf(v[0])}`);
      else if (v && typeof v === "object") console.log(`  .${k}: ${keysOf(v)}`);
    }
  }
  if (!j.success) console.log(`  ERROR: ${j.message}`);
};

const run = async () => {
  const pt = await login("patient@demo.com", "patient123");
  const at = await login("admin@demo.com", "admin123");
  const dt = await login("doctor1@demo.com", "doctor123");

  const docs = await call("/doctors?limit=2", { token: pt });
  const docId = docs.data.doctors[0].id;

  await show("auth/me", "/auth/me", { token: pt });
  await show("doctors/specialties", "/doctors/specialties", { token: pt });
  await show("doctors/services", "/doctors/services", { token: pt });
  await show("doctors/facilities", "/doctors/facilities", { token: pt });
  await show("doctors (list)", "/doctors?limit=2", { token: pt });
  await show("doctors/recommended", "/doctors/recommended", { token: pt });
  await show("doctors/:id", `/doctors/${docId}`, { token: pt });
  await show("doctors/:id/slots", `/doctors/${docId}/slots`, { token: pt });
  await show("doctors/me/schedule", "/doctors/me/schedule", { token: dt });
  await show("appointments", "/appointments", { token: pt });
  await show("appointments/queue", `/appointments/queue?doctorId=${docId}`, {
    token: pt,
  });
  await show(
    "appointments/availability",
    `/appointments/availability?doctorId=${docId}`,
    { token: pt },
  );
  await show("notifications", "/notifications", { token: pt });
  await show("ai/triage", "/ai/triage", {
    method: "POST",
    token: pt,
    body: { description: "migraine and fever" },
  });
  await show("ai/provider", "/ai/provider", {});
  await show("admin/overview", "/admin/overview", { token: at });
  await show("admin/doctors", "/admin/doctors", { token: at });
  await show("admin/facilities", "/admin/facilities", { token: at });
  await show("admin/services", "/admin/services", { token: at });
  await show("admin/patients", "/admin/patients", { token: at });
  await show("admin/notifications", "/admin/notifications", { token: at });
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
