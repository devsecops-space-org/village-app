import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { openDb, createUser } from "../server/db.ts";
process.umask(0o077);
const db = openDb(process.env.DB_PATH ?? ".data/village.sqlite");
const username = process.argv[2] ?? "admin";
const role = process.argv[3] ?? "admin";
if (!/^[a-z0-9._-]{3,50}$/.test(username) || !["admin", "staff"].includes(role))
  throw new Error("Uso: npm run bootstrap -- usuario admin|staff");
if (db.prepare("SELECT id FROM users WHERE username=?").get(username))
  throw new Error("El usuario ya existe; no se modificó su contraseña");
const password = randomBytes(18).toString("base64url");
createUser(
  db,
  username,
  username === "admin" ? "Equipo DevSecOps" : username,
  password,
  role as "admin" | "staff",
);
const file = `.data/access-${username}.txt`;
writeFileSync(
  file,
  `Pit Control · acceso local\nUsuario: ${username}\nContraseña: ${password}\nRol: ${role}\n\nNo compartir ni subir este archivo al repositorio.\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(`Usuario creado. Credenciales en ${file}`);
db.close();
