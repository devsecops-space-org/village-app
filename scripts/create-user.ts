import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "vite";

// Team accounts are created only from a trusted machine with the service_role
// key taken from the shell environment. There is no public signup.
process.umask(0o077);
const env = loadEnv("development", process.cwd(), "VITE_");
const url = process.env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const domain = env.VITE_LOGIN_DOMAIN || "pit-control.local";
const username = process.argv[2] ?? "admin";
const role = process.argv[3] ?? "admin";
if (!/^[a-z0-9._-]{3,50}$/.test(username) || !["admin", "staff"].includes(role))
  throw new Error("Uso: npm run create-user -- usuario admin|staff");
if (!url || !serviceKey)
  throw new Error(
    "Definí VITE_SUPABASE_URL en .env.local y exportá SUPABASE_SERVICE_ROLE_KEY en la terminal",
  );
const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const password = randomBytes(18).toString("base64url");
const created = await supabase.auth.admin.createUser({
  email: `${username}@${domain}`,
  password,
  email_confirm: true,
});
if (created.error)
  throw new Error(`No se creó la cuenta: ${created.error.message}`);
const profile = await supabase.rpc("provision_profile", {
  p_id: created.data.user.id,
  p_username: username,
  p_name: username === "admin" ? "Equipo DevSecOps" : username,
  p_role: role,
});
if (profile.error) {
  await supabase.auth.admin.deleteUser(created.data.user.id);
  throw new Error(`No se creó el perfil: ${profile.error.message}`);
}
mkdirSync(".data", { recursive: true, mode: 0o700 });
const file = `.data/access-${username}.txt`;
writeFileSync(
  file,
  `Pit Control · acceso\nUsuario: ${username}\nContraseña: ${password}\nRol: ${role}\n\nNo compartir ni subir este archivo al repositorio.\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(`Usuario creado. Credenciales en ${file}`);
