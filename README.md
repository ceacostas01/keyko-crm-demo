# Keyko CRM — demo

Demo funcional de un CRM para peluquería de mascotas: clientes, mascotas, agenda,
ventas, egresos, catálogo, bandeja de WhatsApp e IA para extraer información de
conversaciones y notas de voz.

Este repositorio es una **copia pública de demostración**. No contiene datos de
clientes, credenciales, URLs de producción ni configuración privada de
infraestructura.

![Arquitectura de Keyko CRM](docs/assets/architecture.svg)

## Flujo de un mensaje

```mermaid
sequenceDiagram
    autonumber
    participant C as Cliente
    participant K as Kapso
    participant W as Worker API
    participant T as Turso
    participant O as OpenRouter
    participant R as React CRM

    C->>K: Texto, audio o foto por WhatsApp
    K->>T: Webhook guarda el mensaje
    W->>T: Cron lee mensajes nuevos
    W->>O: Transcribe audios
    W->>O: Clasifica fotos
    W->>O: Extrae datos con GPT-4o-mini
    W->>T: Guarda sugerencias y auditoría
    R->>T: Muestra bandeja, fichas y agenda
    R-->>C: La persona revisa y decide
```

## Herramientas

![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=111827)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Hono](https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![Turso](https://img.shields.io/badge/Turso-libSQL-4FF8D2?logo=turso&logoColor=111827)
![Drizzle](https://img.shields.io/badge/Drizzle-ORM-C5F74F?logo=drizzle&logoColor=111827)
![OpenRouter](https://img.shields.io/badge/OpenRouter-IA-6C5CE7)
![Vitest](https://img.shields.io/badge/Vitest-6E9F18?logo=vitest&logoColor=white)

## Demo local

```bash
pnpm install
pnpm dev
```

- Web: `http://localhost:5173`
- API local: según la salida de `pnpm dev`
- Credenciales de la demo: `demo@keyko.local` / `Demo1234!`

La demo usa una base SQLite temporal con datos ficticios. No toca Turso,
Cloudflare, WhatsApp ni servicios reales.

## Qué incluye

- React + TypeScript + Vite.
- API con Hono para Cloudflare Workers.
- Esquema y migraciones SQL.
- Pruebas de API y frontend.
- Datos ficticios de demostración.
- Integración de IA preparada para configurarse con secretos propios.
- Procesamiento de texto, audios y fotos con revisión humana.

## Configuración

Copia `.env.example` a `.dev.vars` y llena tus propios valores locales.
No subas `.dev.vars` a Git.

Para desplegar en tu propia infraestructura, usa
`apps/api/wrangler.toml.example` como plantilla y configura tus secretos con
`wrangler secret put`.

## Licencia

Este repositorio se comparte como demostración técnica. No incluye datos reales
de Keyko ni de sus clientes.
