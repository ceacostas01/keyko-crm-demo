# apps/web

Frontend del CRM. React 19 + TypeScript + Vite. Consume `/api/v1` por el mismo
origen (Vite lo reenvía al backend en desarrollo).

```bash
pnpm dev        # desde la raíz: API local + web
pnpm test       # fechas, carriles, ventas, IA y prueba de humo con DOM
pnpm build
```

Abre `http://localhost:5173` y la URL **Network** que imprime Vite para el
celular. Credenciales: `demo@keyko.local` / `Demo1234!`.

Recursos de marca en `public/branding/` y manifiesto PWA en
`public/manifest.webmanifest`. No hay service worker: la app sigue necesitando
red.

Pantallas, sistema visual, decisiones y pendientes:
[`../../docs/web.md`](../../docs/web.md).
