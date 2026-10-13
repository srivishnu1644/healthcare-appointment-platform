#!/usr/bin/env node
/**
 * Dumps the real Express route table.
 *
 * Phase 15 documentation is generated from this rather than transcribed by
 * hand, because a hand-written endpoint list is exactly the kind of document
 * that is wrong within a month. Every path, method and middleware name below is
 * read off the live router stack.
 *
 *   node scripts/dump-routes.js
 */
import "./local-db-guard.mjs"; // MUST stay first: applies the local-DB override.
import app from "../src/app.js";

const METHODS = ["get", "post", "patch", "put", "delete", "options", "head"];

/**
 * Recover a mount path from a router layer.
 *
 * Express 5 keeps it only inside `layer.regexp`, as a pattern such as
 * `^\/api\/admin\/?(?=\/|$)`. The parts that are pattern rather than path have
 * to come off: the lookahead, and the optional trailing slash. Taking the text
 * up to the first `(?=` and unescaping leaves the `/?` behind, which is how the
 * first run of this script printed `/api/admin/?/appointments`.
 */
const mountPathOf = (layer) => {
  const src = layer.regexp?.source ?? "";
  const withoutLookahead = src.replace(/\(\?=.*$/, "");
  const withoutAnchors = withoutLookahead.replace(/^\^/, "").replace(/\\\//g, "/");
  return withoutAnchors.replace(/\/\?$/, "").replace(/\/+$/, "");
};

/** Express 5 keeps path-to-regexp metadata in `route.path`; older builds use `route.path` too. */
const pathOf = (route) => (typeof route.path === "string" ? route.path : String(route.path));

const collect = (stack, prefix, mount, out) => {
  for (const layer of stack) {
    if (layer.route) {
      const methods = METHODS.filter(
        (m) => layer.route.methods?.[m] && m !== "options" && m !== "head",
      );
      for (const m of methods) {
        const middlewares = (layer.route.stack ?? [])
          .map((s) => s.name)
          .filter((n) => n && n !== "<anonymous>");
        out.push({
          method: m.toUpperCase(),
          path: `${prefix}${pathOf(layer.route)}` || "/",
          mount,
          middlewares,
        });
      }
    } else if (layer.name === "router" && layer.handle?.stack) {
      const seg = mountPathOf(layer);
      collect(layer.handle.stack, `${prefix}/${seg}`.replace(/\/+/g, "/"), mount, out);
    }
  }
};

// Express 5 removed `app.router` and throws on it; `app._router` is the stack.
// Read it through a descriptor so the access is deliberate rather than a stray
// property read that happens to work on Express 4.
const stackOf = (a) =>
  Object.getOwnPropertyDescriptor(a, "_router")?.value?.stack ??
  Object.getOwnPropertyDescriptor(a, "router")?.value?.stack ??
  [];

const out = [];
collect(stackOf(app), "", "app", out);

// Sort by first path segment, then path, then method, so the table reads in the
// order a consumer would work through it.
const order = ["auth", "doctors", "appointments", "notifications", "ai", "admin"];
out.sort((a, b) => {
  const ka = a.path.split("/")[1] ?? "";
  const kb = b.path.split("/")[1] ?? "";
  const ia = order.indexOf(ka);
  const ib = order.indexOf(kb);
  if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  if (a.path !== b.path) return a.path.localeCompare(b.path);
  return a.method.localeCompare(b.method);
});

let current = "";
for (const r of out) {
  const seg = r.path.split("/")[1] ?? "(root)";
  if (seg !== current) {
    current = seg;
    console.log(`\n## ${seg}`);
  }
  const mw = r.middlewares.filter((m) => m !== "validate" && m !== "asyncHandler");
  console.log(`${r.method.padEnd(7)} ${r.path.padEnd(46)} ${mw.join(", ")}`);
}
console.log(`\n${out.length} routes\n`);