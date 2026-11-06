# apps/api

Worker del CRM. REST `/api/v1`. Hono + Drizzle + libSQL.

Estado: **CRM + ventas + extracción con IA, probado en local** (204 pruebas).
Sin desplegar.

```bash
pnpm test       # base SQLite temporal migrada con el runner real
pnpm typecheck
pnpm demo       # API real por HTTP en :8787, base temporal, no toca Turso
```

La agenda no rechaza citas por solapamiento: informa con `warnings`. La
idempotencia protege contra dobles envíos.
La IA extrae datos de WhatsApp y genera sugerencias revisables; nunca crea
citas, ventas ni pagos. En desarrollo usa el proveedor `fake` (sin red ni costo).
Un administrador por negocio: autenticación y aislamiento sí, matriz de roles no.
Diseño de IA: [`../../docs/ai.md`](../../docs/ai.md).

Endpoints, seguridad y pendientes: [`../../docs/api.md`](../../docs/api.md).
Las migraciones están en `../../migrations/`.
