# Frontend — apps/web

React 19 + TypeScript + Vite. Sin librería de componentes: CSS propio con
tokens, pensado para usarse con el dedo.

## Cómo abrirlo

```bash
pnpm dev
```

Levanta dos procesos:

| Proceso | URL | Qué es |
|---|---|---|
| API | `http://localhost:8787` | Backend real sobre una base temporal |
| Web | `http://localhost:5173` | La aplicación |

Credenciales: `demo@keyko.local` / `Demo1234!`

### Desde el celular

1. Mac y celular en la misma red Wi-Fi.
2. `pnpm dev` imprime una línea **Network** con la IP de la Mac.
3. Abre esa URL (`http://192.168.x.x:5173`) en el navegador del celular.

Funciona sin configurar CORS porque Vite reenvía `/api` al backend: para el
navegador todo es el mismo origen. La API de demo escucha solo en `127.0.0.1`,
así que no queda expuesta a la red.

Si la Mac cambia de IP, reinicia `pnpm dev`.

## Qué hay

| Pantalla | Qué hace |
|---|---|
| **Login** | Correo y contraseña contra la API real |
| **Mascotas** (inicio) | Buscar, filtrar por datos faltantes/completitud y ver la calidad de datos |
| **Ficha de mascota** | Datos, dueño, observaciones, estadísticas, historial y citas |
| **Agenda · Día** | Rejilla horaria; toca un hueco para crear, toca una cita para editar |
| **Agenda · Semana** | Tablero de 7 columnas; toca el día para abrirlo |
| **Editor de cita** | Cliente, mascota, fecha, hora, duración, estado y notas; botón **Registrar venta** |
| **Ventas** | Filtros por fecha, ingresos, egresos y balance del periodo |
| **Nueva venta** | Servicios libres + artículos del catálogo, descuento y pago |
| **Editar venta** | Corrige líneas, precios, cantidades y descuentos |
| **Detalle de venta** | Conceptos, movimientos de dinero, historial y acciones |
| **Clientes** | Buscar, crear y abrir ficha (acceso secundario) |
| **Ficha de cliente** | Edición inline, mascotas, consentimiento, borrado lógico |
| **Catálogo** | Solo artículos físicos con stock |
| **Bandeja** | Conversaciones en solo lectura, estado de IA y procesamiento manual |
| **Sugerencias de IA** | Datos extraídos, cita del mensaje, aceptar/corregir/descartar |

La navegación principal es **Mascota → propietario**. Clientes sigue
existiendo y se llega desde la ficha de la mascota o desde el botón
«Clientes» del listado.

### Flujo desde el celular

Buscar mascota → abrir ficha → **Registrar venta** (o **Nueva cita**) →
guardar. La venta llega con la mascota y el propietario ya elegidos.

### Sugerencias de IA

- «Procesar mensajes» agrupa y analiza las conversaciones nuevas.
- En la conversación de la Bandeja, **Procesar con IA** analiza solo los
  mensajes nuevos de ese contacto. Muestra `IA · procesados/total`; cuando no
  quedan mensajes nuevos el botón cambia a **Procesada** y no se puede volver a
  disparar por accidente. Los fallos sí se pueden reintentar.
- Cada tarjeta muestra el campo, su confianza, la frase exacta y un enlace a la
  conversación de origen.
- Hay pestañas **Pendientes**, **Aplicadas** y **Descartadas**.
- **Aceptar** aplica; **Corregir** abre los valores antes de aplicar y los deja
  marcados como manuales; **Descartar** los ignora.
- Una solicitud de cita crea una **solicitud pendiente**, no una cita. Se agenda
  o confirma desde Agenda.
- Arriba se ve el gasto, los errores, el presupuesto y si el cron está activo.
- Si `AI_TEST_CONTACTS` tiene contactos, la pantalla indica “Solo pruebas”.

## Identidad visual

El rediseño usa el logo original de Keyko sin recrearlo. Los recursos viven en
`apps/web/public/branding/`:

| Archivo | Uso |
|---|---|
| `keyko-logo-original.jpeg` | Copia intacta del logo recibido |
| `keyko-logo.jpg` | Logo completo recortado para el login |
| `keyko-mark.png` | Marca cuadrada para barra lateral y topbar móvil |
| `favicon-32.png`, `favicon-64.png` | Favicon |
| `apple-touch-icon.png` | Icono para iOS |
| `icon-192.png`, `icon-512.png` | Iconos PWA |
| `icon-maskable-512.png` | Icono PWA con zona de seguridad |

`public/manifest.webmanifest` declara nombre, colores e iconos. **No hay service
worker ni funcionamiento offline**: la instalación como PWA queda preparada,
pero la app sigue necesitando red.

### Tokens

- **Color:** beige `--bg`, blanco cálido `--surface`, cielo pastel
  `--sky`/`--sky-soft`, azul interactivo `--accent`, verde suave `--ok` y
  ámbar `--warn`. Los textos usan `--ink`, `--ink-2` y `--muted` con contraste
  AA sobre las superficies claras.
- **Tipografía:** pila del sistema con Avenir Next / Segoe UI; títulos con
  `--font-display` y tracking negativo moderado.
- **Espaciado:** escala `--space-1` a `--space-16`.
- **Forma:** radios `--radius` (20 px), `--radius-sm` (12 px) y
  `--radius-xs` (8 px); sombras suaves `--shadow-1` y `--shadow-2`.
- **Componentes:** botones, campos, badges, tarjetas, listas, modales, toasts,
  estados vacíos y de carga comparten esos tokens.

### Puntos de revisión responsive

| Tamaño | Comportamiento |
|---|---|
| Escritorio (> 1100 px) | Barra lateral fija, contenido centrado |
| Tablet (900–1100 px) | Barra lateral compacta; debajo de 900 px pasa a navegación inferior |
| Celular (< 640 px) | Formularios a una columna, acciones a ancho completo, modales tipo hoja |

La navegación inferior muestra los seis destinos con objetivos táctiles de al
menos 44 px. Las tablas y listas conservan su comportamiento; los filtros
largos se desplazan horizontalmente y los formularios de fecha se apilan en
celular.

## Completitud de perfil

- Cada mascota muestra su porcentaje y su foto en el listado.
- Filtros rápidos: sin foto, sin raza, sin edad, sin peso, sin sexo, y tramos
  `<50 %`, `50–80 %`, `>80 %`.
- La edad se puede registrar como años (`ageYears`) sin inventar la fecha de
  nacimiento; cualquiera de los dos datos completa el campo.
- La ficha muestra barra de progreso y los campos que faltan como botones:
  al pulsarlos se abre el editor enfocado en ese campo.
- El teléfono de un cliente debe ser único en el negocio. Si ya existe una
  ficha con ese número, el formulario muestra el error y evita duplicarlo.
- En el listado de clientes y en su ficha hay un botón verde con el logo de
  WhatsApp. Abre la Bandeja filtrada por ese cliente (`/inbox?clientId=`), sin
  buscar manualmente la conversación.
- Desde una conversación, el botón **Cliente** abre su ficha. Desde la ficha,
  cada mascota tiene **Ver ficha**. La ficha de la mascota vuelve a la ficha del
  cliente y esta, si se llegó desde la Bandeja, vuelve a la Bandeja.
- La bandeja muestra el porcentaje del cliente (o del contacto) y qué falta.
- Arriba del listado hay un resumen de calidad de datos, separado de ventas y
  citas: contactos sin ficha, clientes sin nombre, contactos sin mascotas,
  mascotas sin foto, incompletas y completitud media.
- Cada indicador es un botón: al pulsarlo se despliega el listado de registros
  afectados. Los contactos abren su conversación en la Bandeja; clientes y
  mascotas abren su ficha. “Completitud media” muestra todas las mascotas
  ordenadas de menor a mayor porcentaje.
- La especie solo ofrece **Perro** y **Gato**; ya no hay opción “Otro”.
- La raza tiene autocompletado: al escribir se filtran las razas frecuentes y
  se puede seleccionar **Criollo/a** o escribir una raza nueva.
- La edad se pide como **número + unidad (Años o Meses)**. No se pide fecha de
  nacimiento en ningún formulario; internamente los meses se convierten a años
  (`6 meses` → `0.5`) y la ficha los vuelve a mostrar como meses.
- Si el cliente no tiene nombre completo, la lista y la ficha muestran el
  nombre de perfil de WhatsApp (`whatsapp_name`). El editor lo indica como
  “En WhatsApp aparece como …” para que la persona lo confirme.
- Fotos: se aceptan JPEG, PNG, WebP y HEIC/HEIF de hasta 30 MB de origen.
  HEIC/HEIF se convierte a JPEG en el navegador (`heic2any`, carga diferida)
  antes de comprimir y subir. Mientras se procesa la foto, el botón Guardar
  queda deshabilitado y se muestra “Procesando foto…”; así no se guarda la
  mascota sin la imagen.
- El frontend usa `/api` en el mismo origen en desarrollo. Para desplegarlo en
  un dominio distinto al de la API se compila con `VITE_API_BASE_URL`; las
  imágenes se resuelven con la misma base.
- La fotografía se toma con la cámara o se sube como archivo, tanto desde el
  editor de mascota como desde su ficha. Se comprime en el navegador
  (máx. 1600 px, JPEG), se muestra la vista previa y se guarda en R2. Ya no se
  pide una URL. Se puede reemplazar o quitar; el binario nunca se guarda en Turso.
- Un contacto sin nombre puede marcarse como “aún no sé el nombre” desde su
  ficha; el porcentaje no cambia, pero el estado pasa a `unknown`.
- Los campos `unknown` aparecen en una sección **Pendiente por confirmar**
  (tanto en la ficha del cliente como en la de la mascota), separada de
  **No aplica**. Ahí se puede abrir el editor para confirmarlos o
  quitar la marca. Al guardar un nombre válido (o aceptar el nombre sugerido
  por la IA), la marca se retira sola y queda auditoría.
- Desactivar una mascota conserva su foto. La eliminación definitiva (API
  `DELETE /pets/:id/permanent`) solo procede si ya está desactivada y sin
  historial; en ese caso sí se borra el objeto de R2.

### Ventas

- El resumen muestra **Ingresos**, **Egresos**, **Balance** y número de ventas.
  Los ingresos son el dinero cobrado menos devoluciones del periodo.
- La pestaña **Egresos** registra pagos de luz, gas, agua, arriendo, personal u
  otro, con detalle libre, monto, fecha y beneficiario opcional.
- Los egresos se pueden editar y eliminar; se suman al resumen por fecha.
- La venta puede asociarse a un **cliente**, a una **mascota**, a ambos o a
  ninguno. Si eliges una mascota, su propietario se completa solo.
- La fecha de la venta viene con el día actual y se puede cambiar (solo día).
- **Qué se hizo** es un desplegable con Solo baño, Solo peluquería, Baño y
  peluquería, Corte de uñas, Guardería y **Otro** para escribir un servicio
  libre.
- Los servicios llevan precio; la mascota es opcional dentro de la línea.
- Los artículos salen del catálogo, con cantidad y precio editable.
- Se puede cobrar todo, dejar un abono o guardar como pendiente.
- **Editar** recalcula totales y solo mueve la diferencia de stock.
- Cada fila de venta tiene acciones propias: **Editar** (lápiz) y **Eliminar**
  (basura). Tocar la fila entra al detalle de esa transacción.
- **Eliminar** borra definitivamente la venta, sus pagos y devoluciones, y
  devuelve al inventario el stock de productos pendiente. Pide confirmación.
- **Anular** no devuelve nada por sí solo: el diálogo deja marcar si se
  devuelven artículos y si se devuelve dinero.
- **Devolver productos** y **Devolver dinero** son botones independientes.
- El historial de la venta muestra cada corrección, pago y devolución.
- El total se muestra fijo abajo mientras se edita.

### Agenda

- Arriba aparece **Solicitudes de cita** detectadas por IA, con el servicio,
  la fecha/hora resuelta y los botones **Agendar** y **Descartar**.
- **Agendar** abre el editor existente con cliente, mascota, fecha y notas
  precargados. Los cruces solo generan advertencias.
- La rejilla se adapta a las citas del día (empieza una hora antes de la
  primera y termina con la última), entre 06:00 y 23:00.
- Las citas que se cruzan se dibujan **en columnas paralelas**, no una encima
  de otra.
- Un icono de aviso marca las citas con cruces u horarios raros. El texto
  completo aparece en el `title` (escritorio) y en el editor.
- Crear o mover una cita **nunca se bloquea**. Si se cruza, se avisa en el
  editor mientras escribes y otra vez al guardar, con el número de avisos.
- Al guardar, la agenda salta al día de la cita, aunque la hayas movido lejos.
- Cada apertura del editor genera una `Idempotency-Key`: un doble toque en
  Guardar no duplica la cita.

### Bandeja de WhatsApp

- Las notas de voz muestran un reproductor (descargado por la API, sin exponer
  la URL privada), duración, estado de transcripción y el texto transcrito.
- Si la transcripción falla, se muestra el error y el botón **Reintentar**.
- **Corregir transcripción** guarda una corrección manual auditada y vuelve a
  dejar el mensaje pendiente para IA; las sugerencias antiguas que citaban esa
  transcripción se descartan para no duplicar.
- La etiqueta **IA** indica que el audio pasó por el procesamiento automático.

Solo lectura, a propósito. Muestra el historial con burbujas de entrada y
salida, el nombre del contacto, su teléfono y si ya tiene ficha de cliente.
La materialización de `conversations` la hace la API al leer; no hay ningún
envío de mensajes ni conexión con IA.

## Decisiones

- **Proxy en lugar de CORS** para desarrollo: una sola URL, funciona igual en
  el celular, y el backend no necesita orígenes extra.
- **Token en `localStorage`** con cierre de sesión automático ante un `401`.
- **Sin gestor de estado global**: cada pantalla pide lo que necesita con un
  hook `useAsync` (carga, error, recarga). Para este tamaño es suficiente.
- **Sin framework de UI**: ~20 KB de CSS propio con tokens. Los objetivos
  táctiles son de 44 px y los modales se convierten en hoja inferior en móvil.
- **Pesos en COP en la interfaz, centavos en la API**: la conversión vive en
  `lib/format.ts`.

## Pruebas

```bash
pnpm --filter @keyko/web test
```

- `lib/date.test.ts` — fechas de la agenda, semanas que empiezan en lunes,
  cambios de mes y año.
- `lib/agenda.test.ts` — reparto en carriles y cálculo de cruces en minutos.
- `app.test.tsx` — prueba de humo con DOM real (jsdom): login, error de
  credenciales, mascotas como pantalla inicial, filtro por especie, agenda con
  avisos, vista semanal y el editor guardando con `Idempotency-Key`.

Las pruebas de la interfaz usan `fetch` simulado; la conexión real se verificó
con el backend levantado y llamadas HTTP a través del proxy de Vite.

## Pendientes

1. **Sin tiempo real**: si llega un mensaje mientras la bandeja está abierta,
   hay que pulsar Actualizar.
2. **Sin instalación como app** (PWA) ni funcionamiento sin conexión.
3. **Cambiar la fecha en el editor a un día fuera del rango cargado** no
   muestra avisos en vivo (el servidor sí los devuelve al guardar).
4. **Sin pantalla de ajustes**: horario de atención y datos del negocio están
   fijos en el backend.
5. **No desplegado.** Falta decidir hosting y aplicar las migraciones en Turso.
   El build incluye `public/_redirects` para que las rutas profundas de React
   Router funcionen en Cloudflare Pages.
