import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import {
  openDb,
  createUser,
  weightedPick,
  csvCell,
  type Db,
} from "../server/db.ts";
import { createApp } from "../server/app.ts";
import { chanceCount, parseBadge } from "../shared/model.ts";

const origin = "http://localhost:4173",
  password = "Test-local-password-123!";
let db: Db, app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(":memory:");
  createUser(db, "admin", "Admin", password, "admin");
  createUser(db, "crew", "Equipo", password, "staff");
  app = createApp(db, { origin, test: true });
});
afterEach(() => db.close());
async function login(username = "admin") {
  const r = await request(app)
    .post("/api/login")
    .set("Origin", origin)
    .send({ username, password });
  assert.equal(r.status, 200);
  return {
    cookie: (r.headers["set-cookie"] as unknown as string[])[0].split(";")[0],
    csrf: r.body.csrf,
  };
}
type Auth = Awaited<ReturnType<typeof login>>;
function post(auth: Auth, url: string, data: object) {
  return request(app)
    .post(url)
    .set("Origin", origin)
    .set("Cookie", auth.cookie)
    .set("X-CSRF-Token", auth.csrf)
    .send(data);
}
async function add(auth: Auth, name = "Ana Pérez", raffleConsent = true) {
  const r = await post(auth, "/api/participants", {
    badge: randomUUID(),
    name,
    email: "",
    company: "",
    job: "",
    consent: true,
    raffleConsent,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

test("anonymous requests cannot access data; cookies and response headers are protected", async () => {
  assert.equal((await request(app).get("/api/participants")).status, 401);
  const r = await request(app)
    .post("/api/login")
    .set("Origin", origin)
    .send({ username: "admin", password });
  assert.match(r.headers["set-cookie"][0], /HttpOnly/);
  assert.match(r.headers["set-cookie"][0], /SameSite=Strict/);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/);
});
test("rejects origin spoofing and missing CSRF", async () => {
  const a = await login();
  assert.equal(
    (
      await request(app)
        .post("/api/logout")
        .set("Origin", "https://evil.example")
        .set("Cookie", a.cookie)
        .send({})
    ).status,
    403,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/logout")
        .set("Origin", origin)
        .set("Cookie", a.cookie)
        .send({})
    ).status,
    403,
  );
  assert.equal((await post(a, "/api/logout", {})).status, 200);
  assert.equal(
    (await request(app).get("/api/me").set("Cookie", a.cookie)).status,
    401,
  );
});
test("staff cannot export data or execute a draw even by calling the API directly", async () => {
  const a = await login("crew");
  await add(a);
  assert.equal(
    (await request(app).get("/api/export").set("Cookie", a.cookie)).status,
    403,
  );
  assert.equal(
    (
      await post(a, "/api/raffle/draw", {
        prize: "Remera",
        requestId: randomUUID(),
      })
    ).status,
    403,
  );
});
test("validates input, requires participation consent and rejects arbitrary score fields", async () => {
  const a = await login();
  const body = {
    badge: "abc",
    name: "Ana",
    consent: true,
    raffleConsent: false,
  };
  assert.equal(
    (await post(a, "/api/participants", { ...body, consent: false })).status,
    400,
  );
  assert.equal(
    (await post(a, "/api/participants", { ...body, chances: 999 })).status,
    400,
  );
  assert.equal(
    (await post(a, "/api/participants", { ...body, email: "not-an-email" }))
      .status,
    400,
  );
  assert.equal(
    (await post(a, "/api/badge", { raw: "x".repeat(2049) })).status,
    400,
  );
});
test("same badge cannot create duplicates; raw badge payload is not persisted", async () => {
  const a = await login();
  const body = {
    badge: "private-ticket-secret",
    name: "Ana",
    consent: true,
    raffleConsent: true,
  };
  const p = await post(a, "/api/participants", body);
  assert.equal(p.status, 201);
  assert.equal((await post(a, "/api/participants", body)).status, 409);
  const lookup = await post(a, "/api/badge", { raw: body.badge });
  assert.equal(lookup.body.participant.id, p.body.id);
  const stored = db.prepare("SELECT * FROM participants").get()!;
  assert.equal(String(stored.badge_hash).length, 64);
  assert.ok(!JSON.stringify(stored).includes(body.badge));
});
test("PIT visits are idempotent and points are derived by the server", async () => {
  const a = await login();
  const p = await add(a);
  const visits = await Promise.all([
    post(a, `/api/participants/${p.id}/visits`, { pit: "daytona" }),
    post(a, `/api/participants/${p.id}/visits`, { pit: "daytona" }),
  ]);
  for (const r of visits) {
    assert.equal(r.status, 200);
    assert.equal(r.body.chances, 2);
    assert.equal(r.body.visits.length, 1);
  }
  assert.equal(
    (await post(a, `/api/participants/${p.id}/visits`, { pit: "refuel" }))
      .status,
    400,
  );
});
test("refuel requires activity, age and sticker; same-day redemption is atomic", async () => {
  const a = await login();
  const p = await add(a);
  const path = `/api/participants/${p.id}/refuel`;
  assert.equal(
    (await post(a, path, { ageVerified: true, stickerVerified: true })).status,
    400,
  );
  await post(a, `/api/participants/${p.id}/visits`, { pit: "knowledge" });
  assert.equal(
    (await post(a, path, { ageVerified: false, stickerVerified: true })).status,
    400,
  );
  const results = await Promise.all([
    post(a, path, { ageVerified: true, stickerVerified: true }),
    post(a, path, { ageVerified: true, stickerVerified: true }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const p2 = await request(app)
    .get(`/api/participants/${p.id}`)
    .set("Cookie", a.cookie);
  assert.equal(p2.body.chances, 2);
  assert.equal(p2.body.redeemedToday, true);
});
test("raffle excludes opt-outs and previous winners; retries return original result", async () => {
  const a = await login();
  const p = await add(a);
  await add(a, "Opt Out", false);
  await post(a, `/api/participants/${p.id}/visits`, { pit: "photo" });
  const input = { prize: "Pack Village", requestId: randomUUID() };
  const result = await post(a, "/api/raffle/draw", input);
  assert.equal(result.status, 201);
  assert.equal(result.body.winnerId, p.id);
  assert.equal(result.body.totalWeight, 2);
  assert.equal(result.body.candidates, 1);
  const retry = await post(a, "/api/raffle/draw", input);
  assert.equal(retry.body.id, result.body.id);
  assert.equal(
    (await post(a, "/api/raffle/draw", { ...input, requestId: randomUUID() }))
      .status,
    400,
  );
  const audit = await request(app)
    .get(`/api/raffle/${result.body.id}/audit`)
    .set("Cookie", a.cookie);
  assert.equal(audit.status, 200);
  assert.deepEqual(audit.body.snapshot, [{ id: p.id, weight: 2 }]);
});
test("weighted interval boundaries give six tickets six times the probability of one", () => {
  const entries = [
    { id: "one", weight: 1 },
    { id: "six", weight: 6 },
  ];
  const selected = Array.from(
    { length: 7 },
    (_, i) => weightedPick(entries, () => i).entry.id,
  );
  assert.equal(selected.filter((x) => x === "one").length, 1);
  assert.equal(selected.filter((x) => x === "six").length, 6);
  assert.throws(() => weightedPick([]));
  assert.equal(
    chanceCount([{ pit: "race" }, { pit: "race" }, { pit: "refuel" }]),
    2,
  );
});
test("SQL injection stays text, CSV formula injection is neutralized, QR URLs never supply identity", async () => {
  const a = await login();
  await add(a, "Robert'); DROP TABLE participants;--");
  const r = await request(app)
    .get("/api/participants?q=" + encodeURIComponent("' OR 1=1 --"))
    .set("Cookie", a.cookie);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 0);
  assert.match(csvCell('=HYPERLINK("evil")'), /^"'/);
  assert.match(csvCell("   +cmd"), /^"'/);
  assert.deepEqual(parseBadge("https://evil.example/?name=Admin"), {});
  assert.deepEqual(parseBadge('{"name":"Ana","chances":900}'), { name: "Ana" });
});
test("account throttling persists in database and does not disclose account existence", async () => {
  for (let i = 0; i < 8; i++) {
    const r = await request(app)
      .post("/api/login")
      .set("Origin", origin)
      .send({ username: "admin", password: "wrong" });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "Usuario o contraseña incorrectos");
  }
  assert.equal(
    (
      await request(app)
        .post("/api/login")
        .set("Origin", origin)
        .send({ username: "admin", password })
    ).status,
    429,
  );
});
test("production uses Secure cookie and strict CSP", async () => {
  const prod = createApp(db, {
    origin: "https://pit.example",
    production: true,
    test: true,
  });
  const r = await request(prod)
    .post("/api/login")
    .set("Origin", "https://pit.example")
    .send({ username: "admin", password });
  assert.equal(r.status, 200);
  assert.match(r.headers["set-cookie"][0], /__Host-pit_session/);
  assert.match(r.headers["set-cookie"][0], /Secure/);
  assert.ok(!r.headers["content-security-policy"].includes("unsafe-inline"));
  assert.ok(r.headers["strict-transport-security"]);
});
