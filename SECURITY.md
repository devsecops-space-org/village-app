# Seguridad y calidad

Referencia: OWASP Top 10:2025 (https://top10.owasp.org/2025/). Es un marco de riesgos; esta implementación no implica certificación o cobertura total.

| Riesgo                   | Controles implementados                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 Acceso roto          | Tablas en el esquema `private`, no expuesto por la Data API, con RLS activo y sin políticas ni permisos para `anon`/`authenticated`. Todo acceso pasa por funciones que verifican sesión y rol; exportaciones/sorteos solo admin. |
| A02 Configuración        | CSP en meta tag del build (scripts y estilos solo propios, `connect-src` limitado al proyecto Supabase), sin registro público, funciones con `search_path` vacío. Sin cabeceras HTTP propias: GitHub Pages no las permite.        |
| A03 Cadena de suministro | Lockfile, npm ci, npm audit, acciones de GitHub fijadas por SHA y workflow con permisos mínimos.                                                                                                                                  |
| A04 Criptografía         | Contraseñas y sesiones a cargo de Supabase Auth. Badges identificados por SHA-256 calculado en el dispositivo. TLS de GitHub Pages y Supabase.                                                                                    |
| A05 Inyección            | Funciones con parámetros tipados, restricciones CHECK de longitud y caracteres de control, React escapa texto, no eval/HTML de visitantes, neutralización de fórmulas CSV.                                                        |
| A06 Diseño inseguro      | Puntajes derivados de visitas únicas en SQL, sorteo aleatorio en la base, transacciones, exclusión de ganadores, opt-in, edad/sticker/canje independientes.                                                                       |
| A07 Autenticación        | Sin alta pública; cuentas creadas con `service_role` desde una máquina de confianza; rol leído de `private.profiles`, nunca del JWT; límites de intentos de Supabase Auth; cierre local de sesión a las 12 h.                     |
| A08 Integridad           | Restricciones UNIQUE, sorteo atómico con bloqueo, request ID para reintentos, foto del padrón, día del canje calculado en la base.                                                                                                |
| A09 Registro             | Auditoría de ingresos, registros, visitas, canjes, notas, sorteos y exportaciones escrita solo por las funciones. Los intentos fallidos de acceso quedan en los logs de Supabase Auth, no en la app. Alertas externas pendientes. |
| A10 Excepciones          | Errores controlados con mensajes propios, rollback transaccional, validación antes de cambios, confirmaciones explícitas, fallo de red visible.                                                                                   |

## Amenazas y límites

- La URL del proyecto y la clave `anon` son públicas: están en el JavaScript. No protegen nada por sí mismas. La protección es que ninguna tabla es accesible y que cada función valida `auth.uid()` contra `private.profiles`. Un cambio que exponga el esquema `private`, agregue permisos o cree políticas abiertas rompe ese modelo; `npm test` cubre estos casos y debe pasar antes de cada despliegue.
- La clave `service_role` omite todos los controles. Solo se usa en la terminal de quien crea cuentas. No debe estar en el repositorio, en `.env.local`, en el build ni en GitHub Actions. Si se filtra, rotarla de inmediato.
- Supabase guarda el token de sesión en `localStorage`, legible por JavaScript (antes era una cookie HttpOnly). Por eso la CSP sin scripts inline ni orígenes externos es el control principal contra robo de sesión. El límite de 12 h se aplica en el cliente; el vencimiento real lo define la configuración de Auth del proyecto: acotarla y cerrar las sesiones al terminar el evento.
- La CSP por meta tag no admite `frame-ancestors` ni `Permissions-Policy`: el sitio en Pages puede ser embebido por otra página (riesgo de clickjacking) y no restringe permisos por cabecera. Un dominio propio detrás de un proxy/CDN que agregue cabeceras lo resuelve.
- Ya no hay límite de solicitudes ni bloqueo por cuenta propios. Dependemos de los límites de Supabase Auth; se puede activar CAPTCHA en el proyecto. Un usuario autenticado puede llamar a las funciones tantas veces como quiera.
- Se confía en el staff para verificar presencia, consentimiento, sticker y mayoría de edad. La app no verifica legitimidad del badge con Ekoparty ni impide presentar una copia del mismo.
- El QR nunca se abre ni se consulta: su contenido no sale del dispositivo, solo el hash.
- No se acepta puntuación suministrada por cliente. Las visitas y canjes se validan en la base incluso si se omite la UI. La validación con Zod en el navegador es solo para mensajes; la autoridad son las restricciones y funciones SQL.
- La base y la auditoría están en el mismo proyecto. Quien tenga acceso de administrador a Supabase puede alterarlas. No se promete inmutabilidad.
- Las credenciales iniciales quedan en `.data/access-<usuario>.txt` con permisos 0600. Entregarlas por un canal privado y retirar esa copia.
- No hay MFA, recuperación de contraseña por correo, política automática de retención ni alertas SIEM. Los datos personales quedan alojados en la región del proyecto Supabase: revisarla junto con el aviso de privacidad.
- La exportación contiene datos personales y está restringida al administrador. Rooketh requiere una autorización explícita adicional.
- No se implementó modo offline: los canjes/sorteos requieren una vista consistente de la base.
- Las pruebas simulan los roles de Supabase sobre PGlite. Falta repetir las comprobaciones negativas (clave `anon` sin sesión, usuario `staff`) contra el proyecto real.
