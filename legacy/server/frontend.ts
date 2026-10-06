import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Express } from "express";
import { createServer } from "vite";

export async function attachDevFrontend(app: Express, hmrPort = 24678) {
  const placeholder = "__PIT_CSP_NONCE__";
  const vite = await createServer({
    server: { middlewareMode: true, hmr: { port: hmrPort, host: "localhost" } },
    appType: "custom",
    html: { cspNonce: placeholder },
  });
  app.use(vite.middlewares);
  app.get("/{*path}", async (req, res, next) => {
    try {
      const template = await readFile(resolve("index.html"), "utf8");
      const html = await vite.transformIndexHtml(req.originalUrl, template);
      // Match Vite's inline bootstrap to this response's CSP, never a shared nonce.
      res
        .type("html")
        .set("Cache-Control", "no-store")
        .send(html.replaceAll(placeholder, res.locals.cspNonce));
    } catch (error) {
      next(error);
    }
  });
  return vite;
}
