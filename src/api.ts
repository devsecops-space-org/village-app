import { z } from "zod";
import {
  participantSchema,
  noteSchema,
  pitSchema,
  parseBadge,
  type Participant,
  type Staff,
} from "../shared/model";
import { csvCell } from "../shared/csv";
import { supabase, configured, loginEmail } from "./supabase";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
const SESSION_HOURS = 12;
const STARTED_KEY = "pit_session_started";

supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT")
    window.dispatchEvent(new Event("session-expired"));
});

async function sha256(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error, status } = await supabase
    .rpc(fn, args)
    .abortSignal(AbortSignal.timeout(15000));
  if (!error) return data as T;
  // Functions raise SQLSTATE PTxxx with a message written for the team.
  if (/^PT\d{3}$/.test(error.code ?? ""))
    throw new ApiError(error.message, Number(error.code.slice(2)));
  if (status === 401) throw new ApiError("Iniciá sesión para continuar", 401);
  if (status === 403 || error.code === "42501")
    throw new ApiError("No tenés permiso para esta acción", 403);
  if (status >= 400)
    throw new ApiError("No se pudo completar la operación", status);
  throw new Error("network");
}
async function login(body: unknown) {
  const input = z
    .object({
      username: z.string().trim().toLowerCase().min(1).max(100),
      password: z.string().min(1).max(256),
    })
    .parse(body);
  const { error } = await supabase.auth.signInWithPassword({
    email: loginEmail(input.username),
    password: input.password,
  });
  if (error) {
    if (error.status === 429)
      throw new ApiError("Muchos intentos. Esperá unos minutos.", 429);
    if (error.status && error.status >= 400 && error.status < 500)
      throw new ApiError("Usuario o contraseña incorrectos", 401);
    throw new Error("network");
  }
  try {
    const user = await rpc<Staff>("me");
    await rpc("touch_login");
    localStorage.setItem(STARTED_KEY, String(Date.now()));
    return { user };
  } catch (e) {
    await supabase.auth.signOut();
    if (e instanceof ApiError && e.status === 401)
      throw new ApiError("Esta cuenta no tiene acceso a Pit Control", 403);
    throw e;
  }
}
async function me() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new ApiError("Iniciá sesión para continuar", 401);
  const started = Number(localStorage.getItem(STARTED_KEY));
  if (!started || Date.now() - started > SESSION_HOURS * 3_600_000) {
    await supabase.auth.signOut();
    throw new ApiError("La sesión venció. Volvé a ingresar.", 401);
  }
  return { user: await rpc<Staff>("me") };
}
async function logout() {
  localStorage.removeItem(STARTED_KEY);
  const { error } = await supabase.auth.signOut();
  // The local session is cleared even when the server cannot be reached.
  if (error && !error.status) throw new Error("network");
  return { ok: true };
}
async function route(
  path: string,
  method: string,
  body: unknown,
): Promise<unknown> {
  if (!configured)
    throw new ApiError("Falta configurar la conexión con Supabase", 500);
  const url = new URL(path, "http://local");
  const [root, id, action] = url.pathname.split("/").filter(Boolean);
  const key = `${method} /${root}${id ? "/:id" : ""}${action ? `/${action}` : ""}`;
  switch (`${method} ${url.pathname}`) {
    case "POST /login":
      return login(body);
    case "GET /me":
      return me();
    case "POST /logout":
      return logout();
    case "POST /badge": {
      const { raw } = z
        .object({ raw: z.string().trim().min(1).max(2048) })
        .strict()
        .parse(body);
      // The QR content never leaves the device: only its hash is sent.
      const found = await rpc<{ participant?: Participant }>("lookup_badge", {
        p_hash: await sha256(raw),
      });
      return found.participant ? found : { prefill: parseBadge(raw) };
    }
    case "GET /participants":
      return rpc("search_participants", {
        p_q: url.searchParams.get("q") ?? "",
        p_page: Number(url.searchParams.get("page") ?? 1),
      });
    case "POST /participants": {
      const input = participantSchema.parse(body);
      return rpc("register_participant", {
        p_hash: await sha256(input.badge),
        p_name: input.name,
        p_email: input.email,
        p_company: input.company,
        p_job: input.job,
        p_consent: input.consent,
        p_raffle_consent: input.raffleConsent,
      });
    }
    case "GET /summary":
      return rpc("get_summary");
    case "GET /raffle":
      return rpc("get_raffle");
    case "POST /raffle/draw": {
      const input = z
        .object({
          prize: z.string().trim().min(2).max(100),
          requestId: z.uuid(),
        })
        .strict()
        .parse(body);
      return rpc("draw_raffle", {
        p_prize: input.prize,
        p_request_id: input.requestId,
      });
    }
    case "GET /export":
      return rpc("export_participants");
  }
  const p_id = z.uuid().parse(id);
  switch (key) {
    case "GET /participants/:id":
      return rpc("get_participant", { p_id });
    case "PATCH /participants/:id/notes": {
      const input = noteSchema.parse(body);
      return rpc("update_notes", {
        p_id,
        p_interest: input.interest,
        p_note: input.note,
        p_feedback: input.feedback,
        p_rooketh_contact: input.rookethContact,
      });
    }
    case "POST /participants/:id/visits": {
      const { pit } = z.object({ pit: pitSchema }).strict().parse(body);
      return rpc("add_visit", { p_id, p_pit: pit });
    }
    case "POST /participants/:id/refuel": {
      const input = z
        .object({ ageVerified: z.boolean(), stickerVerified: z.boolean() })
        .strict()
        .parse(body);
      return rpc("redeem_refuel", {
        p_id,
        p_age_verified: input.ageVerified,
        p_sticker_verified: input.stickerVerified,
      });
    }
    case "GET /raffle/:id/audit":
      return rpc("raffle_audit", { p_id });
  }
  throw new ApiError("Ruta no encontrada", 404);
}
// Keeps the path-based interface the screens were written against; every path
// maps to Supabase Auth or to one RPC.
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  try {
    return (await route(path, method, body)) as T;
  } catch (e) {
    if (e instanceof z.ZodError)
      throw new ApiError(e.issues[0]?.message ?? "Datos inválidos", 400);
    if (e instanceof ApiError && e.status === 401 && path !== "/login")
      window.dispatchEvent(new Event("session-expired"));
    throw e;
  }
}
export async function downloadExport() {
  const people = await api<Participant[]>("/export");
  const rows = [
    [
      "ID",
      "Nombre",
      "Correo",
      "Empresa",
      "Cargo",
      "PITs",
      "Chances",
      "Aceptó sorteo",
      "Interés",
      "Feedback",
      "Contacto Rooketh autorizado",
      "Registro",
    ],
    ...people.map((p) => [
      p.id,
      p.name,
      p.email,
      p.company,
      p.job,
      p.visits.map((v) => v.pit).join(" / "),
      p.chances,
      p.raffleConsent ? "Sí" : "No",
      p.interest,
      p.feedback,
      p.rookethContact ? "Sí" : "No",
      p.createdAt,
    ]),
  ];
  const csv = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  link.download = "village-participantes.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}
export const message = (e: unknown) =>
  e instanceof ApiError
    ? e.message
    : "No pudimos conectar. Revisá la conexión y volvé a intentar.";
