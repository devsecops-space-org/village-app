import { resolve } from "node:path";
import express from "express";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

process.umask(0o077);
const production = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 4173);
const origin = process.env.APP_ORIGIN ?? `http://localhost:${port}`;
if (production && !origin.startsWith("https://"))
  throw new Error("APP_ORIGIN debe usar HTTPS en producción");
const db = openDb(process.env.DB_PATH ?? ".data/village.sqlite");
const app = createApp(db, { origin, production });
if (production) {
  app.use(express.static(resolve("dist"), { index: false, maxAge: "1h" }));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const { attachDevFrontend } = await import("./frontend.ts");
  await attachDevFrontend(app);
}
const server = app.listen(port, process.env.HOST ?? "127.0.0.1", () =>
  console.log(`Pit Control: ${origin}`),
);
function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
