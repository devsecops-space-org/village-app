import { z } from "zod";

export const PITS = [
  {
    id: "race",
    name: "Race Control",
    subtitle: "Charlas y comunidad",
    points: true,
    color: "cyan",
  },
  {
    id: "daytona",
    name: "Daytona PIT",
    subtitle: "Una vuelta al circuito",
    points: true,
    color: "pink",
  },
  {
    id: "knowledge",
    name: "Knowledge PIT",
    subtitle: "Conversaciones y libros",
    points: true,
    color: "yellow",
  },
  {
    id: "merch",
    name: "Merch PIT",
    subtitle: "Conocé el merch",
    points: true,
    color: "violet",
  },
  {
    id: "photo",
    name: "Photo Finish",
    subtitle: "Tu foto en el village",
    points: true,
    color: "green",
  },
  {
    id: "refuel",
    name: "Refuel PIT",
    subtitle: "Canje de cerveza · +18",
    points: false,
    color: "pink",
  },
] as const;
export type PitId = (typeof PITS)[number]["id"];
export const pitSchema = z.enum([
  "race",
  "daytona",
  "knowledge",
  "merch",
  "photo",
  "refuel",
]);
const short = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (v) => !/[\u0000-\u001f\u007f]/.test(v),
      "Caracteres no permitidos",
    );
export const participantSchema = z
  .object({
    badge: z.string().trim().min(1).max(2048),
    name: short(100).min(2, "Ingresá un nombre"),
    email: z.union([z.literal(""), z.email().max(254)]).default(""),
    company: short(120).default(""),
    job: short(100).default(""),
    consent: z.literal(true, {
      error: "Necesitamos autorización para registrar la participación",
    }),
    raffleConsent: z.boolean().default(false),
  })
  .strict();
export const noteSchema = z
  .object({
    interest: z.enum([
      "",
      "AppSec",
      "Pipelines",
      "Cloud",
      "Capacitación",
      "Comunidad",
    ]),
    note: short(500),
    feedback: short(250),
    rookethContact: z.boolean(),
  })
  .strict();
export type Registration = z.input<typeof participantSchema>;
export type NoteInput = z.infer<typeof noteSchema>;
export type Staff = { id: string; name: string; role: "admin" | "staff" };
export type Visit = { pit: PitId; createdAt: string };
export type Participant = {
  id: string;
  name: string;
  email: string;
  company: string;
  job: string;
  createdAt: string;
  raffleConsent: boolean;
  visits: Visit[];
  chances: number;
  interest: string;
  note: string;
  feedback: string;
  rookethContact: boolean;
  redeemedToday: boolean;
};
export type Draw = {
  id: string;
  prize: string;
  createdAt: string;
  winnerId: string;
  winnerName: string;
  totalWeight: number;
  candidates: number;
  ticket: number;
  winnerWeight: number;
};
export type Summary = {
  participants: number;
  visits: number;
  redemptions: number;
  eligible: number;
  pits: { pit: string; count: number }[];
  activity: { id: number; action: string; createdAt: string; staff: string }[];
};

// Treat every badge as data, never navigation or executable content.
export function parseBadge(raw: string): {
  name?: string;
  email?: string;
  company?: string;
  job?: string;
} {
  if (raw.length > 2048) return {};
  try {
    const obj: unknown = JSON.parse(raw);
    const value = z
      .object({
        name: short(100).optional(),
        email: z.email().max(254).optional(),
        company: short(120).optional(),
        job: short(100).optional(),
      })
      .safeParse(obj);
    return value.success ? value.data : {};
  } catch {
    return {};
  }
}
export function chanceCount(visits: { pit: string }[]): number {
  return (
    1 +
    new Set(
      visits
        .filter((v) => PITS.some((p) => p.id === v.pit && p.points))
        .map((v) => v.pit),
    ).size
  );
}
