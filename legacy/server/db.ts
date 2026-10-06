import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  randomUUID,
  randomInt,
} from "node:crypto";

export function openDb(path: string) {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','staff')));
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_attempts(username TEXT PRIMARY KEY, failures INTEGER NOT NULL, until_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS participants(id TEXT PRIMARY KEY, badge_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '', job TEXT NOT NULL DEFAULT '', consent_at TEXT NOT NULL, raffle_consent INTEGER NOT NULL CHECK(raffle_consent IN(0,1)), created_at TEXT NOT NULL, interest TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', feedback TEXT NOT NULL DEFAULT '', rooketh_contact INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS visits(participant_id TEXT NOT NULL REFERENCES participants(id), pit TEXT NOT NULL CHECK(pit IN('race','daytona','knowledge','merch','photo','refuel')), staff_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, PRIMARY KEY(participant_id,pit));
    CREATE TABLE IF NOT EXISTS redemptions(id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id), day TEXT NOT NULL, staff_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, age_verified INTEGER NOT NULL CHECK(age_verified=1), UNIQUE(participant_id,day));
    CREATE TABLE IF NOT EXISTS draws(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, prize TEXT NOT NULL, winner_id TEXT NOT NULL REFERENCES participants(id), snapshot TEXT NOT NULL, ticket INTEGER NOT NULL, total_weight INTEGER NOT NULL, staff_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id TEXT REFERENCES users(id), action TEXT NOT NULL, entity_id TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS visits_created ON visits(created_at);
    CREATE INDEX IF NOT EXISTS draws_winner ON draws(winner_id);
  `);
  return db;
}
export type Db = ReturnType<typeof openDb>;
export const sha256 = (s: string) =>
  createHash("sha256").update(s).digest("hex");
const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1:${salt}:${scryptSync(password, salt, 64, SCRYPT_OPTIONS).toString("hex")}`;
}
export function passwordMatches(password: string, stored: string) {
  const modern = stored.startsWith("scrypt-v1:");
  const [salt, hash] = (modern ? stored.slice(10) : stored).split(":");
  if (!salt || !hash) return false;
  const target = Buffer.from(hash, "hex");
  const actual = modern
    ? scryptSync(password, salt, 64, SCRYPT_OPTIONS)
    : scryptSync(password, salt, 64);
  return target.length === actual.length && timingSafeEqual(actual, target);
}
export function createUser(
  db: Db,
  username: string,
  name: string,
  password: string,
  role: "admin" | "staff",
) {
  if (password.length < 14)
    throw new Error("La contraseña debe tener al menos 14 caracteres");
  const id = randomUUID();
  db.prepare(
    "INSERT INTO users(id,username,name,password,role) VALUES(?,?,?,?,?)",
  ).run(id, username.toLowerCase(), name, passwordHash(password), role);
  return id;
}
export function transaction<T>(db: Db, task: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = task();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function weightedPick<T extends { weight: number }>(
  entries: T[],
  random = randomInt,
) {
  const total = entries.reduce((s, p) => s + p.weight, 0);
  if (
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    total >= 2 ** 48 ||
    entries.some((p) => !Number.isSafeInteger(p.weight) || p.weight < 1)
  )
    throw new Error("Pesos inválidos");
  const ticket = random(total);
  let offset = 0;
  for (const entry of entries) {
    offset += entry.weight;
    if (ticket < offset) return { entry, ticket, total };
  }
  throw new Error("Sorteo inválido");
}
export function eventDay() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date());
}
export function csvCell(value: unknown) {
  let s = String(value ?? "");
  if (/^[\s]*[=+@\-\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}
