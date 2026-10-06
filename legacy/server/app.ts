import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  participantSchema,
  noteSchema,
  pitSchema,
  chanceCount,
  parseBadge,
  type Staff,
} from "../shared/model.ts";
import {
  sha256,
  passwordHash,
  passwordMatches,
  transaction,
  weightedPick,
  eventDay,
  csvCell,
  type Db,
} from "./db.ts";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type Row = Record<string, any>;
type Session = Staff & { csrf: string; token: string };
export function createApp(
  db: Db,
  options: { origin: string; production?: boolean; test?: boolean },
) {
  const app = express();
  const cookieName = options.production ? "__Host-pit_session" : "pit_session";
  const dummyPassword = passwordHash(randomBytes(24).toString("hex"));
  app.disable("x-powered-by");
  if (!options.production) {
    app.use((_req, res, next) => {
      res.locals.cspNonce = randomBytes(24).toString("base64");
      next();
    });
  }
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: options.production
            ? ["'self'"]
            : [
                "'self'",
                (_req, res) => `'nonce-${(res as Response).locals.cspNonce}'`,
              ],
          styleSrc: options.production
            ? ["'self'"]
            : ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: options.production
            ? ["'self'"]
            : ["'self'", "ws://localhost:*"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: options.production ? [] : null,
        },
      },
      strictTransportSecurity: options.production ? undefined : false,
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader(
      "Permissions-Policy",
      "camera=(self), microphone=(), geolocation=()",
    );
    next();
  });
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: options.test ? 10000 : 240,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Demasiadas solicitudes. Esperá un momento." },
    }),
  );
  app.use("/api", (req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.get("origin") !== options.origin)
        return next(new HttpError(403, "Origen no permitido"));
      if (!req.is("application/json"))
        return next(new HttpError(415, "Se requiere JSON"));
    }
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  function audit(user: string | null, action: string, entity?: string) {
    db.prepare(
      "INSERT INTO audit(staff_id,action,entity_id,created_at) VALUES(?,?,?,?)",
    ).run(user, action, entity ?? null, new Date().toISOString());
  }
  function session(req: Request): Session | undefined {
    const token = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
    return db
      .prepare(
        "SELECT u.id,u.name,u.role,s.csrf,s.token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?",
      )
      .get(sha256(token), Date.now()) as Session | undefined;
  }
  const auth = (req: Request, res: Response, next: NextFunction) => {
    const user = session(req);
    if (!user) return next(new HttpError(401, "Iniciá sesión para continuar"));
    res.locals.user = user;
    if (!["GET", "HEAD"].includes(req.method)) {
      const input = Buffer.from(req.get("x-csrf-token") ?? "");
      const expected = Buffer.from(user.csrf);
      if (input.length !== expected.length || !timingSafeEqual(input, expected))
        return next(new HttpError(403, "Sesión inválida. Volvé a ingresar."));
    }
    next();
  };
  const admin = (_req: Request, res: Response, next: NextFunction) =>
    res.locals.user.role === "admin"
      ? next()
      : next(new HttpError(403, "Esta acción requiere un administrador"));
  const idParam = (req: Request) => z.uuid().parse(req.params.id);
  const getParticipant = (id: string) => {
    const p = db.prepare("SELECT * FROM participants WHERE id=?").get(id) as
      Row | undefined;
    if (!p) throw new HttpError(404, "Visitante no encontrado");
    const visits = db
      .prepare(
        "SELECT pit,created_at AS createdAt FROM visits WHERE participant_id=? ORDER BY created_at",
      )
      .all(id) as { pit: string; createdAt: string }[];
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      company: p.company,
      job: p.job,
      createdAt: p.created_at,
      raffleConsent: !!p.raffle_consent,
      visits,
      chances: chanceCount(visits),
      interest: p.interest,
      note: p.note,
      feedback: p.feedback,
      rookethContact: !!p.rooketh_contact,
      redeemedToday: !!db
        .prepare("SELECT id FROM redemptions WHERE participant_id=? AND day=?")
        .get(id, eventDay()),
    };
  };
  function candidates() {
    return db
      .prepare(
        `SELECT p.id,p.name,1+(SELECT COUNT(*) FROM visits v WHERE v.participant_id=p.id AND v.pit!='refuel') AS weight
      FROM participants p WHERE p.raffle_consent=1 AND NOT EXISTS(SELECT 1 FROM draws d WHERE d.winner_id=p.id) ORDER BY p.id`,
      )
      .all() as { id: string; name: string; weight: number }[];
  }
  function drawView(row: Row) {
    const snapshot = JSON.parse(row.snapshot) as {
      id: string;
      weight: number;
    }[];
    const winner = db
      .prepare("SELECT name FROM participants WHERE id=?")
      .get(row.winner_id) as Row;
    return {
      id: row.id,
      prize: row.prize,
      winnerId: row.winner_id,
      winnerName: winner.name,
      createdAt: row.created_at,
      totalWeight: row.total_weight,
      candidates: snapshot.length,
      ticket: row.ticket,
      winnerWeight: snapshot.find((p) => p.id === row.winner_id)!.weight,
    };
  }
  const loginLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: options.test ? 1000 : 20,
    message: { error: "Muchos intentos. Esperá 15 minutos." },
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.post("/api/login", loginLimit, (req, res) => {
    const input = z
      .object({
        username: z.string().trim().toLowerCase().min(1).max(100),
        password: z.string().min(1).max(256),
      })
      .strict()
      .parse(req.body);
    const attemptKey = sha256(input.username);
    const lock = db
      .prepare("SELECT * FROM login_attempts WHERE username=?")
      .get(attemptKey) as Row | undefined;
    if (lock && lock.failures >= 8 && lock.until_ms > Date.now())
      throw new HttpError(429, "Muchos intentos. Esperá 15 minutos.");
    const user = db
      .prepare("SELECT * FROM users WHERE username=?")
      .get(input.username) as Row | undefined;
    const valid = passwordMatches(
      input.password,
      user?.password ?? dummyPassword,
    );
    if (!user || !valid) {
      const failures =
        lock && lock.until_ms > Date.now() ? lock.failures + 1 : 1;
      db.prepare(
        "INSERT INTO login_attempts(username,failures,until_ms) VALUES(?,?,?) ON CONFLICT(username) DO UPDATE SET failures=excluded.failures,until_ms=excluded.until_ms",
      ).run(attemptKey, failures, Date.now() + 900_000);
      audit(null, "login.failed");
      throw new HttpError(401, "Usuario o contraseña incorrectos");
    }
    db.prepare("DELETE FROM login_attempts WHERE username=?").run(attemptKey);
    if (!user.password.startsWith("scrypt-v1:"))
      db.prepare("UPDATE users SET password=? WHERE id=?").run(
        passwordHash(input.password),
        user.id,
      );
    db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    const old = session(req);
    if (old) db.prepare("DELETE FROM sessions WHERE token=?").run(old.token);
    const token = randomBytes(32).toString("hex");
    const csrf = randomBytes(32).toString("hex");
    db.prepare(
      "INSERT INTO sessions(token,user_id,csrf,expires) VALUES(?,?,?,?)",
    ).run(sha256(token), user.id, csrf, Date.now() + 12 * 60 * 60_000);
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: !!options.production,
      sameSite: "strict",
      path: "/",
      maxAge: 12 * 60 * 60_000,
    });
    audit(user.id, "login.success");
    res.json({ user: { id: user.id, name: user.name, role: user.role }, csrf });
  });
  app.get("/api/me", auth, (_req, res) => {
    const { id, name, role, csrf } = res.locals.user;
    res.json({ user: { id, name, role }, csrf });
  });
  app.post("/api/logout", auth, (_req, res) => {
    db.prepare("DELETE FROM sessions WHERE token=?").run(res.locals.user.token);
    res.clearCookie(cookieName, {
      httpOnly: true,
      secure: !!options.production,
      sameSite: "strict",
      path: "/",
    });
    res.json({ ok: true });
  });
  app.use("/api", auth);
  app.post("/api/badge", (req, res) => {
    const { raw } = z
      .object({ raw: z.string().trim().min(1).max(2048) })
      .strict()
      .parse(req.body);
    const found = db
      .prepare("SELECT id FROM participants WHERE badge_hash=?")
      .get(sha256(raw)) as Row | undefined;
    res.json(
      found
        ? { participant: getParticipant(found.id) }
        : { prefill: parseBadge(raw) },
    );
  });
  app.get("/api/participants", (req, res) => {
    const input = z
      .object({
        q: z.string().max(100).default(""),
        page: z.coerce.number().int().min(1).max(100000).default(1),
      })
      .parse(req.query);
    const search = `%${input.q.replace(/[\\%_]/g, "\\$&")}%`;
    const where = `WHERE name LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'`;
    const total = (
      db
        .prepare(`SELECT COUNT(*) n FROM participants ${where}`)
        .get(search, search, search) as Row
    ).n;
    const ids = db
      .prepare(
        `SELECT id FROM participants ${where} ORDER BY created_at DESC LIMIT 40 OFFSET ?`,
      )
      .all(search, search, search, (input.page - 1) * 40) as Row[];
    res.json({ participants: ids.map((p) => getParticipant(p.id)), total });
  });
  app.get("/api/participants/:id", (req, res) =>
    res.json(getParticipant(idParam(req))),
  );
  app.post("/api/participants", (req, res) => {
    const input = participantSchema.parse(req.body);
    const participant = transaction(db, () => {
      if (
        db
          .prepare("SELECT id FROM participants WHERE badge_hash=?")
          .get(sha256(input.badge))
      )
        throw new HttpError(
          409,
          "Este badge ya está registrado. Buscá al visitante o volvé a escanear.",
        );
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO participants(id,badge_hash,name,email,company,job,consent_at,raffle_consent,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        sha256(input.badge),
        input.name,
        input.email,
        input.company,
        input.job,
        now,
        Number(input.raffleConsent),
        now,
      );
      audit(res.locals.user.id, "participant.created", id);
      return getParticipant(id);
    });
    res.status(201).json(participant);
  });
  app.patch("/api/participants/:id/notes", (req, res) => {
    const id = idParam(req);
    const input = noteSchema.parse(req.body);
    getParticipant(id);
    transaction(db, () => {
      db.prepare(
        "UPDATE participants SET interest=?,note=?,feedback=?,rooketh_contact=? WHERE id=?",
      ).run(
        input.interest,
        input.note,
        input.feedback,
        Number(input.rookethContact),
        id,
      );
      audit(res.locals.user.id, "participant.notes", id);
    });
    res.json(getParticipant(id));
  });
  app.post("/api/participants/:id/visits", (req, res) => {
    const id = idParam(req);
    const { pit } = z.object({ pit: pitSchema }).strict().parse(req.body);
    if (pit === "refuel")
      throw new HttpError(400, "Refuel se registra al confirmar el canje");
    getParticipant(id);
    transaction(db, () => {
      const inserted = db
        .prepare(
          "INSERT OR IGNORE INTO visits(participant_id,pit,staff_id,created_at) VALUES(?,?,?,?)",
        )
        .run(id, pit, res.locals.user.id, new Date().toISOString());
      if (inserted.changes) audit(res.locals.user.id, "visit.created", id);
    });
    res.json(getParticipant(id));
  });
  app.post("/api/participants/:id/refuel", (req, res) => {
    z.object({ ageVerified: z.literal(true), stickerVerified: z.literal(true) })
      .strict()
      .parse(req.body);
    const id = idParam(req);
    getParticipant(id);
    transaction(db, () => {
      if (
        db
          .prepare("SELECT 1 FROM redemptions WHERE participant_id=? AND day=?")
          .get(id, eventDay())
      )
        throw new HttpError(409, "El canje de hoy ya fue registrado");
      if (
        !db
          .prepare(
            "SELECT 1 FROM visits WHERE participant_id=? AND pit!='refuel'",
          )
          .get(id)
      )
        throw new HttpError(
          400,
          "Primero registrá una participación en otro PIT",
        );
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO redemptions(id,participant_id,day,staff_id,created_at,age_verified) VALUES(?,?,?,?,?,1)",
      ).run(randomUUID(), id, eventDay(), res.locals.user.id, now);
      db.prepare(
        "INSERT OR IGNORE INTO visits(participant_id,pit,staff_id,created_at) VALUES(?,?,?,?)",
      ).run(id, "refuel", res.locals.user.id, now);
      audit(res.locals.user.id, "refuel.redeemed", id);
    });
    res.json(getParticipant(id));
  });
  app.get("/api/summary", (_req, res) => {
    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as Row).n;
    res.json({
      participants: count("participants"),
      visits: count("visits"),
      redemptions: count("redemptions"),
      eligible: candidates().length,
      pits: db
        .prepare("SELECT pit,COUNT(*) count FROM visits GROUP BY pit")
        .all(),
      activity: db
        .prepare(
          "SELECT a.id,a.action,a.created_at AS createdAt,u.name AS staff FROM audit a LEFT JOIN users u ON u.id=a.staff_id ORDER BY a.id DESC LIMIT 12",
        )
        .all(),
    });
  });
  app.get("/api/raffle", (_req, res) => {
    const pool = candidates();
    res.json({
      candidates: pool.sort(
        (a, b) => b.weight - a.weight || a.name.localeCompare(b.name),
      ),
      totalWeight: pool.reduce((s, p) => s + p.weight, 0),
      draws: (
        db
          .prepare("SELECT * FROM draws ORDER BY created_at DESC")
          .all() as Row[]
      ).map(drawView),
    });
  });
  app.post("/api/raffle/draw", admin, (req, res) => {
    const { prize, requestId } = z
      .object({
        prize: z
          .string()
          .trim()
          .min(2)
          .max(100)
          .refine((v) => !/[\u0000-\u001f]/.test(v)),
        requestId: z.uuid(),
      })
      .strict()
      .parse(req.body);
    const result = transaction(db, () => {
      const prior = db
        .prepare("SELECT * FROM draws WHERE request_id=?")
        .get(requestId) as Row | undefined;
      if (prior) return drawView(prior);
      const pool = candidates();
      if (!pool.length)
        throw new HttpError(400, "No hay participantes elegibles");
      const picked = weightedPick(pool);
      const id = randomUUID();
      db.prepare(
        "INSERT INTO draws(id,request_id,prize,winner_id,snapshot,ticket,total_weight,staff_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        requestId,
        prize,
        picked.entry.id,
        JSON.stringify(pool.map((p) => ({ id: p.id, weight: p.weight }))),
        picked.ticket,
        picked.total,
        res.locals.user.id,
        new Date().toISOString(),
      );
      audit(res.locals.user.id, "raffle.drawn", id);
      return drawView(
        db.prepare("SELECT * FROM draws WHERE id=?").get(id) as Row,
      );
    });
    res.status(201).json(result);
  });
  app.get("/api/raffle/:id/audit", admin, (req, res) => {
    const row = db
      .prepare("SELECT * FROM draws WHERE id=?")
      .get(idParam(req)) as Row | undefined;
    if (!row) throw new HttpError(404, "Sorteo no encontrado");
    res.json({
      ...drawView(row),
      snapshot: JSON.parse(row.snapshot),
      rule: "1 + PITs distintos sin Refuel; solo opt-in; excluye ganadores anteriores",
      algorithm:
        "node:crypto.randomInt(totalWeight), intervalos ponderados ordenados por UUID; ticket base 0",
    });
  });
  app.get("/api/export", admin, (_req, res) => {
    const ids = db
      .prepare("SELECT id FROM participants ORDER BY created_at")
      .all() as Row[];
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
      ...ids.map(({ id }) => {
        const p = getParticipant(id);
        return [
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
        ];
      }),
    ];
    audit(res.locals.user.id, "participants.exported");
    res
      .attachment("village-participantes.csv")
      .type("text/csv")
      .send("\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"));
  });
  app.use("/api", (_req, _res, next) =>
    next(new HttpError(404, "Ruta no encontrada")),
  );
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError)
      return res
        .status(400)
        .json({ error: error.issues[0]?.message ?? "Datos inválidos" });
    if (error instanceof HttpError)
      return res.status(error.status).json({ error: error.message });
    if (error.type === "entity.too.large")
      return res.status(413).json({ error: "Solicitud demasiado grande" });
    if (error instanceof SyntaxError)
      return res.status(400).json({ error: "JSON inválido" });
    const reference = randomUUID();
    console.error(
      JSON.stringify({ event: "request.failed", reference, type: error?.name }),
    );
    res.status(500).json({
      error: `No se pudo completar la operación. Referencia: ${reference}`,
    });
  });
  return app;
}
