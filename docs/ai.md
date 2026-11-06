# IA: extracción de conversaciones

## Flujo

```
WhatsApp → Kapso → Worker webhook (sin cambios) → Turso
        → cron del Worker API cada 2 min (o procesamiento manual)
        → ai_jobs (lote por contacto)
        → OpenRouter (o proveedor `fake` en desarrollo)
        → Zod
        → reglas deterministas
        → verificador de candidatos (texto)
        → clasificador de fotos (visión)
        → ai_extractions + appointment_requests → React → persona revisa
```

El webhook de producción **no se toca**. El procesador lee `whatsapp_messages`,
igual que la bandeja.

## Por qué no una llamada por mensaje

`enqueueAiJobs` agrupa los mensajes no procesados por contacto en lotes de
hasta 20. Una conversación de seis mensajes cuesta una llamada, no seis. En
producción la cola añade un retardo corto (debounce) para juntar los mensajes
seguidos de una misma persona.

## Idempotencia y reintentos

| Mecanismo | Dónde |
|---|---|
| Un mensaje se procesa una sola vez | `ai_processed_messages` (PK `message_id`) |
| Un lote no se procesa dos veces a la vez | `UPDATE ... WHERE status IN ('pending','failed')` |
| Dos cron/manual no crean el mismo lote | id determinista SHA-256 + PK de `ai_jobs` |
| Reintentos con tope | `ai_jobs.attempts < AI_MAX_ATTEMPTS` |
| Mensajes que ya están en un lote pendiente no se reencolan | `enqueueAiJobs` |
| Sugerencias repetidas no se duplican | firma `kind + destino + campos` |

`ai_processed_messages` es el cursor real: se inserta **después** de que el
lote terminó bien. Un mensaje ya registrado no vuelve a entrar en
`enqueueAiJobs`, ni por cron ni por el botón manual. Si el proveedor falla, no
se marca como procesado y el siguiente intento lo recoge; eso es reintento, no
reprocesamiento. La Bandeja muestra `IA · procesados/total` y el botón cambia a
**Procesada** cuando no quedan mensajes nuevos.

Si el proveedor falla, el lote vuelve a `pending` y **no** se marcan los
mensajes como procesados: el siguiente intento los recoge.

## Contrato del modelo

`extractionSchema` (Zod) valida:

- `client`: nombre, teléfono, notas.
- `pets[]`: nombre, especie, raza, sexo, nacimiento, peso, alergias, observaciones.
- `conversation`: servicio, intención de cita, fecha, hora, preguntas, notas.

Cada campo es `{ value, confidence, evidence[] }`. Si no hay evidencia, el
campo no se envía. El prompt prohíbe inventar y prohíbe convertir fechas
relativas.

## Procesamiento automático

El Worker API tiene un cron `*/2 * * * *`. En cada ejecución:

1. Lee `whatsapp_messages` desde `ai_processed_messages` y `AI_STARTED_AT`.
2. Si `AI_TEST_CONTACTS` no está vacío, solo encola esos contactos.
3. Agrupa hasta 20 mensajes consecutivos por contacto.
4. Llama a OpenRouter con el lote y las guardas.
5. Registra `ai_processed_messages`; un mensaje no se procesa dos veces.

`AI_AUTO_PROCESS=true` enciende el cron; `AI_ENABLED=false` lo apaga por
completo. Para habilitar todos los contactos, vacía `AI_TEST_CONTACTS` y
redespliega. El cron no toca el webhook ni depende de que el computador esté
encendido.

`POST /ai/process` sigue disponible para reprocesar manualmente una
conversación con `{ "contactKey": "..." }`, sin activar el historial masivo.

## Clasificación de intención

| Categoría | Cuándo |
|---|---|
| `appointment_request` | pide cita explícitamente (“quiero agendar”, “reservar”) |
| `availability_inquiry` | pregunta por cupo, horario o disponibilidad |
| `service_inquiry` | pregunta precio o por un servicio, sin pedir cita |
| `other` | cualquier otra cosa |

`appointment_request` puede crear una **solicitud pendiente** en
`appointment_requests`; no crea ni confirma la cita. La fecha relativa se
resuelve con el timestamp de los mensajes (por ejemplo, “mañana” desde el 2 de
noviembre es el 3 de noviembre), no con la fecha del procesador. Si falta certeza,
la fecha queda nula y se revisa a mano. Una pregunta de precio **no** genera una
solicitud de cita.

## Solicitudes de cita y agendamiento

| Estado | Significado |
|---|---|
| `pending` | Detectada; falta que una persona la agende |
| `scheduled` | Vinculada a una cita concreta |
| `confirmed` | Confirmada explícitamente |
| `cancelled` | Cancelada |
| `discarded` | Descartada por revisión |

`AI_AUTO_CREATE_PETS=true` crea la mascota cuando el cliente ya existe, el
nombre tiene confianza ≥ 0.9, la especie está presente y no hay otra mascota
con ese nombre en el cliente. Además exige que la evidencia del nombre o de la
especie mencione explícitamente perro/gato/mascota: “Se llama Hydra” después
de hablar de una crema no crea una mascota. No crea clientes ni toca
auto-aplicación general. Solo actúa para contactos autorizados.

### Verificación antes de crear mascotas

`AI_VERIFY_PET_CANDIDATES=true` añade una segunda llamada corta al modelo
justo antes de crear una mascota sin revisión. El verificador recibe el nombre
candidato, la especie y la conversación, y responde si el nombre corresponde
realmente a una mascota. Rechaza productos, personas, marcas, servicios y
casos ambiguos. Solo se crea si el verificador y las reglas deterministas
coinciden; si no, queda como sugerencia. La llamada se registra en `ai_usage`.

### Clasificación de fotos con visión

`AI_VISION_ENABLED=true` activa la compuerta de imágenes:

1. El mensaje debe ser una foto con URL de un host permitido
   (`app.kapso.ai`, `lookaside.fbsbx.com`, `*.whatsapp.net`).
2. Se descarga y se valida por los primeros bytes (JPEG, PNG o WebP), con tope
   `AI_VISION_MAX_IMAGE_BYTES` (4 MB por defecto).
3. Se envía a `AI_VISION_MODEL` (por defecto `openai/gpt-4o-mini`) con una
   pregunta cerrada: perro, gato, otro animal, persona, producto, documento u
   otro.
4. Si hay foto y la clasificación **no** confirma un animal, no se crea ninguna
   mascota automáticamente. Queda la sugerencia para revisión humana.

La clasificación solo se ejecuta si el lote propone mascotas y solo para la
primera foto del lote. Se pide `detail: low` al modelo: basta para distinguir
un animal de un producto y baja el costo medido a **~3 050 tokens de entrada y
USD 0.00047 por foto**. Si la visión está apagada o falla, la creación
automática de mascotas con foto queda bloqueada; el resto del procesamiento
continúa.

`AI_AUTO_CREATE_APPOINTMENT_REQUESTS=true` crea solicitudes pendientes solo
para contactos autorizados. `AI_AUTO_CONFIRM_APPOINTMENTS=false` impide que el
modelo confirme solo: la confirmación se hace desde Agenda. Los cruces no se
rechazan; el editor muestra advertencias y la persona decide. Todo cambio de
solicitud queda en `audit_log`.

## Reglas deterministas

1. **Cliente**: se busca por `whatsapp_contact_key` o por teléfono (solo si la
   clave parece un teléfono; un BSUID como `CO.2744…` no cuenta).
2. **Mascota**: se busca por nombre normalizado **dentro del cliente**. Dos
   clientes pueden tener una mascota con el mismo nombre.
3. **Nombre de WhatsApp**: se guarda en `clients.whatsapp_name`. Si la
   conversación no da un nombre, se usa como respaldo al crear la ficha. Nunca
   pisa un nombre confirmado y se descartan teléfonos o marcadores genéricos.
4. **Campo vacío** → se sugiere completarlo.
5. **Campo con valor distinto** → sugerencia marcada como contradicción; nunca
   se sobrescribe.
6. **Campo editado a mano** (`field_overrides`) → se ignora por completo.
7. **Menciones repetidas** en un lote → una sola mascota.
8. **Citas** → se crea una solicitud pendiente; la cita real y su confirmación son acciones humanas.
9. **Contacto sin nombre** → se crea igual, identificado por WhatsApp; el
   nombre de perfil queda como `whatsapp_name` y la ficha se muestra con él
   mientras no haya un nombre completo confirmado.
10. **Guardas anti-invención**: teléfonos deducidos del BSUID, sexo por
    artículo, peso/raza/fecha sin respaldo → se descartan.
11. **Razas**: “criollita”, “criolla” o “mestiza” se normalizan a
    **Criollo/a** en la sugerencia.
12. **Edad**: “6 meses” se guarda como `0.5` años y se muestra como
    “6 meses”. No se rechaza el lote por una edad fraccionaria.

## Audios de WhatsApp

Las notas de voz se transcriben antes de la extracción, dentro del mismo
pipeline de `ai_jobs`.

- Kapso entrega la URL del audio en `raw_message_json`, igual que las fotos.
- Se validan hosts permitidos, tamaño máximo (`AI_TRANSCRIPTION_MAX_BYTES`) y
  formato real por los primeros bytes: OGG/Opus, MP3, WAV, M4A, WebM y FLAC.
- No se guarda el binario en Turso ni se depende de R2. Se descarga en memoria
  y se envía a OpenRouter como base64.
- Modelo: `openai/gpt-4o-mini-transcribe`, idioma `es`. Es más preciso que
  Whisper Turbo en español; en la prueba real costó ~6.8 veces más, pero en
  términos absolutos sigue siendo muy económico (~USD 0.00065 por 30 s).
- La transcripción se guarda en `message_transcriptions`, con estados
  `pending`, `processing`, `completed` y `failed`, intentos, costo, latencia y
  duración.
- `manual_transcript` es una corrección humana y tiene prioridad sobre el texto
  automático. La corrección queda en `audit_log` con `transcription.correct`.
- El mensaje original nunca se borra si falla la transcripción.
- Antes de extraer, el cuerpo del mensaje de audio se reemplaza por la
  transcripción y se marca como `audio transcrito` en el prompt. La evidencia
  sigue apuntando al `message_id` original.
- Un audio ya transcrito se reutiliza. Un reintento no vuelve a llamar al
  modelo. Los fallos tienen reintentos limitados y espera progresiva.
- Si se alcanza el presupuesto, el lote queda pendiente y no se pierde.

### Retención

`AI_TRANSCRIPTION_RETENTION_DAYS` (180 por defecto) borra el texto de las
transcripciones antiguas y conserva la fila, el estado, el modelo y el costo.
Las extracciones aplicadas y su auditoría no se tocan.

### Límites actuales de latencia

El cron revisa cada 2 minutos. La transcripción y la extracción de un audio
corto toman unos 10 segundos cuando OpenRouter responde normalmente, pero el
tiempo total desde que llega el mensaje depende de la siguiente ejecución del
cron (0–120 s). Para 10–20 s end-to-end haría falta disparar el job desde el
webhook o añadir una cola/evento; no se modificó el webhook.

## Presupuesto y alertas

Dos límites independientes, en micro-dólares:

| Variable | Default |
|---|---|
| `AI_DAILY_BUDGET_USD_MICROS` | `100000` ($0.10) |
| `AI_MONTHLY_BUDGET_USD_MICROS` | `5000000` ($5.00) |

Al llegar al 80 % y al 100 % se registra una fila en `ai_alerts` (una por
umbral y periodo) y se emite un `console.warn`. Al alcanzar cualquiera de los
dos límites, los lotes se saltan con `reason: budget_daily` o
`budget_monthly`. `GET /ai/usage` devuelve ambos saldos y las alertas.

## Retención de datos

Por defecto **no se guarda la respuesta cruda del modelo**
(`AI_STORE_RAW_RESPONSE=false`). Se conservan:

- `ai_extractions.parsed_json`: la sugerencia estructurada;
- la evidencia (`evidence` con ids de mensajes y citas textuales);
- `ai_usage`: tokens, costo y latencia.

Si se activa la depuración (`AI_STORE_RAW_RESPONSE=true`), se guardan como
máximo 4000 caracteres y se borran pasados `AI_RAW_RETENTION_DAYS` (7 por
defecto). La limpieza corre al procesar y también con `POST /ai/prune`.

Las sugerencias ya revisadas (aplicadas, rechazadas o validadas) se borran
pasados `AI_SUGGESTION_RETENTION_DAYS` (180 por defecto).

El detalle de `ai_usage` se conserva `AI_USAGE_RETENTION_DAYS` (180). Antes de
borrarlo se agrega por mes y modelo en `ai_usage_monthly`: llamadas, errores,
tokens, costo y latencia media, sin contenido ni datos personales. Los fallos
del proveedor también se registran (tokens 0, costo 0, campo `error`). La
auditoría permanente de cambios aplicados (`audit_log`, acción `ai.apply`) no
se toca. Antes de borrarlas,
al aceptarlas se descartan las citas textuales y se conservan solo los ids de
los mensajes. El rastro de lo que cambió la IA queda en `audit_log` con la
acción `ai.apply`, que no se purga.

## Auto-aplicación

Desactivada por defecto (`AI_AUTO_APPLY=false`). Si se activa, solo aplica:

- cliente nuevo con nombre ≥ 0.9 de confianza,
- mascota nueva con nombre ≥ 0.9,
- campos vacíos con confianza ≥ 0.9.

Nunca aplica contradicciones, citas, ventas, pagos ni borrados.

## Costos

| Variable | Default | Para qué |
|---|---|---|
| `AI_ENABLED` | `true` | apagado de emergencia |
| `AI_PROVIDER` | `fake` | `fake` no gasta; `openrouter` usa red |
| `AI_MODEL` | `openai/gpt-4o-mini` | modelo |
| `AI_MAX_OUTPUT_TOKENS` | `1600` | tope por llamada |
| `AI_MAX_ATTEMPTS` | `3` | reintentos |
| `AI_DAILY_BUDGET_USD_MICROS` | `100000` ($0.10) | tope diario |
| `AI_INPUT_PRICE_PER_MTOK` | `0.15` | cálculo de costo |
| `AI_OUTPUT_PRICE_PER_MTOK` | `0.60` | cálculo de costo |
| `AI_AUTO_APPLY` | `false` | autonomía general |
| `AI_AUTO_CREATE_PETS` | `false` | crea mascotas nuevas de clientes existentes |
| `AI_VERIFY_PET_CANDIDATES` | `true` | segunda opinión del modelo antes de crear mascotas |
| `AI_VISION_ENABLED` | `false` | clasifica fotos antes de crear mascotas |
| `AI_VISION_MODEL` | `openai/gpt-4o-mini` | modelo multimodal |
| `AI_VISION_MAX_IMAGE_BYTES` | `4000000` | tope de descarga de la foto |
| `AI_TRANSCRIPTION_ENABLED` | `true` | transcribir notas de voz |
| `AI_TRANSCRIPTION_MODEL` | `openai/gpt-4o-mini-transcribe` | modelo STT |
| `AI_TRANSCRIPTION_LANGUAGE` | `es` | idioma preferente |
| `AI_TRANSCRIPTION_MAX_BYTES` | `20000000` | tope del audio |
| `AI_TRANSCRIPTION_MAX_SECONDS` | `300` | duración máxima |
| `AI_TRANSCRIPTION_TIMEOUT_MS` | `45000` | timeout de la llamada |
| `AI_TRANSCRIPTION_MAX_ATTEMPTS` | `3` | reintentos |
| `AI_TRANSCRIPTION_RETENTION_DAYS` | `180` | retención del texto |
| `AI_AUTO_PROCESS` | `true` | cron de mensajes nuevos |
| `AI_AUTO_CREATE_APPOINTMENT_REQUESTS` | `false` | solicitudes pendientes automáticas |
| `AI_AUTO_CONFIRM_APPOINTMENTS` | `false` | confirmación automática (no habilitada) |
| `AI_TEST_CONTACTS` | vacío | lista de contactos permitidos; vacío = todos |
| `AI_STARTED_AT` | vacío | no procesar historial anterior |

Cada llamada deja una fila en `ai_usage` con tokens y costo: extracción,
verificador y visión. La visión consume unos 3 050 tokens de entrada
por foto (~USD 0.00047 con `detail: low`) y solo corre cuando hay foto,
candidatos a mascota y creación automática habilitada. El verificador consume
~250 tokens de entrada (~USD 0.00006). Si el gasto del día alcanza el presupuesto, los lotes se saltan con
`reason: budget` y tampoco se ejecutan verificador ni visión.

## Procesamiento actual

El cron del Worker API cada 2 minutos consulta Turso, agrupa mensajes y llama a
`processAiJobs`. No hay cola externa ni cambio en el webhook. `ai_jobs.attempts`
limita reintentos y `ai_processed_messages` es el cursor. Si OpenRouter falla,
el webhook y la recepción de WhatsApp no se ven afectados.

Para una cola dedicada en el futuro se puede añadir un consumidor que llame al
mismo `processAiJobs`; no es necesario para esta fase.

## Evaluación

`pnpm --filter @keyko/api ai:eval` compara **73 conversaciones ficticias**
contra resultados esperados y reporta precisión/recall por campo, intención,
falsos positivos, duplicados, descartes de guardas, costo y latencia.
La evaluación interna no se incluye en esta copia pública.

## Privacidad

- Desarrollo y pruebas usan **conversaciones ficticias**.
- El proveedor `fake` no hace red.
- Antes de activar OpenRouter con clientes reales hay que decidir retención y
  consentimiento; `raw_response` guarda la salida del modelo, no el prompt
  completo, pero conviene revisarlo.
