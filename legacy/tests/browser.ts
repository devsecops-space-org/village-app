import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import QRCode from "qrcode";
import { createApp } from "../server/app.ts";
import { openDb, createUser } from "../server/db.ts";

// Browser fixtures live in memory, never in the event database.
const port = 4187,
  origin = `http://localhost:${port}`,
  password = "Browser-test-password-2026";
const db = openDb(":memory:");
createUser(db, "tester", "Equipo de prueba", password, "admin");
const app = createApp(db, { origin, test: true });
const vite =
  process.env.TEST_VITE === "1"
    ? await (
        await import("../server/frontend.ts")
      ).attachDevFrontend(app, 24679)
    : undefined;
if (!vite) {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
}
const server = app.listen(port, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "warning") console.log(m.text());
  if (m.type() === "error" && !m.text().includes("401")) errors.push(m.text());
});
mkdirSync("test-results", { recursive: true });
try {
  await page.goto(origin);
  if (vite) {
    const first = await context.request.get(origin);
    const second = await context.request.get(origin);
    const nonce = first
      .headers()
      ["content-security-policy"].match(/'nonce-([^']+)'/)?.[1];
    assert.ok(nonce);
    assert.ok((await first.text()).includes(`nonce="${nonce}"`));
    assert.notEqual(
      first.headers()["content-security-policy"],
      second.headers()["content-security-policy"],
    );
    assert.ok(
      !first
        .headers()
        ["content-security-policy"].split("script-src ")[1]
        .split(";")[0]
        .includes("unsafe-inline"),
    );
  }
  await page.getByLabel("Usuario", { exact: true }).fill("tester");
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Ingresar a Pit Control" }).click();
  await page.getByRole("heading", { name: "Cada visita cuenta." }).waitFor();
  await page.screenshot({
    path: "test-results/desktop-scan.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Registro manual" }).click();
  await page.getByLabel("Nombre y apellido").fill("Valentina Prueba");
  await page.getByLabel("Empresa").fill("Comunidad QA");
  await page.getByLabel("Cargo").fill("Engineering lead");
  await page.getByLabel("Autoriza a DevSecOps Space").check();
  await page.getByLabel("Quiere participar en el sorteo.").check();
  await page.getByRole("button", { name: "Registrar visitante" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Valentina Prueba" }).waitFor();
  await dialog.getByRole("button", { name: /Race Control/ }).click();
  await dialog.getByRole("button", { name: "Confirmar", exact: true }).click();
  await dialog.getByText("Guardado en el pasaporte").waitFor();
  await dialog.getByRole("button", { name: /Daytona PIT/ }).click();
  await dialog.getByRole("button", { name: "Confirmar", exact: true }).click();
  await dialog.getByText("2 / 5 PITs").waitFor();
  await dialog.getByRole("button", { name: /Refuel PIT/ }).click();
  await dialog.getByLabel("Verifiqué que es mayor de 18 años.").check();
  await dialog.getByLabel("Presentó el sticker de participación.").check();
  await dialog.getByRole("button", { name: "Confirmar", exact: true }).click();
  await dialog.getByText("Canjeado hoy").waitFor();
  await dialog.getByRole("button", { name: "Conversación y feedback" }).click();
  await dialog.getByLabel("Interés").selectOption("AppSec");
  await dialog
    .getByLabel("Nota del equipo")
    .fill("Solicitó recursos de seguridad de pipelines.");
  await dialog.getByRole("button", { name: "Guardar conversación" }).click();
  await page.screenshot({
    path: "test-results/desktop-passport.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Próximo visitante" }).click();
  await page
    .getByRole("navigation", { name: "Principal", exact: true })
    .getByRole("button", { name: "Visitantes" })
    .click();
  await page
    .getByRole("button", { name: /Valentina Prueba/ })
    .first()
    .waitFor();
  await page.screenshot({
    path: "test-results/desktop-people.png",
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "Principal", exact: true })
    .getByRole("button", { name: "Sorteo", exact: true })
    .click();
  await page.getByLabel("Premio", { exact: true }).fill("Pack Grand Prix QA");
  await page.getByRole("button", { name: "Realizar sorteo" }).click();
  await page.getByRole("button", { name: "Confirmar sorteo" }).click();
  await page.getByRole("heading", { name: "Valentina Prueba" }).waitFor();
  await page.screenshot({
    path: "test-results/desktop-raffle.png",
    fullPage: true,
  });
  const audit = await context.request.get(origin + "/api/raffle");
  const pool = await audit.json();
  assert.equal(pool.draws[0].winnerWeight, 3);
  assert.equal(pool.candidates.length, 0);
  // Exercise the real decoder against a generated test badge via a camera stream.
  const qr = await QRCode.toDataURL(
    JSON.stringify({ name: "QR Camera Test", email: "camera@example.test" }),
    { width: 480, margin: 6 },
  );
  await page.addInitScript({
    content: `
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async function () {
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 640;
      const ctx = canvas.getContext('2d');
      const image = new Image(); image.src = ${JSON.stringify(qr)};
      await image.decode();
      const paint = function () { ctx.fillStyle='white'; ctx.fillRect(0,0,640,640); ctx.drawImage(image,80,80,480,480); };
      paint(); const timer = setInterval(paint,100);
      const stream = canvas.captureStream(10);
      stream.getTracks()[0].addEventListener('ended', function () { clearInterval(timer); });
      return stream;
    }});
  `,
  });
  await page.reload();
  await page.getByRole("button", { name: "Activar cámara" }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal(
    await page.getByLabel("Nombre y apellido").inputValue(),
    "QR Camera Test",
  );
  assert.equal(
    await page.getByLabel("Correo").inputValue(),
    "camera@example.test",
  );
  await page.getByRole("button", { name: "Cerrar", exact: true }).click();
  // Responsive check for every main view, including populated states.
  for (const width of [390, 360, 768]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ["Escanear", "Visitantes", "Sorteo", "Resumen"]) {
      await page
        .getByRole("navigation", { name: "Navegación móvil" })
        .getByRole("button", { name, exact: true })
        .click();
      await page.waitForTimeout(350);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        ),
        false,
        `${name} overflows at ${width}px`,
      );
      if (name === "Escanear") {
        const box = await page
          .getByRole("button", { name: "Activar cámara" })
          .boundingBox();
        assert.ok(
          box && box.y + box.height < 777,
          `Camera action hidden under bottom nav at ${width}px`,
        );
      }
      await page.screenshot({
        path: `test-results/mobile-${width}-${name}.png`,
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("navigation", { name: "Navegación móvil" })
    .getByRole("button", { name: "Visitantes", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Valentina Prueba/ })
    .first()
    .click();
  await page.screenshot({
    path: "test-results/mobile-passport.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cerrar", exact: true }).click();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "PASS: login, registration, PITs, Refuel, notes, roster, weighted draw, camera QR and 12 responsive views.",
  );
} catch (error) {
  await page.screenshot({ path: "test-results/failure.png", fullPage: true });
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
  await vite?.close();
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
}
