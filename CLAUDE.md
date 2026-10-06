# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Pit Control": mobile web app for the Ekoparty village team (Spanish UI/docs). Static React + TypeScript + Vite SPA deployed to GitHub Pages; Supabase (Postgres + Auth) is the only backend. Staff scan attendee badge QRs, register PIT visits and Refuel redemptions, and admins run a weighted raffle. Requires Node >= 22.13.

`legacy/` holds the previous Express + SQLite server and its tests for reference only. It is excluded from `tsconfig.json`, its dependencies are not installed, and it must not be imported.

## Commands

```sh
npm ci
cp .env.example .env.local     # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (public values)
npm run dev                    # Vite on http://localhost:4173
npm run build                  # tsc --noEmit && vite build (typecheck is part of build)
npm test                       # node:test; runs the real migration on in-memory Postgres (PGlite)
npx tsx --test --test-name-pattern="<name>" tests/db.test.ts   # single test
npm run check                  # build + test
SUPABASE_SERVICE_ROLE_KEY=... npm run create-user -- <user> admin|staff
npm run format / format:check
npm run audit:deps
```

Deploy: `.github/workflows/deploy.yml` (test, build with `BASE_PATH`, publish to Pages). Repo variables supply the `VITE_*` values.

## Architecture

- `supabase/migrations/0001_init.sql` — the whole backend. Tables live in schema `private` (not exposed by the Data API, RLS on, no policies, no grants). The browser can only call the `SECURITY DEFINER` functions in `public`, each of which starts with `private.staff_id()` (session + role from `private.profiles`, never from the JWT). Business rules, validation (CHECK constraints) and audit logging live here.
- `src/supabase.ts` — client; `loginEmail` maps a username to `<user>@VITE_LOGIN_DOMAIN`.
- `src/api.ts` — keeps the old path-style interface `api(path, method, body)` and maps each path to Supabase Auth or one RPC. Hashes badge content with SHA-256 before sending. Maps SQLSTATE `PTxxx` raised by `private.fail` to HTTP-like statuses and user messages.
- `src/App.tsx` — single large component file with all views (scan, visitors, summary, raffle).
- `shared/model.ts` — `PITS`, Zod schemas, `parseBadge`, types. Zod here is UX only; SQL is the authority. `shared/csv.ts` — formula-safe CSV cell.
- `scripts/create-user.ts` — creates an Auth user and its profile via `provision_profile` (service_role only).
- `vite.config.ts` — injects the CSP meta tag at build time (connect-src limited to the Supabase project); `base` comes from `BASE_PATH`.

## Rules that must hold

- Never add grants or RLS policies for `anon`/`authenticated` on `private` tables, and never expose the `private` schema. New data access = new `public` function that calls `private.staff_id()` first, has `set search_path = ''`, and is added to the grant block at the end of the migration. Add a negative test in `tests/db.test.ts`.
- The `service_role` key never goes in the repo, `.env.local`, the build, or the workflow.
- Scores are never accepted from the client: chances = 1 + distinct point-PIT visits, max 6; Refuel gives no points. Refuel needs a prior PIT visit and allows one redemption per person per Buenos Aires day (computed in SQL).
- Raffle runs in `draw_raffle` under an advisory lock with `pgcrypto` randomness (rejection sampling), stores the roster snapshot, excludes previous winners and non-opt-ins, and is idempotent by request UUID.
- Raw QR content is never stored or sent; only its SHA-256. JSON QRs only prefill the form.
- Production CSP forbids inline scripts/styles; do not add inline `<script>`/`<style>` or third-party origins.
- See `SECURITY.md` for the control mapping and residual risks before touching auth, the migration, or the CSP.
