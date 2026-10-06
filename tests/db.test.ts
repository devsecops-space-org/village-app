import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

// Runs the real migration on an in-memory Postgres. Only the pieces Supabase
// provides (API roles, auth.users, auth.uid) are stubbed here.
const migration = readFileSync("supabase/migrations/0001_init.sql", "utf8");
const stubs = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema extensions; create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
  grant usage on schema auth, extensions to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`;

type Role = "anon" | "authenticated" | "service_role";
let db: PGlite;
const admin = randomUUID(),
  staff = randomUUID(),
  stranger = randomUUID();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

async function as<T>(
  role: Role,
  sub: string | null,
  sql: string,
  params: unknown[] = [],
) {
  await db.query("select set_config('request.jwt.claims', $1, false)", [
    sub ? JSON.stringify({ sub }) : "",
  ]);
  await db.exec(`set role ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}
async function rpc<T = any>(
  sub: string | null,
  fn: string,
  ...args: unknown[]
): Promise<T> {
  const marks = args.map((_, i) => `$${i + 1}`).join(",");
  const rows = await as<{ r: T }>(
    sub ? "authenticated" : "anon",
    sub,
    `select public.${fn}(${marks}) as r`,
    args,
  );
  return rows[0].r;
}
const fails = (code: string, task: () => Promise<unknown>) =>
  assert.rejects(task, (e: any) => {
    assert.equal(e.code, code, e.message);
    return true;
  });
const register = (badge: string, raffle = true, by = staff) =>
  rpc(
    by,
    "register_participant",
    hash(badge),
    `Persona ${badge}`,
    "",
    "",
    "",
    true,
    raffle,
  );

beforeEach(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(stubs);
  await db.exec(migration);
  for (const [id, username, role] of [
    [admin, "admin", "admin"],
    [staff, "crew", "staff"],
  ]) {
    await db.query("insert into auth.users(id) values($1)", [id]);
    await as(
      "service_role",
      null,
      "select public.provision_profile($1,$2,$3,$4)",
      [id, username, username, role],
    );
  }
  await db.query("insert into auth.users(id) values($1)", [stranger]);
});
afterEach(() => db.close());

test("anon no lee tablas ni ejecuta funciones", async () => {
  await register("a");
  for (const table of [
    "profiles",
    "participants",
    "visits",
    "redemptions",
    "draws",
    "audit",
  ])
    await fails("42501", () =>
      as("anon", null, `select * from private.${table}`),
    );
  for (const call of [
    "public.me()",
    "public.get_summary()",
    "public.get_raffle()",
    "public.export_participants()",
    "public.search_participants('', 1)",
    `public.lookup_badge('${hash("a")}')`,
    `public.draw_raffle('Premio', '${randomUUID()}')`,
    "private.participant_json(gen_random_uuid())",
  ])
    await fails("42501", () => as("anon", null, `select ${call}`));
});

test("sesión sin perfil no accede a nada", async () => {
  await fails("PT401", () => rpc(stranger, "me"));
  await fails("PT401", () => rpc(stranger, "get_summary"));
  await fails("PT401", () => register("x", true, stranger));
  await fails("PT401", () => rpc(stranger, "export_participants"));
});

test("usuario autenticado no toca tablas ni se asigna un rol", async () => {
  const p = await register("a");
  for (const sql of [
    "select * from private.participants",
    "select * from private.profiles",
    `insert into private.visits(participant_id,pit,staff_id) values('${p.id}','race','${staff}')`,
    `update private.profiles set role='admin' where id='${staff}'`,
    "delete from private.audit",
    "select private.random_below(10)",
    "select private.candidates()",
  ])
    await fails("42501", () => as("authenticated", staff, sql));
  await fails("42501", () =>
    as(
      "authenticated",
      stranger,
      "select public.provision_profile($1,'intruso','x','admin')",
      [stranger],
    ),
  );
  assert.equal((await rpc(staff, "me")).role, "staff");
});

test("registro valida datos en SQL y rechaza badges repetidos", async () => {
  const p = await register("a");
  assert.equal(p.chances, 1);
  assert.deepEqual(p.visits, []);
  await fails("PT409", () => register("a"));
  const bad = (...a: unknown[]) =>
    fails("PT400", () => rpc(staff, "register_participant", ...a));
  await bad("no-es-hash", "Nombre", "", "", "", true, true);
  await bad(hash("b"), "N", "", "", "", true, true);
  await bad(hash("b"), "x".repeat(101), "", "", "", true, true);
  await bad(hash("b"), "Nombre\u0007", "", "", "", true, true);
  await bad(hash("b"), "Nombre", "no-es-correo", "", "", true, true);
  await bad(hash("b"), "Nombre", "", "c".repeat(121), "", true, true);
  await bad(hash("b"), "Nombre", "", "", "", false, true);
  const found = await rpc(staff, "lookup_badge", hash("a"));
  assert.equal(found.participant.id, p.id);
  assert.deepEqual(await rpc(staff, "lookup_badge", hash("otro")), {});
  await fails("PT400", () =>
    rpc(staff, "lookup_badge", "contenido crudo del QR"),
  );
});

test("el puntaje sale de visitas únicas y no supera 6", async () => {
  const p = await register("a");
  let last: any;
  for (const pit of [
    "race",
    "race",
    "daytona",
    "knowledge",
    "merch",
    "photo",
    "photo",
  ])
    last = await rpc(staff, "add_visit", p.id, pit);
  assert.equal(last.chances, 6);
  assert.equal(last.visits.length, 5);
  await fails("PT400", () => rpc(staff, "add_visit", p.id, "refuel"));
  await fails("PT400", () => rpc(staff, "add_visit", p.id, "inventado"));
  await fails("PT404", () => rpc(staff, "add_visit", randomUUID(), "race"));
  const audit = await db.query(
    "select count(*)::int n from private.audit where action='visit.created'",
  );
  assert.equal((audit.rows[0] as any).n, 5);
});

test("refuel exige otro PIT, verificaciones y un canje por día", async () => {
  const p = await register("a");
  await fails("PT400", () => rpc(staff, "redeem_refuel", p.id, true, true));
  await rpc(staff, "add_visit", p.id, "race");
  await fails("PT400", () => rpc(staff, "redeem_refuel", p.id, false, true));
  await fails("PT400", () => rpc(staff, "redeem_refuel", p.id, true, false));
  const done = await rpc(staff, "redeem_refuel", p.id, true, true);
  assert.equal(done.redeemedToday, true);
  assert.equal(done.chances, 2);
  await fails("PT409", () => rpc(staff, "redeem_refuel", p.id, true, true));
  const days = await db.query<{ ok: boolean }>(
    "select day = (now() at time zone 'America/Argentina/Buenos_Aires')::date as ok from private.redemptions",
  );
  assert.deepEqual(days.rows, [{ ok: true }]);
});

test("notas y búsqueda", async () => {
  const p = await register("a");
  await rpc(
    staff,
    "register_participant",
    hash("b"),
    "100% real",
    "",
    "Acme_co",
    "",
    true,
    false,
  );
  const saved = await rpc(
    staff,
    "update_notes",
    p.id,
    "AppSec",
    " nota ",
    "",
    true,
  );
  assert.equal(saved.note, "nota");
  assert.equal(saved.rookethContact, true);
  await fails("PT400", () =>
    rpc(staff, "update_notes", p.id, "Otro", "", "", false),
  );
  await fails("PT400", () =>
    rpc(staff, "update_notes", p.id, "", "n".repeat(501), "", false),
  );
  assert.equal((await rpc(staff, "search_participants", "", 1)).total, 2);
  assert.equal((await rpc(staff, "search_participants", "%", 1)).total, 1);
  assert.equal((await rpc(staff, "search_participants", "_", 1)).total, 1);
  assert.equal(
    (await rpc(staff, "search_participants", "PERSONA", 1)).total,
    1,
  );
  await fails("PT400", () => rpc(staff, "search_participants", "", 0));
});

test("sorteo: solo admin, opt-in, idempotente y sin repetir ganadores", async () => {
  const requestId = randomUUID();
  await fails("PT400", () => rpc(admin, "draw_raffle", "Premio", requestId));
  const a = await register("a");
  const b = await register("b");
  await register("c", false);
  await rpc(staff, "add_visit", a.id, "race");
  await fails("PT403", () => rpc(staff, "draw_raffle", "Premio", requestId));
  await fails("PT400", () => rpc(admin, "draw_raffle", "P", requestId));
  const pool = await rpc(staff, "get_raffle");
  assert.equal(pool.totalWeight, 3);
  assert.deepEqual(
    pool.candidates.map((c: any) => c.id),
    [a.id, b.id],
  );
  const first = await rpc(admin, "draw_raffle", "Premio", requestId);
  assert.ok([a.id, b.id].includes(first.winnerId));
  assert.equal(first.totalWeight, 3);
  assert.equal(first.candidates, 2);
  assert.ok(first.ticket >= 0 && first.ticket < 3);
  assert.equal(
    first.winnerId,
    first.ticket < (a.id < b.id ? 2 : 1) === a.id < b.id ? a.id : b.id,
  );
  assert.deepEqual(
    await rpc(admin, "draw_raffle", "Otro premio", requestId),
    first,
  );
  const second = await rpc(admin, "draw_raffle", "Segundo", randomUUID());
  assert.notEqual(second.winnerId, first.winnerId);
  await fails("PT400", () =>
    rpc(admin, "draw_raffle", "Tercero", randomUUID()),
  );
  assert.equal((await rpc(staff, "get_raffle")).draws.length, 2);
  await fails("PT403", () => rpc(staff, "raffle_audit", first.id));
  const audit = await rpc(admin, "raffle_audit", first.id);
  assert.equal(audit.snapshot.length, 2);
  await fails("PT404", () => rpc(admin, "raffle_audit", randomUUID()));
});

test("exportación solo admin y queda auditada", async () => {
  await register("a");
  await fails("PT403", () => rpc(staff, "export_participants"));
  const rows = await rpc(admin, "export_participants");
  assert.equal(rows.length, 1);
  const summary = await rpc(staff, "get_summary");
  assert.equal(summary.participants, 1);
  assert.equal(summary.eligible, 1);
  assert.deepEqual(
    summary.activity.map((a: any) => a.action),
    ["participants.exported", "participant.created"],
  );
});

test("entero aleatorio uniforme dentro del rango", async () => {
  const r = await db.query<{ lo: string; hi: string; kinds: number }>(
    "select min(v) lo, max(v) hi, count(distinct v)::int kinds from (select private.random_below(5) v from generate_series(1,400)) s",
  );
  assert.deepEqual(r.rows[0], { lo: 0, hi: 4, kinds: 5 });
  await assert.rejects(() => db.query("select private.random_below(0)"));
});
