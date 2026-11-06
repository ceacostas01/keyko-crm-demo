# API — backend

Hono + TypeScript sobre Cloudflare Workers, Turso (libSQL) y Drizzle.
Este documento describe **lo que existe y está probado hoy**, no lo planeado.

## Arranque local

```bash
pnpm install
pnpm test            # 370 pruebas (316 API + 54 web), base SQLite temporal
pnpm typecheck
pnpm demo            # API real por HTTP en :8787 con base temporal
pnpm db:status       # estado de migraciones (solo lectura)
```

`pnpm demo` crea una base en el directorio temporal del sistema, aplica las
migraciones con el runner real y siembra un negocio (`keyko`), un usuario y un
servicio. **No lee `.dev.vars` y no toca Turso.**

Credenciales de la demo: `demo@keyko.local` / `Demo1234!`.

## Principio: el CRM informa, el administrador decide

Keyko no tiene empleados: hay un único administrador por negocio. Por eso la
agenda **no bloquea** nada. Los solapamientos, los horarios fuera de lo
habitual y los días cerrados se devuelven como **advertencias**. El
administrador guarda igual.

Lo que sí se protege es el **doble envío de la misma operación** (doble clic,
reintento de red), con claves de idempotencia.

No existe matriz de roles. `memberships` sigue en el esquema y el login ya
resuelve varias membresías por usuario, así que añadir una segunda persona
mañana es insertar una fila. Lo que no hay es código que evalúe roles.

## Modelo de seguridad

- `business_id` se toma **solo** del JWT firmado (`bid`). El body, la query
  y los headers del cliente se ignoran aunque los envíen.
- Toda consulta filtra por `business_id`; un registro de otro negocio
  responde `404`, no `403`.
- `UPDATE`/`DELETE` llevan `business_id` en el `WHERE`.
- Contraseñas: PBKDF2-SHA256, 100 000 iteraciones, sal de 16 bytes. Se bajó
  desde 120 000 porque el Worker gratuito agotaba el CPU y rechazaba logins
  válidos; el límite de intentos compensa el costo menor.
- Token: JWT HS256, emisor `keyko-crm`, TTL 12 h, claims `sub`/`bid`/`role`.

### Límite de intentos de login

| Límite | Valor | Ventana |
|---|---|---|
| Por email | 5 fallos | 15 min |
| Por IP | 20 fallos | 15 min |

Se consulta **antes** de verificar la contraseña: un ataque no consume 100 000
iteraciones de PBKDF2 por intento. Al superar el límite: `429` + `Retry-After`,
incluso con la contraseña correcta. Un login exitoso limpia los fallos.

La IP sale de `cf-connecting-ip` (edge de Cloudflare, no falsificable);
`x-forwarded-for` solo en desarrollo. Un email inexistente verifica un hash de
relleno para no permitir enumerar cuentas por tiempo de respuesta.

### CORS

Lista blanca en `ALLOWED_ORIGINS`. Un origen fuera de la lista no recibe
`Access-Control-Allow-Origin`. Las peticiones sin `Origin` funcionan igual.

### Auditoría

`audit_log` guarda el delta, no la fila completa:

```json
{ "fullName": { "from": "Ana Pérez", "to": "Ana María Pérez" } }
```

Se auditan: login, altas, ediciones con cambios reales, borrados lógicos,
ajustes de inventario y creación, reprogramación, cancelación y reactivación
de citas. Guardar sin modificar nada no genera entrada. La escritura es
best-effort: si falla, se registra en el log del Worker.

## Endpoints

Base: `/api/v1`. Salvo `/auth/login`, todo exige `Authorization: Bearer <token>`.

### Autenticación

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/auth/login` | Email + contraseña + `businessSlug` opcional |
| GET | `/auth/me` | Identidad y negocio del token |

### Clientes

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/clients?search=&limit=&offset=` | Listado paginado |
| POST | `/clients` | Crea; normaliza el teléfono a E.164 |
| GET | `/clients/:id` | Detalle con sus mascotas |
| PATCH | `/clients/:id` | Edición parcial |
| DELETE | `/clients/:id` | Borrado lógico |

`POST` y `PATCH` comparan los dígitos del teléfono contra `phone` y contra
`whatsapp_contact_key` cuando parece un teléfono. Si ya existe una ficha con
ese número, responden `409 duplicate_client` aunque la ficha original haya
entrado por WhatsApp con un BSUID. La IA también busca por el teléfono real de
WhatsApp, no solo por la clave del contacto.

### Mascotas (entidad principal)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/pets?search=&species=&breed=&size=&clientId=&missing=&completeness=` | Búsqueda, filtros y completitud |
| POST | `/pets` | Valida que el cliente sea del mismo negocio |
| GET | `/pets/:id` | Ficha con propietario, tamaño y salud |
| GET | `/pets/:id/history` | Historial, estadísticas y citas |
| PATCH | `/pets/:id` | Edición parcial (incluye `profileFlags`) |
| DELETE | `/pets/:id` | Borrado lógico (conserva la foto) |
| DELETE | `/pets/:id/permanent` | Purga definitiva si ya está desactivada y sin historial |
| POST | `/pets/:id/photo` | Sube/reemplaza la foto (binario crudo) |
| DELETE | `/pets/:id/photo` | Quita la foto y borra el objeto |
| GET | `/photos/pets/:id?token=` | Sirve la foto privada (sin Bearer) |
| POST | `/photos/cleanup` | Borra objetos huérfanos del negocio |

`search` mira nombre, raza, temperamento, nombre del dueño y teléfono.
`size` se deriva del peso: `small` < 10 kg, `medium` 10–25 kg, `large` > 25 kg.
`missing` acepta `photo,breed,age,sizeOrWeight,sex` (lista separada por comas).
`completeness` acepta `under50`, `mid` (50–80) y `over80`.
`ageYears` guarda la edad declarada sin inventar `birthdate`. La UI ya no pide
fecha de nacimiento: pide número y unidad (meses o años) y convierte meses a
años. `birthdate` se conserva en la API por compatibilidad con datos viejos;
cualquiera de los
dos completa el campo de edad. Es lo que permite registrar “tiene 13 años” sin
fabricar una fecha de nacimiento.

`species` acepta únicamente `perro` y `gato`. El `CHECK` legado de Turso todavía
admite `otro` para no romper datos históricos, pero la API y la UI ya no lo
ofrecen ni lo crean.

**Fotos.** `POST /pets/:id/photo` recibe el binario con su `Content-Type`; el
servidor valida los bytes reales (JPEG/PNG/WebP), el tamaño
(`PHOTO_MAX_BYTES`) y guarda el objeto en R2 (o memoria en desarrollo). La
respuesta incluye `photoUrl` firmado (15 min) y la completitud recalculada.
`photo_url` se mantiene para fotos externas antiguas.

Al reemplazar una foto se sube primero el objeto nuevo y se guarda su clave; si
el `UPDATE` falla se borra el objeto recién subido. La foto anterior se elimina
solo después de que la nueva quedó guardada, de modo que Turso nunca apunta a
un objeto inexistente. `DELETE /pets/:id` es **borrado lógico** y conserva la
foto; `DELETE /pets/:id/permanent` exige que la mascota ya esté desactivada y
que no tenga citas, ventas, notas ni historial de salud, y solo entonces borra
el objeto de R2. `POST /photos/cleanup` elimina huérfanos del prefijo del negocio.

Cada fila incluye `clientName`, `clientPhone`, `size`, `sizeLabel` y
`completeness` (ver abajo).

### Completitud de perfil

Calculada siempre desde los datos, sin IA y sin almacenar porcentajes.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/stats/data-quality` | Resumen de calidad y listados de registros afectados |

`data-quality` devuelve los conteos y `details` con hasta 200 registros por
grupo (`contactsWithoutClient`, `clientsWithoutName`, `contactsWithoutPets`,
`petsWithoutPhoto`, `petsIncomplete`, `allPets`) para que React pueda abrir el
listado y navegar a la ficha o conversación.

`completeness` devuelve `percent`, `earned`, `applicable`, `fields` y las
listas `complete`, `missing`, `pending`, `unknown`, `notApplicable` y
`priorities`. Los campos se marcan con `PATCH /clients/:id` o `/pets/:id`
enviando `profileFlags: { unknown: [...], na: [...] }`; `na` sale del
denominador y solo se acepta en campos válidos: en mascotas
`breed,sizeOrWeight,age,sex,photo`; en clientes ninguno. `unknown` puede ser
cualquier campo (incluido el nombre) y sigue contando. Una sugerencia de IA
pendiente deja el campo en `pending` y no suma.

Al guardar un nombre válido (`PATCH /clients/:id` con `fullName`, o al aceptar
una sugerencia de IA), la marca `unknown` de `name` se retira automáticamente y
se registra `nameUnknown` en `audit_log`. Los campos `unknown` se muestran en la
interfaz bajo **Pendiente por confirmar**, separados de **No aplica**; siguen
contando en el denominador hasta confirmarse. Los listados de clientes, mascotas y conversaciones ya incluyen el
porcentaje, calculado en una sola carga de pendientes (sin N+1).

### Solicitudes de cita

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/appointment-requests?status=&contactKey=` | Solicitudes del negocio |
| PATCH | `/appointment-requests/:id` | Agenda, confirma, cancela o descarta |

Una solicitud nace de una sugerencia `appointment_request` y guarda servicio,
fecha/hora solicitadas, fecha resuelta (`startsAtLocal`), cliente, mascota,
contacto y vínculo opcional a una cita. `PATCH` con `status=scheduled` exige
`appointmentId`; al confirmar también se confirma la cita vinculada si seguía
programada. Los cruces no se rechazan: el editor de agenda muestra advertencias.

La creación automática solo ocurre si `AI_AUTO_CREATE_APPOINTMENT_REQUESTS=true`
y el contacto está en `AI_TEST_CONTACTS` (o la lista está vacía). La
confirmación automática está separada en `AI_AUTO_CONFIRM_APPOINTMENTS` y
permanece desactivada.

### Servicios y artículos

| Método | Ruta | Descripción |
|---|---|---|
| GET/POST | `/services` | Catálogo |
| GET/PATCH/DELETE | `/services/:id` | Detalle, edición, borrado lógico |
| GET/POST | `/products` | Catálogo; SKU único por negocio |
| GET/PATCH/DELETE | `/products/:id` | El stock no se toca por aquí |
| POST | `/products/:id/stock` | Ajuste `{delta, reason, refType?, refId?}` |

### Audios y transcripciones

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/conversations/:id/messages/:messageId/audio` | Descarga autenticada del audio, sin exponer la URL de Kapso |
| PATCH | `/conversations/:id/messages/:messageId/transcription` | Corrige manualmente la transcripción (auditado) |
| POST | `/conversations/:id/messages/:messageId/transcription/retry` | Reintenta una transcripción fallida |

La corrección recibe `{ "text": "..." }`. Guarda `manual_transcript` con
prioridad sobre el texto automático, audita `transcription.correct`, descarta
las sugerencias pendientes que citaban ese mensaje y vuelve a encolar su job.

### Ventas

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/sales?from=&to=&status=&petId=&clientId=` | Listado con cobros y mascotas |
| GET | `/sales/summary?from=&to=` | Ingresos, egresos y conteos del periodo |
| POST | `/sales` | Crea la venta (idempotente) |
| GET | `/sales/:id` | Detalle con líneas, pagos e historial |
| PATCH | `/sales/:id` | Corrige líneas y totales (idempotente) |
| POST | `/sales/:id/payments` | Abono o pago posterior |
| POST | `/sales/:id/refunds` | Devuelve dinero (movimiento negativo) |
| POST | `/sales/:id/returns` | Devuelve productos al inventario |
| POST | `/sales/:id/void` | Anula; devoluciones solo si se piden |

### Egresos

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/expenses?from=&to=&category=` | Lista egresos del negocio |
| POST | `/expenses` | Registra un egreso (idempotente) |
| PATCH | `/expenses/:id` | Edita categoría, detalle, monto o fecha |
| DELETE | `/expenses/:id` | Borrado lógico |

Categorías válidas: `luz`, `gas`, `agua`, `arriendo`, `personal`, `otro`.
El cuerpo de creación es:

```json
{
  "category": "luz",
  "reason": "Recibo de luz de octubre",
  "amountCents": 15000000,
  "incurredAt": "2026-11-02",
  "vendor": "Enel"
}
```

`reason` es el detalle obligatorio; `vendor` es opcional. `incurredAt` es una
fecha local (`YYYY-MM-DD`). El resumen de ventas añade `expensesCents` y
`expenseCount`; el frontend calcula el balance como ingresos netos menos
egresos. Hay aislamiento por negocio y auditoría `expense.create`,
`expense.update` y `expense.delete`.

Cuerpo de `POST /sales`:

```json
{
  "clientId": 1,
  "soldOn": "2026-10-20",
  "appointmentId": "…",
  "discountCents": 500000,
  "notes": "…",
  "items": [
    { "type": "service", "name": "Baño y peluquería", "petId": "…",
      "unitPriceCents": 5500000, "notes": "Sin secadora" },
    { "type": "product", "productId": "…", "qty": 2, "unitPriceCents": 3000000 }
  ],
  "payments": [{ "method": "nequi", "amountCents": 10000000 }]
}
```

Reglas: la venta puede registrarse **sin cliente y sin mascota**. El servicio
exige nombre y precio; la mascota de la línea es opcional. El artículo exige
`productId` y toma el precio del catálogo si no se envía. Si se envía una
mascota sin cliente, el cliente se deriva de la mascota. `soldOn` es el día
local de la venta (`YYYY-MM-DD`); si se omite, se usa hoy. Los pagos no pueden
superar el total; el stock se descuenta en la misma transacción y falla con
`409 insufficient_stock` si no alcanza.

### Corregir, anular, devolver

Son cuatro operaciones distintas:

| Operación | Endpoint | Qué mueve |
|---|---|---|
| Corregir | `PATCH /sales/:id` | Solo la diferencia de stock y los totales |
| Devolver producto | `POST /sales/:id/returns` | Stock + `returned_qty` |
| Devolver dinero | `POST /sales/:id/refunds` | `payments.kind = 'refund'` |
| Anular | `POST /sales/:id/void` | Estado `void`; nada más si no se pide |
| Eliminar | `DELETE /sales/:id` | Borra la venta, sus líneas y pagos; devuelve stock pendiente |

`PATCH` recibe `items` completo (con `id` para conservar líneas), `discountCents`
y `notes`. Subir una cantidad descuenta la diferencia; bajarla la devuelve;
quitar la línea devuelve lo pendiente. Nunca toca el dinero recibido: si el
total baja por debajo de lo cobrado queda `overpaidCents` y el reembolso se
registra aparte.

`POST /sales/:id/void` acepta:

```json
{
  "returnProducts": true,
  "refund": { "method": "cash", "amountCents": 5000000, "notes": "Cliente canceló" },
  "notes": "…"
}
```

Ambos campos son opcionales. Sin ellos, anular solo cambia el estado.

Estados de una venta: `open` (falta dinero), `paid` (cubierta), `void`
(anulada). `paidCents` es lo cobrado bruto, `refundedCents` lo devuelto,
`netPaidCents` la diferencia, `pendingCents` lo que falta y `overpaidCents` el
saldo a favor.

### Citas

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/appointments?from=&to=&groomerId=&status=&withConflicts=` | Agenda con advertencias |
| POST | `/appointments` | Crea; siempre `201` (nunca rechaza por solape) |
| GET | `/appointments/availability?date=&durationMin=&stepMin=` | Franjas sugeridas |
| GET | `/appointments/:id` | Detalle con advertencias |
| GET | `/appointments/:id/conflicts` | Cruces y minutos totales |
| PATCH | `/appointments/:id` | Mueve, cambia duración, estado o notas |
| DELETE | `/appointments/:id` | Cancela (idempotente) |
| POST | `/appointments/:id/reactivate` | Reactiva; body `{status?}` |

`startsAt` acepta `2026-11-02T10:00` (hora de Bogotá), ISO con `Z` o con
offset. Se guarda en UTC y se devuelve además en `startsAtLocal`.

`groomerId` es opcional y hoy nadie lo usa: no hay empleados.

### Conversaciones (solo lectura)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/conversations?status=` | Bandeja con cliente y último mensaje |
| GET | `/conversations/:id` | Historial de la conversación |

No existen endpoints de escritura. `raw_message_json` nunca sale en la
respuesta.

### IA (sugerencias)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/ai/process` | Procesa pendientes o un `contactKey` concreto (idempotente) |
| GET | `/ai/suggestions?status=` | Sugerencias extraídas |
| GET | `/ai/suggestions/:id` | Detalle con evidencia |
| POST | `/ai/suggestions/:id/accept` | Aplica (con correcciones opcionales) |
| POST | `/ai/suggestions/:id/reject` | Descarta |
| GET | `/ai/usage` | Llamadas, tokens, costo, errores, presupuestos, alertas y agregado mensual |
| POST | `/ai/prune` | Borra crudo/sugerencias antiguas y agrega consumo por mes |

No crea ni confirma citas, no crea ventas/pagos y no envía mensajes. Una
intención `appointment_request` puede crear una **solicitud pendiente** que se
agenda o confirma manualmente. Categorías: `service_inquiry` (precio o
servicio), `availability_inquiry` (cupo u horario) y `appointment_request`.
Detalle del diseño, cron, costos y retención: [`docs/ai.md`](ai.md).

### Auditoría (solo lectura)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/audit?entity=&action=&limit=&offset=` | Últimos cambios del negocio |

## Agenda: cómo se informa

### Advertencias

Crear o editar devuelve `warnings`. Ninguna es bloqueante.

```json
{
  "data": { "id": "…", "startsAtLocal": "2026-11-02T10:30:00", "…": "…" },
  "warnings": [
    {
      "type": "overlap",
      "severity": "warning",
      "message": "Se cruza 30 min con Nube de Ana Pérez (10:00–11:00).",
      "conflict": {
        "appointmentId": "…",
        "overlapMinutes": 30,
        "overlapStart": "2026-11-02T15:30:00.000Z",
        "overlapEnd": "2026-11-02T16:00:00.000Z",
        "startsAtLocal": "2026-11-02T10:00:00",
        "endsAtLocal": "2026-11-02T11:00:00",
        "petName": "Nube",
        "clientName": "Ana Pérez"
      }
    },
    {
      "type": "outside_business_hours",
      "severity": "warning",
      "message": "Fuera del horario habitual (08:00–18:00). Puedes guardarla igual."
    }
  ]
}
```

Tipos: `overlap`, `outside_business_hours`, `closed_day`.

`GET /appointments/:id/conflicts` devuelve lo mismo más
`totalOverlapMinutes`, para refrescar el panel sin recargar la cita.

El listado incluye `warnings` en cada fila (se puede desactivar con
`withConflicts=false` cuando no se necesita). Los cruces se calculan contra
una ventana de ±24 h del rango consultado, para no perder una cita que empieza
antes del día visible.

Una cita `cancelled` no genera advertencias de cruce.

### Disponibilidad orientativa

`GET /appointments/availability` sugiere franjas que caben en el horario de
atención y no chocan con otras citas. La respuesta se declara `advisory: true`
y trae `businessHours`, para que React pinte la rejilla. **No es una
restricción**: la API acepta cualquier hora, incluso domingo.

Horario actual: lunes a sábado, 08:00–18:00, `America/Bogota`. Son constantes
en `lib/agenda.ts` hasta que exista configuración por negocio.

### Idempotencia

Cabecera `Idempotency-Key` en `POST /appointments`, `PATCH /appointments/:id`
y `POST /appointments/:id/reactivate`.

- Primer envío: se procesa y se guarda su respuesta.
- Reenvío con la misma clave y mismos datos: devuelve la **misma** respuesta,
  con `Idempotency-Replayed: true`. No crea nada.
- Misma clave con otros datos: `409 idempotency_key_reuse`.
- Misma clave mientras la primera sigue en curso: `409
  idempotency_in_progress`; el cliente reintenta.
- Sin cabecera: cada envío es una operación distinta.

Las claves se guardan 24 h y se limpian de forma oportunista.

## Concurrencia

Lo que sigue siendo una carrera real y cómo se cierra:

**Duplicados de negocio.** El `SELECT` previo da un mensaje claro, pero la
garantía es el índice único: dos altas simultáneas con el mismo teléfono o SKU
devuelven `409`, no un `500`.

**Inventario.** La resta ocurre dentro del `UPDATE` (`stock = stock + delta`)
con `stock + delta >= 0`. Dos ventas simultáneas no se pisan ni venden de más.

**Citas.** Ya no hay carrera que cerrar: dos citas a la misma hora son
legítimas. Lo que se impide es duplicar *la misma* operación, y eso lo
resuelve la idempotencia con un `INSERT ... ON CONFLICT DO NOTHING` sobre la
clave.

## Cómo se prueba

Cada prueba construye una base nueva **aplicando las migraciones reales con el
runner de producción**.

| Archivo | # | Cubre |
|---|---|---|
| `schema.test.ts` | 11 | PKs heredadas, espejo Drizzle↔SQL, FK, unicidad por negocio |
| `migrations.test.ts` | 10 | Orden, checksums, reaplicación, archivo editado/borrado, rollback, baseline |
| `auth.test.ts` | 10 | Login, token inválido, PBKDF2, `/auth/me`, sin roles |
| `security.test.ts` | 10 | CORS, límite por email y por IP, `Retry-After` |
| `tenant.test.ts` | 12 | Aislamiento entre dos negocios, `business_id` inyectado |
| `crud.test.ts` | 23 | Clientes, mascotas, servicios, artículos, inventario, teléfono único |
| `client-matching.test.ts` | 1 | Ficha manual reconocida por teléfono de WhatsApp con BSUID |
| `appointments.test.ts` | 23 | Advertencias, cruces, ciclo de vida, disponibilidad, Bogotá↔UTC |
| `concurrency.test.ts` | 11 | Duplicados, stock e idempotencia de citas |
| `audit.test.ts` | 12 | Qué se registra, diff mínimo, no-op, aislamiento |
| `conversations.test.ts` | 11 | Materialización desde el webhook, BSUID, cliente, orden, aislamiento |
| `pets.test.ts` | 13 | Búsqueda por nombre/raza/dueño, filtros de especie y tamaño, homónimos |
| `completeness.test.ts` | 26 | Pesos, estados, N/A, pendientes, filtros, métricas separadas, BSUID y aislamiento |
| `photos.test.ts` | 14 | Validación real, almacenamiento, token privado, reemplazo, borrado lógico, purga y limpieza |
| `appointment-requests.test.ts` | 5 | Resolución de fechas, estados, cita vinculada, aislamiento y alta automática |
| `expenses.test.ts` | 8 | Categorías, detalle, fechas, resumen, edición, borrado, auditoría y aislamiento |
| `sales.test.ts` | 25 | Precio libre, mixtas, varias mascotas, stock, idempotencia, anulación, historial |
| `sale-edits.test.ts` | 18 | Corrección de ventas, diferencia de stock, devoluciones, reembolsos, reportes |
| `ai.test.ts` | 45 | Extracción, intenciones, contactos sin nombre, guardas anti-invención, verificador, visión, duplicados, overrides, fallos, presupuestos y retención |
| `ai-vision.test.ts` | 8 | Media de Kapso, descarga y validación de fotos, verificador determinista y llamada multimodal a OpenRouter |

## Conversaciones de WhatsApp

El webhook de producción escribe en `whatsapp_events` y `whatsapp_messages`,
nunca en `conversations`. En vez de tocarlo, la bandeja se **materializa** al
leer:

1. Un `SELECT DISTINCT contact_key` de los mensajes del negocio.
2. Insertar las conversaciones que falten.
3. Recalcular `last_message_at` con el último mensaje de cada contacto.
4. Asociar `client_id` comparando el teléfono normalizado.

Es idempotente y se ejecuta en cada `GET /conversations`. El `meta.sync`
devuelve cuántas se crearon y cuántos clientes se vincularon. **Nunca escribe
en las tablas del webhook.**

**Identidad del contacto.** En producción `contact_key` llega como BSUID
(`CO.DEMO0000000001`), no como teléfono. El teléfono real está en
`contact_phone`, así que la vinculación con clientes compara ambos: el
`wa_contact` y el `contact_phone` del último mensaje, normalizados a dígitos.

Cada conversación trae `contactName` (el que manda WhatsApp) para poder
mostrar algo aunque todavía no sea cliente.

## Ventas: decisiones

- **Servicios sin catálogo obligatorio.** El precio vive en la línea, no en
  `services`. El catálogo de servicios sigue existiendo para quien lo quiera,
  pero no condiciona la venta.
- **Precio congelado.** Cambiar el catálogo después no altera ventas pasadas.
- **Vendido ≠ cobrado.** `total_cents` es lo vendido; `payments` es el dinero
  recibido. El resumen devuelve `soldCents`, `collectedCents` y `pendingCents`.
- **Corregir ≠ anular.** Editar ajusta la diferencia de stock y recalcula; no
  mueve dinero. Anular solo cambia el estado. Devolver producto y devolver
  dinero son acciones explícitas e independientes.
- **Abonos.** Una venta admite varios pagos; queda `open` hasta cubrir el total.
- **Reembolsos.** Se guardan como `payments.kind = 'refund'`, nunca restando
  ni borrando el pago original. El historial conserva ambos movimientos.

## Pendientes conocidos

1. **La sincronización corre en cada lectura.** Correcto y simple para un
   negocio pequeño; si la bandeja se refresca cada pocos segundos, conviene
   moverla a un cron o a una cola.
2. **Sin revocación de sesiones.** La tabla `sessions` existe pero no se usa;
   un token vive 12 h.
3. **`wrangler dev` no se ejecutó** contra Turso a propósito: apuntaría a
   producción. El bundle sí se verificó con `wrangler deploy --dry-run`.
4. **Horario de atención fijo** en código, sin configuración por negocio.
5. **`appointment_items` sin endpoints.** Las citas aún no llevan servicios
   ni productos con precio.
6. **`assigned_to` y `groomer_id` existen pero no se usan**: no hay empleados.
7. **La auditoría no es transaccional con la mutación.** Un fallo entre ambas
   pierde una entrada de auditoría, nunca el dato.
