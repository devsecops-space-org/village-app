import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Opt-in smoke check against the running local instance; creates no participants.
const origin = "http://localhost:4173";
const access = readFileSync(".data/access-admin.txt", "utf8");
const username = access.match(/^Usuario: (.+)$/m)![1];
const password = access.match(/^Contraseña: (.+)$/m)![1];
const response = await fetch(origin + "/api/login", {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({ username, password }),
});
assert.equal(response.status, 200);
const cookie = response.headers.getSetCookie()[0].split(";")[0];
const { csrf } = await response.json();
const summary = await fetch(origin + "/api/summary", {
  headers: { Cookie: cookie },
});
assert.equal(summary.status, 200);
const stats = await summary.json();
assert.equal(typeof stats.participants, "number");
for (const path of ["/.data/access-admin.txt", "/.data/village.sqlite"]) {
  const result = await fetch(origin + path);
  assert.ok(
    [403, 404].includes(result.status),
    "Private file must not be served: " + path,
  );
}
const logout = await fetch(origin + "/api/logout", {
  method: "POST",
  headers: {
    Origin: origin,
    Cookie: cookie,
    "Content-Type": "application/json",
    "X-CSRF-Token": csrf,
  },
  body: "{}",
});
assert.equal(logout.status, 200);
console.log(
  "PASS: local login, API, private-file isolation and logout. No event participants created.",
);
