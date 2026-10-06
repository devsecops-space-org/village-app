# Pit Control · DevSecOps Space

Web móvil para el equipo del village. React + TypeScript + Vite como sitio estático (GitHub Pages) y Supabase (PostgreSQL + Auth) como backend. No hay servidor propio: el navegador llama a funciones de la base, y son esas funciones las que verifican sesión, rol y reglas. La versión anterior (Express + SQLite) quedó en `legacy/` solo como referencia; no se compila ni se despliega.

## Preparar Supabase (una vez)

1. Crear el proyecto con **Enable Data API** activado, **Automatically expose new tables** desactivado y **Enable automatic RLS** activado.
2. En SQL Editor, ejecutar completo `supabase/migrations/0001_init.sql`.
3. En Authentication, desactivar el registro público de usuarios (signups). Las cuentas se crean solo con el script de abajo.
4. En la configuración de la Data API, exponer únicamente el esquema `public`. Las tablas viven en `private` y no deben agregarse a los esquemas expuestos.
5. Revisar el Security Advisor del proyecto: no debe reportar tablas sin RLS ni funciones con `search_path` mutable.

## Arranque local

Requiere Node 22.13 o posterior.

```sh
npm ci
cp .env.example .env.local   # completar URL del proyecto y clave anon
npm run dev
```

Abrir http://localhost:4173. Para crear cuentas del equipo, exportar la clave `service_role` solo en la terminal (nunca en un archivo del repo ni en GitHub):

```sh
SUPABASE_SERVICE_ROLE_KEY=... npm run create-user -- admin admin
SUPABASE_SERVICE_ROLE_KEY=... npm run create-user -- guillermo staff
```

La contraseña aleatoria queda en `.data/access-<usuario>.txt`, con permisos privados y fuera de Git. `admin` puede realizar sorteos y exportar; `staff` puede registrar personas, visitas y canjes. El usuario ingresa con su nombre; internamente es el correo `<usuario>@VITE_LOGIN_DOMAIN` en Supabase Auth.

## Funciones

- Cámara trasera y lectura QR con ZXing; ingreso manual del código o búsqueda por nombre, correo o empresa.
- Identificación exacta por hash SHA-256 del contenido del QR. No se guardan los enlaces ni tokens originales del badge.
- QR JSON con `name`, `email`, `company`, `job`: precarga esos campos, luego el equipo confirma el alta. Otros contenidos se usan solo como identificador, sin abrir URLs ni consultar sistemas de terceros.
- Una participación por PIT y persona durante todo el evento. Los reescaneos no inflan los puntos.
- Notas, interés, feedback opcional y autorización separada de contacto con Rooketh.
- Refuel con participación previa, verificación presencial de edad y sticker. Regla inicial: un canje por persona y día, usando fecha de Buenos Aires. Es una decisión operativa configurable en código; confirmar con el equipo antes del evento.
- Ranking de elegibles, sorteo ponderado con historial y exportación CSV protegida contra fórmulas.
- Resumen global y actividad del equipo; actualización periódica y manual.

## Regla del sorteo

Inscripción autorizada = 1 chance. Cada PIT distinto entre Race Control, Daytona, Knowledge, Merch y Photo Finish suma 1. Máximo 6. Refuel no suma. Merch no requiere compra: se registra participación. No se puede enviar un puntaje desde el navegador: se calcula en la base a partir de las visitas.

Participan solo quienes aceptaron el sorteo. Se excluyen ganadores anteriores del evento. Ejemplo: una persona con 4 PITs tiene 5 chances; otra recién registrada tiene 1. La primera tiene cinco veces el peso, no una victoria garantizada.

La función `draw_raffle` toma un bloqueo, obtiene la lista vigente en una transacción, sortea un entero uniforme con bytes de `pgcrypto` (muestreo por rechazo, sin sesgo de módulo), encuentra su intervalo ponderado y conserva padrón de IDs/pesos, ticket, ganador, premio, fecha y operador. Un UUID de solicitud impide un segundo sorteo cuando se reintenta la misma operación. El registro permite revisar la asignación; no es un sistema de sorteo públicamente verificable ni un registro resistente a cambios hechos por un administrador de la base.

## Pruebas

```sh
npm run check
npm run audit:deps
```

`npm test` ejecuta la migración real sobre un PostgreSQL en memoria (PGlite) y verifica permisos y reglas: `anon` no lee ni ejecuta nada, `staff` no sortea ni exporta, nadie escribe tablas directamente, puntaje máximo, un canje por día y sorteo idempotente. Los roles y `auth.uid()` de Supabase se simulan en la prueba; no reemplaza una verificación contra el proyecto real. La prueba de navegador anterior (`legacy/tests/browser.ts`) dependía de Express y todavía no fue portada.

## Despliegue en GitHub Pages

1. Subir el repositorio a GitHub con rama `main`. Verificar antes que `.data/` y `.env*` no estén incluidos.
2. En Settings → Pages, elegir **GitHub Actions** como fuente.
3. En Settings → Secrets and variables → Actions → Variables, crear `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` y, si se cambió, `VITE_LOGIN_DOMAIN`. Son valores públicos. La clave `service_role` no va en GitHub.
4. `.github/workflows/deploy.yml` ejecuta pruebas, compila y publica. Pages sirve por HTTPS, requisito para la cámara.

Extraer datos: exportación CSV desde la app (admin), Table Editor o SQL Editor de Supabase, o `pg_dump` con la cadena de conexión. El plan gratuito no incluye copias automáticas: respaldar antes y después de cada jornada.

## Límites que deben validarse en el evento

- Hace falta un badge real o formato autorizado de Ekoparty. Si el QR solo contiene un ID, no revela nombre ni correo. Si cambia por escaneo, se requiere adaptar la integración. No fusionamos personas automáticamente por correo para evitar mezclar identidades.
- Los registros manuales se recuperan por búsqueda; pedir el nombre antes de crear otro si alguien olvidó el badge.
- Versión online. Un error o desconexión no se presenta como guardado. No hay cola offline, galería de fotos ni sincronización en segundo plano.
- La cámara se probó con un flujo de vídeo sintético que pasa por el decodificador real; falta validación física en Safari/iPhone y Android con los badges y luz del evento.
- No almacena fotos, documentos de identidad ni la fecha de nacimiento. La verificación +18 la realiza el equipo.
- Definir fecha de eliminación de datos, aviso de privacidad, contacto para solicitudes y procedimiento de recuperación de cuentas antes de publicar. Autorización de participación y sorteo no equivalen a autorización comercial.

Consultar `SECURITY.md` para controles y riesgos residuales. No se afirma certificación OWASP ni auditoría externa.
