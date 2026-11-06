# Modelo de datos — Keyko CRM

Versión borrador. **Pendiente de validar contra el esquema real de producción** (`clients`, `whatsapp_events`, `whatsapp_messages`).

## Convenciones

| Tema | Decisión |
|---|---|
| Multiempresa | `business_id TEXT NOT NULL` en toda tabla de negocio; únicos compuestos `(business_id, ...)` |
| Zona horaria | `America/Bogota` en `businesses.timezone`; timestamps en UTC ISO-8601 |
| Dinero | `INTEGER` en centavos. **Precios finales**, sin desglose de impuestos |
| Borrado | Lógico: `deleted_at TEXT NULL`. Nunca `DELETE` físico |
| IDs | `TEXT` (ULID) generados en la app |
| Estados | `CHECK (col IN (...))`, sin ENUM |
| Auditoría | `created_at`, `updated_at`, `created_by` en tablas editables |

## 1. Tenancy y personal

### `businesses`
`id`, `name`, `slug` (único), `timezone` (`America/Bogota`), `currency` (`COP`), `status`, `created_at`

### `users`
`id`, `email` (único), `name`, `password_hash`, `status`, `last_login_at`, `created_at`

### `memberships`
`id`, `business_id`, `user_id`, `role` (`owner|admin|groomer|receptionist`), `active`
Único: `(business_id, user_id)`

### `sessions`
`id`, `user_id`, `business_id`, `expires_at`, `ip`, `user_agent`, `created_at`

### `audit_log`
`id`, `business_id`, `actor_id`, `action`, `entity`, `entity_id`, `diff_json`, `created_at`

## 2. Clientes

### `clients` *(existente — se extiende)*
| Columna | Tipo | Nota |
|---|---|---|
| `id` | TEXT | existente |
| `business_id` | TEXT | **nuevo**, default al negocio Keyko |
| `full_name` | TEXT | |
| `phone_e164` | TEXT | normalizado, único por negocio |
| `email` | TEXT NULL | |
| `notes` | TEXT NULL | "más información" libre |
| `extra_json` | TEXT NULL | campos personalizados (JSON validado) |
| `source` | TEXT | `whatsapp`, `manual`, `referido` |
| `consent_marketing` | INTEGER | 0/1 |
| `created_at`, `updated_at`, `deleted_at` | TEXT | |

Único: `(business_id, phone_e164)`

## 3. Mascotas

### `pets`
`id`, `business_id`, `client_id`, `name`, `species` (`perro|gato`; el CHECK legado todavía admite `otro`, pero la API y la UI solo aceptan dos), `breed`, `sex`, `birthdate`, `weight_kg`, `allergies`, `temperament`, `photo_url`, `active`, `created_at`, `updated_at`, `deleted_at`

### `pet_health_records`
`id`, `business_id`, `pet_id`, `type` (`vaccine|allergy|condition|note`), `description`, `occurred_at`, `vet_name`, `next_due_at`, `created_at`

### `pet_notes`
`id`, `business_id`, `pet_id`, `appointment_id NULL`, `author_id`, `body`, `created_at`

## 4. Catálogo

### `services` — alta manual desde el CRM
`id`, `business_id`, `name`, `category`, `duration_min`, `price_cents` (final), `active`, `created_at`, `updated_at`, `deleted_at`

### `products`
`id`, `business_id`, `sku`, `name`, `price_cents` (final), `cost_cents`, `stock`, `min_stock`, `active`, `created_at`, `updated_at`, `deleted_at`

### `stock_movements`
`id`, `business_id`, `product_id`, `delta`, `reason`, `ref_type`, `ref_id`, `created_at`

## 5. Agenda y ventas

### `appointments`
`id`, `business_id`, `client_id`, `pet_id`, `groomer_id`, `starts_at`, `ends_at`, `status` (`scheduled|confirmed|in_progress|done|no_show|cancelled`), `notes`, `created_by`, `created_at`, `updated_at`
Índice: `(business_id, starts_at)`

> La cita nace en `scheduled`. **Nada la pasa a `confirmed` automáticamente.**

### `appointment_items`
`id`, `business_id`, `appointment_id`, `item_type` (`service|product`), `item_id`, `qty`, `unit_price_cents`, `total_cents`

### `sales`
`id`, `business_id`, `client_id`, `appointment_id NULL`, `status` (`open|paid|void`), `total_cents`, `paid_at`, `created_by`, `created_at`

### `sale_items`
`id`, `business_id`, `sale_id`, `item_type`, `item_id`, `qty`, `unit_price_cents`, `total_cents`

### `payments`
`id`, `business_id`, `sale_id`, `method` (`cash|card|transfer|nequi|daviplata`), `amount_cents`, `reference`, `paid_at`

## 6. Finanzas

### `expenses` — motivo escrito por el usuario
`id`, `business_id`, `category`, `reason` (texto libre obligatorio), `amount_cents`, `incurred_at`, `vendor NULL`, `receipt_url NULL`, `created_by`, `created_at`, `deleted_at`

### `cash_sessions`
`id`, `business_id`, `opened_by`, `opened_at`, `closed_at`, `opening_cents`, `closing_cents`

### `cash_movements`
`id`, `business_id`, `cash_session_id`, `type` (`in|out`), `amount_cents`, `reason`, `created_at`

## 7. WhatsApp

### `conversations`
`id`, `business_id`, `client_id NULL`, `wa_contact`, `status`, `last_message_at`, `assigned_to NULL`

### `whatsapp_messages` *(existente — se extiende)*
`+ business_id`, `conversation_id`, `direction` (`in|out`), `type`, `body`, `media_url`, `wa_message_id`, `status`, `sent_at`

### `whatsapp_events` *(existente — se extiende)*
`+ business_id`, `event_type`, `processed_at`, `process_status`, `idempotency_key`
Único: `(business_id, idempotency_key)` — evita duplicados por reintentos de Kapso.

## 8. IA

### `ai_extractions`
`id`, `business_id`, `source_type` (`message|appointment|manual`), `source_id`, `model`, `prompt_version`, `raw_response`, `parsed_json`, `confidence`, `status` (`pending|validated|rejected|applied`), `target_entity`, `target_id`, `reviewed_by`, `reviewed_at`, `created_at`

### `ai_usage`
`id`, `business_id`, `extraction_id`, `model`, `tokens_in`, `tokens_out`, `cost_usd_micros`, `latency_ms`, `created_at`

## Flujo de la IA

```
WhatsApp → webhook → whatsapp_events (+idempotencia) → Queue
        → ai-worker → OpenRouter → Zod → ai_extractions(pending)
        → bandeja de revisión → persona aprueba → applied
```

Reglas:
- La IA **nunca** escribe en `clients`, `pets` ni `appointments`.
- Toda respuesta pasa por Zod antes de guardarse.
- Cada llamada registra tokens y costo en `ai_usage`.

## Pendiente de confirmar en producción

Ver el esquema de producción (documento privado). Resumen:

1. `clients` ya tiene `business_id TEXT DEFAULT 'keyko'` e `id INTEGER`.
2. `whatsapp_events` y `whatsapp_messages` no tienen `business_id`.
3. No existe tabla de conversaciones ni cola de Cloudflare.
4. Volumen actual: 0 clientes, 4 eventos, 2 mensajes.


## Ventas (migración `0005`)

No se crearon tablas nuevas: se reutilizan `sales`, `sale_items` y `payments`,
que ya existían. Se extendieron así:

| Tabla | Cambio | Motivo |
|---|---|---|
| `sales` | `subtotal_cents`, `discount_cents`, `notes` | separar valor vendido, descuento y notas |
| `sale_items` | `item_id` pasa a opcional | los servicios se escriben a mano, sin catálogo |
| `sale_items` | `name`, `pet_id`, `appointment_id`, `discount_cents`, `notes`, `created_at` | descripción congelada, mascota, cita y observaciones |
| `payments` | CHECK ampliado con `other` | medio de pago «otro» |
| índices | por cliente, estado, mascota y venta | consultas de historial y caja |

`sale_items` y `payments` se reconstruyeron (copiar, borrar, renombrar) porque
SQLite no permite relajar un `NOT NULL` ni ampliar un `CHECK`. Los datos
existentes se conservan y hay una prueba que lo verifica.

### Reglas

- **Servicios**: texto libre + precio de esa venta. No tocan el catálogo ni
  fijan tarifas futuras. `item_id` queda `NULL` y `name` guarda lo escrito.
- **Artículos**: salen del catálogo, pero el precio unitario se congela en la
  línea. Cambiar el catálogo después no altera la venta.
- **Varias mascotas**: cada línea de servicio lleva su `pet_id`; una venta
  puede mezclar mascotas. El cliente se deriva de la mascota si no se envía.
- **Artículos sin mascota**: `pet_id` es opcional en las líneas de producto.
- **Dinero**: `subtotal = Σ líneas`, `total = subtotal − descuento`.
- **Cobrado vs vendido**: `payments` guarda dinero real. `sales.total_cents`
  es lo vendido. `sale.status` es `open` hasta que los pagos cubren el total.
- **Anulación**: `status = 'void'` y devolución del stock de los artículos con
  su movimiento inverso. No hay borrado físico.
- **Historial por mascota**: se deriva de `sale_items` + `sales` + `appointments`
  + `pet_health_records` + `pet_notes`. El descuento de la venta se reparte
  proporcionalmente entre las líneas para que la suma por mascota cuadre.

## Correcciones y devoluciones (migración `0006`)

Sin tablas nuevas: dos columnas y un índice.

| Tabla | Cambio | Motivo |
|---|---|---|
| `payments` | `kind` (`payment` \| `refund`), `notes` | un movimiento puede entrar o salir |
| `sale_items` | `returned_qty` | saber cuántas unidades ya volvieron al stock |

Reglas:

- **Corregir** una venta reemplaza sus líneas y ajusta solo la diferencia de
  inventario. Si el total baja por debajo de lo cobrado, queda saldo a favor;
  no se devuelve dinero automáticamente.
- **Anular** cambia el estado a `void` y saca la venta de los ingresos. No
  devuelve stock ni dinero salvo que se pida explícitamente en el mismo body.
- **Devolver producto** suma stock y `returned_qty`; no se puede devolver más
  de lo vendido ni repetir la misma unidad.
- **Devolver dinero** inserta un pago con `kind = 'refund'`. Nunca se edita ni
  se borra el pago original.
- La caja se calcula como `pagos − reembolsos`; lo vendido se mide con
  `sales.total_cents`.

## IA (migración `0007`)

| Tabla | Para qué |
|---|---|
| `ai_jobs` | lote de mensajes por contacto, estado e intentos |
| `ai_processed_messages` | un mensaje se procesa una sola vez |
| `field_overrides` | campos editados a mano que la IA no puede pisar |

Se reutilizan `ai_extractions` (sugerencias, con `parsed_json`) y `ai_usage`
(tokens y costo). Una detección `appointment_request` se materializa en
`appointment_requests` como solicitud pendiente; **no** crea ni confirma una
fila en `appointments` sin una acción humana.

## Completitud de perfil (migración `0009`)

Dos columnas, sin tablas nuevas:

| Tabla | Columna | Para qué |
|---|---|---|
| `clients` | `profile_flags_json` | `{ unknown: [...], na: [...] }` |
| `pets` | `profile_flags_json` | igual |

El porcentaje no se guarda: se calcula al leer con los pesos de
`packages/domain/src/completeness.ts`. `na` excluye el campo del denominador;
`unknown` lo deja en el denominador pero sin puntos. Las sugerencias de IA
pendientes no suman.

## Fotos y métricas de IA (migración `0010`)

| Tabla | Cambio |
|---|---|
| `pets` | `photo_key`, `photo_meta_json` (el binario vive en R2) |
| `ai_usage` | `error` para registrar fallos sin costo |
| `ai_usage_monthly` | agregado por negocio, mes y modelo |

`photo_url` se conserva para fotos externas. El acceso a R2 es privado: la API
firma un token corto por negocio y el objeto solo se entrega si pertenece a ese
negocio. Los objetos se borran al reemplazar o quitar la foto, y
`POST /photos/cleanup` elimina los huérfanos del prefijo del negocio.


## Edad y solicitudes de cita (migración `0011`)

| Tabla | Cambio |
|---|---|
| `pets` | `age_years` (edad declarada; la UI solo pide número + meses/años; `birthdate` queda por compatibilidad) |
| `appointment_requests` | solicitud detectada, con estados y vínculo a cita |

`appointment_requests` guarda `extraction_id` (único por negocio), cliente,
mascota, contacto, servicio, fecha/hora solicitadas, `starts_at_local` resuelto,
confianza, estado, notas y `appointment_id`. Estados: `pending`, `scheduled`,
`confirmed`, `cancelled`, `discarded`. La confirmación manual puede confirmar
la cita vinculada; la automática está desactivada.
