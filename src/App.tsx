import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type FormEvent,
  type ReactNode,
} from "react";
import type { IScannerControls } from "@zxing/browser";
import {
  ScanLine,
  Users,
  Trophy,
  BarChart3,
  Flag,
  ArrowRight,
  ChevronRight,
  Search,
  Plus,
  X,
  LogOut,
  Check,
  CheckCircle2,
  Camera,
  CameraOff,
  Keyboard,
  RefreshCw,
  Download,
  Ticket,
  BookOpen,
  Shirt,
  Beer,
  Monitor,
  CircleGauge,
  WifiOff,
  ShieldCheck,
  LoaderCircle,
  ChevronLeft,
  AlertCircle,
  LockKeyhole,
  ClipboardList,
  Copy,
} from "lucide-react";
import { api, downloadExport, message, ApiError } from "./api";
import {
  PITS,
  type PitId,
  type Participant,
  type Staff,
  type Summary,
  type Draw,
  type Registration,
  type NoteInput,
} from "../shared/model";

type Screen = "scan" | "people" | "raffle" | "summary";
type Pool = {
  candidates: { id: string; name: string; weight: number }[];
  totalWeight: number;
  draws: Draw[];
};
const PIT_ICONS = {
  race: Monitor,
  daytona: CircleGauge,
  knowledge: BookOpen,
  merch: Shirt,
  photo: Camera,
  refuel: Beer,
};
const NAV = [
  { id: "scan", label: "Escanear", icon: ScanLine },
  { id: "people", label: "Visitantes", icon: Users },
  { id: "raffle", label: "Sorteo", icon: Trophy },
  { id: "summary", label: "Resumen", icon: BarChart3 },
] as const;
const time = (s: string) =>
  new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(s));
const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
function Spinner() {
  return <LoaderCircle className="spin" size={18} />;
}
function ErrorText({ text }: { text: string }) {
  return text ? (
    <p role="alert" className="error">
      <AlertCircle size={17} />
      {text}
    </p>
  ) : null;
}
function Brand() {
  return (
    <div className="brand">
      <img src={`${import.meta.env.BASE_URL}brand.png`} alt="" />
      <span>
        DEVSECOPS <b>SPACE</b>
        <small>
          PIT CONTROL <span> / 2026</span>
        </small>
      </span>
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="dialog-title"
    >
      <div className="dialog-head">
        <h2 id="dialog-title">{title}</h2>
        <button
          className="icon-button"
          title="Cerrar"
          aria-label="Cerrar"
          onClick={onClose}
        >
          <X />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function ExportButton({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        downloadExport()
          .catch((e) =>
            window.dispatchEvent(
              new CustomEvent("app-error", { detail: message(e) }),
            ),
          )
          .finally(() => setBusy(false));
      }}
    >
      <Download size={17} />
      {children}
    </button>
  );
}
function Login({ onLogin }: { onLogin: (user: Staff) => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    try {
      const r = await api<{ user: Staff }>("/login", "POST", {
        username: form.get("username"),
        password: form.get("password"),
      });
      onLogin(r.user);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="login-shell">
        <Brand />
        <div className="login-rule" />
        <div className="eyebrow">
          <Flag size={16} /> EKOPARTY · BUENOS AIRES
        </div>
        <h1>
          El equipo detrás
          <br />
          de cada vuelta<span>.</span>
        </h1>
        <p className="muted">Acceso del equipo · Grand Prix 2026</p>
        <form onSubmit={submit}>
          <label>
            Usuario
            <input
              name="username"
              autoComplete="username"
              required
              maxLength={100}
            />
          </label>
          <label>
            Contraseña
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
            />
          </label>
          <ErrorText text={error} />
          <button className="primary full" disabled={busy}>
            {busy ? <Spinner /> : <LockKeyhole size={18} />} Ingresar a Pit
            Control <ArrowRight size={18} />
          </button>
        </form>
        <div className="login-footer">
          <ShieldCheck size={16} /> EQUIPO AUTORIZADO{" "}
          <span>SECURE / VELOCITY</span>
        </div>
      </div>
    </main>
  );
}
export function App() {
  const [user, setUser] = useState<Staff | null>(null),
    [checking, setChecking] = useState(true),
    [screen, setScreen] = useState<Screen>("scan");
  const [pit, setPit] = useState<PitId>(() => {
    const value = sessionStorage.getItem("pit");
    return PITS.some((p) => p.id === value) ? (value as PitId) : "race";
  });
  const [summary, setSummary] = useState<Summary | null>(null),
    [participant, setParticipant] = useState<Participant | null>(null),
    [registration, setRegistration] = useState<Partial<Registration> | null>(
      null,
    );
  const [toast, setToast] = useState(""),
    [globalError, setGlobalError] = useState(""),
    [online, setOnline] = useState(navigator.onLine),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    api<{ user: Staff }>("/me")
      .then((r) => setUser(r.user))
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401))
          setGlobalError(message(e));
      })
      .finally(() => setChecking(false));
    const expire = () => {
      setUser(null);
      setParticipant(null);
      setRegistration(null);
    };
    const fail = (e: Event) => setGlobalError((e as CustomEvent).detail);
    window.addEventListener("session-expired", expire);
    window.addEventListener("app-error", fail);
    return () => {
      window.removeEventListener("session-expired", expire);
      window.removeEventListener("app-error", fail);
    };
  }, []);
  useEffect(() => {
    const handle = () => setOnline(navigator.onLine);
    window.addEventListener("online", handle);
    window.addEventListener("offline", handle);
    return () => {
      window.removeEventListener("online", handle);
      window.removeEventListener("offline", handle);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(id);
  }, [toast]);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    const load = () =>
      api<Summary>("/summary")
        .then((r) => {
          if (alive) {
            setSummary(r);
            setGlobalError("");
          }
        })
        .catch((e) => {
          if (alive) setGlobalError(message(e));
        });
    void load();
    const interval = setInterval(load, 20000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [user, revision]);
  const selectPit = (value: PitId) => {
    setPit(value);
    sessionStorage.setItem("pit", value);
  };
  const onBadge = async (raw: string) => {
    const r = await api<{
      participant?: Participant;
      prefill?: Partial<Registration>;
    }>("/badge", "POST", { raw });
    if (r.participant) setParticipant(r.participant);
    else setRegistration({ badge: raw, ...r.prefill });
  };
  const openPerson = async (id: string) => {
    try {
      setParticipant(await api<Participant>(`/participants/${id}`));
    } catch (e) {
      setGlobalError(message(e));
    }
  };
  async function logout() {
    try {
      await api("/logout", "POST", {});
      setUser(null);
      setSummary(null);
      setParticipant(null);
    } catch (e) {
      setGlobalError(message(e));
    }
  }
  if (checking)
    return (
      <main className="loading">
        <Spinner /> Preparando Pit Control
      </main>
    );
  if (!user)
    return (
      <>
        <Login
          onLogin={(u) => {
            setUser(u);
            setGlobalError("");
          }}
        />
        {globalError && (
          <div className="login-error">
            <ErrorText text={globalError} />
            <button onClick={() => location.reload()}>Reintentar</button>
          </div>
        )}
      </>
    );
  const currentPit = PITS.find((p) => p.id === pit)!;
  return (
    <div className="app">
      <aside className="sidebar">
        <Brand />
        <div className="event-label">
          <span className="live-dot" /> GRAND PRIX 2026
          <small>EKOPARTY · BUENOS AIRES</small>
        </div>
        <nav aria-label="Principal">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={screen === n.id ? "active" : ""}
              onClick={() => setScreen(n.id)}
              aria-current={screen === n.id ? "page" : undefined}
            >
              <n.icon size={20} />
              {n.label}
              {screen === n.id && <ChevronRight size={16} />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="team-avatar">{initials(user.name)}</div>
          <div>
            {user.name}
            <small>
              {user.role === "admin" ? "Administrador" : "Pit crew"}
            </small>
          </div>
          <button
            className="icon-button"
            onClick={logout}
            aria-label="Cerrar sesión"
            title="Cerrar sesión"
          >
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="crumb">
            RACE OPERATIONS <span>/</span>{" "}
            {NAV.find((n) => n.id === screen)!.label}
          </div>
          <div className="connection">
            <span className={online ? "live-dot" : "offline-dot"} />
            {online ? "Conectado" : "Sin conexión"}
          </div>
          <button
            className="icon-button mobile-logout"
            onClick={logout}
            title="Cerrar sesión"
            aria-label="Cerrar sesión"
          >
            <LogOut size={18} />
          </button>
        </header>
        <main className="content">
          <div className="page-heading">
            <div className="eyebrow">DEVSECOPS SPACE / PIT CONTROL</div>
            <div className="heading-row">
              <h1>
                {
                  {
                    scan: "Cada visita cuenta.",
                    people: "El paddock.",
                    raffle: "La próxima vuelta tiene premio.",
                    summary: "El pulso del village.",
                  }[screen]
                }
              </h1>
              <button
                className="icon-button"
                onClick={refresh}
                title="Actualizar datos"
                aria-label="Actualizar datos"
              >
                <RefreshCw size={19} />
              </button>
            </div>
            <p className="muted">
              {
                {
                  scan: "Registrá una participación y seguí la conversación.",
                  people: "Personas, intereses y recorrido por los PITs.",
                  raffle: "Más PITs distintos, más chances. Todos en carrera.",
                  summary:
                    "Participación y actividad del equipo en un solo lugar.",
                }[screen]
              }
            </p>
          </div>
          {!online && (
            <div role="status" className="notice">
              <WifiOff size={18} />
              Sin conexión. Las operaciones requieren confirmación del servidor.
            </div>
          )}
          <ErrorText text={globalError} />
          <div className="metrics">
            <Metric
              label="VISITANTES"
              value={summary?.participants}
              icon={<Users />}
            />
            <Metric
              label="PARTICIPACIONES"
              value={summary?.visits}
              icon={<Flag />}
            />
            <Metric
              label="EN EL SORTEO"
              value={summary?.eligible}
              icon={<Ticket />}
            />
            <Metric
              label="REFUELS"
              value={summary?.redemptions}
              icon={<Beer />}
            />
          </div>
          {screen === "scan" && (
            <div className="scan-layout">
              <section className="scan-main">
                <div className="section-title">
                  <h2>
                    <ScanLine size={20} /> Escanear badge
                  </h2>
                  <span className="micro-label">CHECK-IN</span>
                </div>
                <Scanner
                  onBadge={onBadge}
                  paused={!!participant || !!registration}
                />
                <div className="scan-actions">
                  <span>¿No tiene el badge a mano?</span>
                  <button
                    className="text-button"
                    onClick={() =>
                      setRegistration({
                        badge: `manual:${crypto.randomUUID()}`,
                      })
                    }
                  >
                    <Plus size={17} /> Registro manual
                  </button>
                </div>
              </section>
              <aside className="pit-column">
                <div className="section-title">
                  <h2>Tu estación</h2>
                  <span className="micro-label">
                    {String(PITS.findIndex((p) => p.id === pit) + 1).padStart(
                      2,
                      "0",
                    )}{" "}
                    / 06
                  </span>
                </div>
                <div className="pit-options">
                  {PITS.map((p, i) => {
                    const Icon = PIT_ICONS[p.id];
                    return (
                      <button
                        key={p.id}
                        aria-pressed={pit === p.id}
                        onClick={() => selectPit(p.id)}
                        className={`pit-option ${p.color} ${pit === p.id ? "selected" : ""}`}
                      >
                        <span className="pit-number">0{i + 1}</span>
                        <Icon size={22} />
                        <span>
                          <b>{p.name}</b>
                          <small>{p.subtitle}</small>
                        </span>
                        {pit === p.id ? (
                          <CheckCircle2 size={19} />
                        ) : (
                          <ChevronRight size={17} />
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="station-footer">
                  <Flag size={17} />
                  <span>
                    Estación activa <b>{currentPit.name}</b>
                  </span>
                </div>
              </aside>
            </div>
          )}
          {screen === "people" && (
            <People
              revision={revision}
              onOpen={openPerson}
              onAdd={() =>
                setRegistration({ badge: `manual:${crypto.randomUUID()}` })
              }
              admin={user.role === "admin"}
            />
          )}
          {screen === "raffle" && (
            <Raffle
              revision={revision}
              refresh={refresh}
              admin={user.role === "admin"}
            />
          )}
          {screen === "summary" && (
            <Overview summary={summary} admin={user.role === "admin"} />
          )}
          <footer className="page-footer">
            <span>
              GRAND PRIX 2026 <span className="slash">/</span> EKOPARTY
            </span>
            <span>
              SECURE <span className="cyan">&</span> VELOCITY
            </span>
          </footer>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Navegación móvil">
        {NAV.map((n) => (
          <button
            key={n.id}
            className={screen === n.id ? "active" : ""}
            onClick={() => setScreen(n.id)}
            aria-label={n.label}
          >
            <n.icon size={22} />
            <span>{n.label}</span>
          </button>
        ))}
      </nav>
      {registration && (
        <Modal title="Nuevo visitante" onClose={() => setRegistration(null)}>
          <Register
            initial={registration}
            onSave={(p) => {
              setRegistration(null);
              setParticipant(p);
              refresh();
              setToast("Visitante registrado");
            }}
          />
        </Modal>
      )}
      {participant && (
        <Modal
          title="Pasaporte del village"
          onClose={() => setParticipant(null)}
        >
          <Passport
            initial={participant}
            pit={pit}
            onChange={(p) => {
              setParticipant(p);
              refresh();
            }}
            onNext={() => {
              setParticipant(null);
              setToast("Listo. Seguimos con el próximo visitante.");
            }}
          />
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={19} />
          {toast}
        </div>
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  icon,
}: {
  label: string;
  value?: number;
  icon: ReactNode;
}) {
  return (
    <div className="metric">
      <div>
        <span>{label}</span>
        <strong>
          {value === undefined ? "—" : value.toLocaleString("es-AR")}
        </strong>
      </div>
      {icon}
    </div>
  );
}
function Scanner({
  onBadge,
  paused,
}: {
  onBadge: (raw: string) => Promise<void>;
  paused: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null),
    controls = useRef<IScannerControls | null>(null),
    generation = useRef(0);
  const [active, setActive] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [manual, setManual] = useState(false),
    [raw, setRaw] = useState("");
  const stop = useCallback(() => {
    generation.current++;
    controls.current?.stop();
    controls.current = null;
    if (video.current?.srcObject instanceof MediaStream)
      video.current.srcObject.getTracks().forEach((t) => t.stop());
    setActive(false);
  }, []);
  useEffect(() => {
    if (paused) stop();
  }, [paused, stop]);
  useEffect(
    () => () => {
      generation.current++;
      controls.current?.stop();
    },
    [],
  );
  async function scan() {
    setError("");
    setActive(true);
    const version = ++generation.current;
    let consumed = false;
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      if (version !== generation.current) return;
      const reader = new BrowserQRCodeReader();
      const controller = await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: "environment" } }, audio: false },
        video.current!,
        async (result, _error, control) => {
          if (!result || consumed || version !== generation.current) return;
          consumed = true;
          control.stop();
          stop();
          setBusy(true);
          try {
            await onBadge(result.getText());
          } catch (e) {
            setError(message(e));
          } finally {
            setBusy(false);
          }
        },
      );
      if (version !== generation.current) controller.stop();
      else controls.current = controller;
    } catch (error) {
      console.warn(
        "camera.start.failed",
        error instanceof Error ? error.message : "unavailable",
      );
      stop();
      setError(
        "No pudimos abrir la cámara. Revisá el permiso o ingresá el código del badge.",
      );
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    stop();
    try {
      await onBadge(raw.trim());
      setRaw("");
      setManual(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className={`camera-stage ${active ? "camera-active" : ""}`}>
        <video ref={video} playsInline muted autoPlay hidden={!active} />
        {!active && (
          <div className="camera-idle">
            <div className="finder">
              <ScanLine size={58} strokeWidth={1.3} />
              <i />
              <i />
              <i />
              <i />
            </div>
            <h3>Un badge. Toda su vuelta.</h3>
            <p>Acercá el QR a la cámara</p>
          </div>
        )}
        <div className="camera-top">
          <span className="camera-tag">
            <span className="live-dot" />
            {active ? "CÁMARA ACTIVA" : "LECTOR QR"}
          </span>
          <ShieldCheck size={18} />
        </div>
        <div className="camera-bottom">
          <span>DEVSECOPS SPACE</span>
          <span>GP / 26</span>
        </div>
      </div>
      <ErrorText text={error} />
      <div className="camera-buttons">
        {active ? (
          <button className="secondary" onClick={stop}>
            <CameraOff size={18} />
            Detener cámara
          </button>
        ) : (
          <button className="primary" onClick={scan} disabled={busy || paused}>
            {busy ? <Spinner /> : <Camera size={19} />} Activar cámara
          </button>
        )}
        <button
          className="secondary"
          onClick={() => {
            stop();
            setManual(!manual);
          }}
          disabled={busy}
        >
          <Keyboard size={19} /> Ingresar código
        </button>
      </div>
      {manual && (
        <form className="manual-code" onSubmit={submit}>
          <label>
            Código o contenido del QR
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              maxLength={2048}
              rows={2}
              required
              placeholder="Identificador del badge"
            />
          </label>
          <button className="primary" disabled={busy || !raw.trim()}>
            Buscar badge <ArrowRight size={17} />
          </button>
        </form>
      )}
    </>
  );
}
function Register({
  initial,
  onSave,
}: {
  initial: Partial<Registration>;
  onSave: (p: Participant) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      onSave(
        await api<Participant>("/participants", "POST", {
          badge: initial.badge,
          name: f.get("name"),
          email: f.get("email"),
          company: f.get("company"),
          job: f.get("job"),
          consent: f.get("consent") === "on",
          raffleConsent: f.get("raffle") === "on",
        }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="form-stack">
      <label>
        Nombre y apellido
        <input
          name="name"
          defaultValue={initial.name}
          required
          minLength={2}
          maxLength={100}
          autoComplete="off"
        />
      </label>
      <label>
        Correo <span className="optional">opcional</span>
        <input
          name="email"
          defaultValue={initial.email}
          type="email"
          maxLength={254}
          autoComplete="off"
        />
      </label>
      <div className="form-grid">
        <label>
          Empresa <span className="optional">opcional</span>
          <input
            name="company"
            defaultValue={initial.company}
            maxLength={120}
          />
        </label>
        <label>
          Cargo <span className="optional">opcional</span>
          <input name="job" defaultValue={initial.job} maxLength={100} />
        </label>
      </div>
      <div className="consent-area">
        <label className="checkbox">
          <input name="consent" type="checkbox" required />
          <span>
            Autoriza a DevSecOps Space a registrar sus datos y participaciones
            para gestionar la experiencia del village.
          </span>
        </label>
        <label className="checkbox">
          <input name="raffle" type="checkbox" />
          <span>
            Quiere participar en el sorteo.
            <small>
              1 chance por inscripción + 1 por PIT distinto. Máximo 6. Refuel no
              suma.
            </small>
          </span>
        </label>
      </div>
      <ErrorText text={error} />
      <button className="primary full" disabled={busy}>
        {busy ? <Spinner /> : <Plus size={18} />} Registrar visitante
      </button>
    </form>
  );
}
function Passport({
  initial,
  pit,
  onChange,
  onNext,
}: {
  initial: Participant;
  pit: PitId;
  onChange: (p: Participant) => void;
  onNext: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notes, setNotes] = useState(false),
    [confirm, setConfirm] = useState<PitId | null>(null);
  const [age, setAge] = useState(false),
    [sticker, setSticker] = useState(false),
    [saved, setSaved] = useState(false);
  async function record(id: PitId) {
    setBusy(true);
    setError("");
    try {
      const p = await api<Participant>(
        `/participants/${initial.id}/${id === "refuel" ? "refuel" : "visits"}`,
        "POST",
        id === "refuel"
          ? { ageVerified: age, stickerVerified: sticker }
          : { pit: id },
      );
      onChange(p);
      setConfirm(null);
      setSaved(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveNotes(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    const data: NoteInput = {
      interest: f.get("interest") as NoteInput["interest"],
      note: String(f.get("note")),
      feedback: String(f.get("feedback")),
      rookethContact: f.get("rooketh") === "on",
    };
    try {
      onChange(
        await api<Participant>(
          `/participants/${initial.id}/notes`,
          "PATCH",
          data,
        ),
      );
      setNotes(false);
      setSaved(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="passport">
      <div className="person-heading">
        <div className="avatar large">{initials(initial.name)}</div>
        <div>
          <h3>{initial.name}</h3>
          <p>
            {[initial.job, initial.company].filter(Boolean).join(" · ") ||
              "Visitante del village"}
          </p>
          {initial.email && <small>{initial.email}</small>}
        </div>
        <div className="chances">
          <strong>{initial.chances}</strong>
          <span>chances</span>
        </div>
      </div>
      <div className="passport-status">
        <span>
          <Flag size={16} />
          {initial.visits.filter((v) => v.pit !== "refuel").length} / 5 PITs
        </span>
        <span className={initial.raffleConsent ? "green-text" : "muted"}>
          {initial.raffleConsent
            ? "Participa del sorteo"
            : "Sin inscripción al sorteo"}
        </span>
      </div>
      <div className="passport-pits">
        {PITS.map((p) => {
          const Icon = PIT_ICONS[p.id];
          const done =
            p.id === "refuel"
              ? initial.redeemedToday
              : initial.visits.some((v) => v.pit === p.id);
          return (
            <button
              key={p.id}
              className={`${done ? "completed" : ""} ${p.id === pit ? "current" : ""}`}
              disabled={busy || done}
              onClick={() => {
                setConfirm(p.id);
                setError("");
                setSaved(false);
              }}
            >
              <Icon size={21} />
              <span>
                {p.name}
                <small>
                  {done
                    ? p.id === "refuel"
                      ? "Canjeado hoy"
                      : "Participación registrada"
                    : p.id === "refuel"
                      ? "Canje · solo +18"
                      : p.id === pit
                        ? "Tu estación activa"
                        : "+1 chance"}
                </small>
              </span>
              {done ? <CheckCircle2 size={20} /> : <Plus size={18} />}
            </button>
          );
        })}
      </div>
      {confirm && (
        <div className="confirm-box">
          <h3>
            {confirm === "refuel"
              ? "Confirmar entrega de cerveza"
              : `Registrar ${PITS.find((p) => p.id === confirm)!.name}`}
          </h3>
          {confirm === "refuel" ? (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={age}
                  onChange={(e) => setAge(e.target.checked)}
                />
                Verifiqué que es mayor de 18 años.
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={sticker}
                  onChange={(e) => setSticker(e.target.checked)}
                />
                Presentó el sticker de participación.
              </label>
              <small>Un canje diario por persona. No suma chances.</small>
            </>
          ) : (
            <p>Confirmá que la persona participó en esta estación.</p>
          )}
          <div className="button-row">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Cancelar
            </button>
            <button
              className="primary"
              disabled={busy || (confirm === "refuel" && (!age || !sticker))}
              onClick={() => record(confirm)}
            >
              {busy ? <Spinner /> : <Check size={18} />}Confirmar
            </button>
          </div>
        </div>
      )}
      <ErrorText text={error} />
      {saved && (
        <p className="success" role="status">
          <CheckCircle2 size={17} />
          Guardado en el pasaporte
        </p>
      )}
      <button
        className="notes-toggle text-button"
        onClick={() => setNotes(!notes)}
      >
        <ClipboardList size={18} /> Conversación y feedback{" "}
        <ChevronRight size={17} />
      </button>
      {notes && (
        <form className="form-stack note-form" onSubmit={saveNotes}>
          <label>
            Interés
            <select name="interest" defaultValue={initial.interest}>
              <option value="">Sin etiqueta</option>
              {[
                "AppSec",
                "Pipelines",
                "Cloud",
                "Capacitación",
                "Comunidad",
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Nota del equipo
            <textarea
              name="note"
              maxLength={500}
              rows={2}
              defaultValue={initial.note}
            />
          </label>
          <label>
            ¿Qué tema te gustaría ver en la comunidad?
            <textarea
              name="feedback"
              maxLength={250}
              rows={2}
              defaultValue={initial.feedback}
            />
          </label>
          <label className="checkbox">
            <input
              name="rooketh"
              type="checkbox"
              defaultChecked={initial.rookethContact}
            />
            <span>Solicitó y autorizó contacto de Rooketh.</span>
          </label>
          <button className="secondary" disabled={busy}>
            {busy ? <Spinner /> : <Check size={17} />}Guardar conversación
          </button>
        </form>
      )}
      <button
        className="primary full next-person"
        onClick={onNext}
        disabled={busy}
      >
        Próximo visitante <ArrowRight size={18} />
      </button>
    </div>
  );
}
function People({
  revision,
  onOpen,
  onAdd,
  admin,
}: {
  revision: number;
  onOpen: (id: string) => void;
  onAdd: () => void;
  admin: boolean;
}) {
  const [q, setQ] = useState(""),
    [page, setPage] = useState(1),
    [data, setData] = useState<{
      participants: Participant[];
      total: number;
    } | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const timer = setTimeout(
      () =>
        api<{ participants: Participant[]; total: number }>(
          `/participants?q=${encodeURIComponent(q)}&page=${page}`,
        )
          .then((r) => {
            if (alive) {
              setData(r);
              setError("");
            }
          })
          .catch((e) => {
            if (alive) setError(message(e));
          })
          .finally(() => {
            if (alive) setLoading(false);
          }),
      200,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, page, revision]);
  return (
    <section>
      <div className="list-toolbar">
        <div className="search">
          <Search size={18} />
          <input
            value={q}
            maxLength={100}
            placeholder="Buscar nombre, empresa o correo"
            aria-label="Buscar visitantes"
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="button-row">
          {admin && (
            <ExportButton className="secondary">
              <span>CSV</span>
            </ExportButton>
          )}
          <button className="primary" onClick={onAdd}>
            <Plus size={18} /> Visitante
          </button>
        </div>
      </div>
      <ErrorText text={error} />
      {loading ? (
        <div className="empty">
          <Spinner />
          Cargando visitantes
        </div>
      ) : !data?.participants.length ? (
        <Empty
          icon={<Users size={36} />}
          title={
            q ? "No encontramos coincidencias" : "La primera vuelta empieza acá"
          }
          text={
            q
              ? "Probá con otro nombre o empresa."
              : "Escaneá un badge o registrá al primer visitante."
          }
        />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>VISITANTE</th>
                  <th className="hide-mobile">EMPRESA / CARGO</th>
                  <th>PITs</th>
                  <th>CHANCES</th>
                  <th aria-label="Abrir" />
                </tr>
              </thead>
              <tbody>
                {data.participants.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <button
                        className="person-link"
                        onClick={() => onOpen(p.id)}
                      >
                        <span className="avatar">{initials(p.name)}</span>
                        <span>
                          <b>{p.name}</b>
                          <small>{time(p.createdAt)}</small>
                        </span>
                      </button>
                    </td>
                    <td className="hide-mobile">
                      {p.company || "—"}
                      <small>{p.job}</small>
                    </td>
                    <td>
                      <span className="pit-dots">
                        {PITS.filter((x) => x.points).map((x) => (
                          <span
                            key={x.id}
                            className={
                              p.visits.some((v) => v.pit === x.id) ? "done" : ""
                            }
                            title={x.name}
                          />
                        ))}
                      </span>
                      <small>
                        {p.visits.filter((v) => v.pit !== "refuel").length}/5
                      </small>
                    </td>
                    <td>
                      <span className="ticket-count">
                        <Ticket size={16} />
                        {p.chances}
                      </span>
                      {!p.raffleConsent && <small>Sin sorteo</small>}
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        title={`Abrir ${p.name}`}
                        aria-label={`Abrir ${p.name}`}
                        onClick={() => onOpen(p.id)}
                      >
                        <ChevronRight size={18} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <span>{data.total} visitantes</span>
            <div className="button-row">
              <button
                className="icon-button"
                aria-label="Página anterior"
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft />
              </button>
              <span>{page}</span>
              <button
                className="icon-button"
                aria-label="Página siguiente"
                disabled={page * 40 >= data.total}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight />
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
function Empty({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function Raffle({
  revision,
  refresh,
  admin,
}: {
  revision: number;
  refresh: () => void;
  admin: boolean;
}) {
  const [pool, setPool] = useState<Pool | null>(null),
    [error, setError] = useState(""),
    [prize, setPrize] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [winner, setWinner] = useState<Draw | null>(null),
    [audit, setAudit] = useState<object | null>(null);
  const requestId = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<Pool>("/raffle")
      .then((p) => {
        if (alive) {
          setPool(p);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [revision]);
  async function draw() {
    setBusy(true);
    setError("");
    requestId.current ??= crypto.randomUUID();
    try {
      const result = await api<Draw>("/raffle/draw", "POST", {
        prize,
        requestId: requestId.current,
      });
      setWinner(result);
      requestId.current = null;
      setConfirm(false);
      setPrize("");
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="raffle-layout">
      {audit && (
        <Modal title="Registro del sorteo" onClose={() => setAudit(null)}>
          <pre className="audit-json">{JSON.stringify(audit, null, 2)}</pre>
        </Modal>
      )}
      <div className="draw-panel">
        <div className="section-title">
          <h2>
            <Trophy size={20} /> Podio del village
          </h2>
          <span className="micro-label">SORTEO PONDERADO</span>
        </div>
        <div className="draw-emblem">
          <Flag size={40} />
          <span>
            GRAND PRIX <b>2026</b>
          </span>
        </div>
        <div className="draw-totals">
          <div>
            <strong>{pool?.candidates.length ?? "—"}</strong>
            <span>participantes elegibles</span>
          </div>
          <div>
            <strong>{pool?.totalWeight ?? "—"}</strong>
            <span>chances en carrera</span>
          </div>
        </div>
        <div className="rules">
          <p>
            <Check size={16} /> 1 chance inicial + 1 por PIT distinto
          </p>
          <p>
            <Check size={16} /> Máximo 6. Refuel no suma
          </p>
          <p>
            <Check size={16} /> Ganadores anteriores quedan fuera
          </p>
          <p>
            <Check size={16} /> Solo personas que aceptaron participar
          </p>
        </div>
        <label>
          Premio
          <input
            value={prize}
            onChange={(e) => setPrize(e.target.value)}
            maxLength={100}
            placeholder="Ej. Pack Grand Prix 2026"
            disabled={busy || confirm || !admin}
          />
        </label>
        <ErrorText text={error} />
        {confirm ? (
          <div className="confirm-box">
            <h3>¿Sortear «{prize}»?</h3>
            <p>
              El resultado queda registrado. Se usará el padrón vigente al
              confirmar.
            </p>
            <div className="button-row">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                Cancelar
              </button>
              <button className="primary" disabled={busy} onClick={draw}>
                {busy ? <Spinner /> : <Trophy size={18} />}Confirmar sorteo
              </button>
            </div>
          </div>
        ) : (
          <button
            className="primary full"
            disabled={
              !admin || prize.trim().length < 2 || !pool?.candidates.length
            }
            onClick={() => setConfirm(true)}
          >
            <Trophy size={18} />
            {admin ? "Realizar sorteo" : "Solo el administrador puede sortear"}
          </button>
        )}
        {winner && (
          <div className="winner" role="status">
            <Trophy size={28} />
            <span>EN EL PODIO</span>
            <h2>{winner.winnerName}</h2>
            <p>{winner.prize}</p>
            <small>
              {winner.winnerWeight} chances de {winner.totalWeight} ·{" "}
              {time(winner.createdAt)}
            </small>
          </div>
        )}
      </div>
      <div className="leaderboard">
        <div className="section-title">
          <h2>En carrera</h2>
          <span className="micro-label">CHANCES / PROBABILIDAD</span>
        </div>
        {!pool?.candidates.length ? (
          <Empty
            icon={<Ticket size={30} />}
            title="La grilla está abierta"
            text="Los visitantes que acepten el sorteo aparecerán aquí."
          />
        ) : (
          <ol className="ranking">
            {pool.candidates.map((p, i) => (
              <li key={p.id}>
                <span className="rank-position">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="avatar">{initials(p.name)}</span>
                <b>{p.name}</b>
                <span>
                  <strong>
                    {p.weight} <Ticket size={15} />
                  </strong>
                  <small>
                    {((100 * p.weight) / pool.totalWeight).toFixed(1)}%
                  </small>
                </span>
              </li>
            ))}
          </ol>
        )}
        <div className="section-title history-title">
          <h2>Sorteos realizados</h2>
          <span>{pool?.draws.length ?? 0}</span>
        </div>
        {pool?.draws.map((d) => (
          <article className="draw-history" key={d.id}>
            <Trophy size={20} />
            <div>
              <b>{d.winnerName}</b>
              <p>{d.prize}</p>
              <small>
                {time(d.createdAt)} · {d.candidates} participantes
              </small>
            </div>
            {admin && (
              <button
                className="icon-button"
                title="Ver registro del sorteo"
                aria-label="Ver registro del sorteo"
                onClick={() =>
                  api<object>(`/raffle/${d.id}/audit`)
                    .then(setAudit)
                    .catch((e) => setError(message(e)))
                }
              >
                <ClipboardList size={18} />
              </button>
            )}
          </article>
        ))}
        {!pool?.draws.length && (
          <p className="muted">Todavía no hay resultados.</p>
        )}
      </div>
    </section>
  );
}
function Overview({
  summary,
  admin,
}: {
  summary: Summary | null;
  admin: boolean;
}) {
  const labels: Record<string, string> = {
    "participant.created": "Visitante registrado",
    "visit.created": "Participación registrada",
    "refuel.redeemed": "Canje de Refuel",
    "raffle.drawn": "Sorteo realizado",
    "participant.notes": "Conversación guardada",
    "participants.exported": "Exportación CSV",
    "login.success": "Ingreso del equipo",
    "login.failed": "Intento de acceso fallido",
  };
  return (
    <div className="overview">
      <section>
        <div className="section-title">
          <h2>Participación por PIT</h2>
          {admin && (
            <ExportButton className="text-button">Exportar</ExportButton>
          )}
        </div>
        {PITS.map((p) => {
          const Icon = PIT_ICONS[p.id];
          const count = summary?.pits.find((v) => v.pit === p.id)?.count ?? 0;
          return (
            <div className={`pit-bar ${p.color}`} key={p.id}>
              <div>
                <Icon size={19} />
                <b>{p.name}</b>
                <span>{count}</span>
              </div>
              <progress
                max={Math.max(1, summary?.participants ?? 0)}
                value={count}
                aria-label={`Visitas ${p.name}`}
              />
            </div>
          );
        })}
      </section>
      <section>
        <div className="section-title">
          <h2>Actividad del equipo</h2>
          <span className="micro-label">ÚLTIMOS MOVIMIENTOS</span>
        </div>
        <div className="activity-list">
          {summary?.activity.map((a) => (
            <div key={a.id}>
              <span className="activity-dot" />
              <div>
                <b>{labels[a.action] ?? a.action}</b>
                <small>
                  {a.staff ?? "Acceso"} · {time(a.createdAt)}
                </small>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
