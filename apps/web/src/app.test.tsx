// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { AuthProvider } from './auth';
import { ToastProvider } from './components/ui';
import { today, weekdayShort } from './lib/date';

/**
 * Prueba de humo de la interfaz con la API simulada.
 *
 * No sustituye mirar la pantalla, pero garantiza que la app monta, que el
 * login funciona y que la agenda pinta citas con sus avisos. Si un import o
 * un hook se rompe, esto falla antes de abrir el navegador.
 */

type Route = { status?: number; body: unknown };

const TODAY = today();

let calls: string[] = [];
let bodies: Array<{ path: string; body: unknown; headers: Record<string, string> }> = [];
let routes: Record<string, Route> = {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);

    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });

    if (typeof init?.body === 'string') {
      bodies.push({ path, body: JSON.parse(init.body), headers });
    }

    const key = `${method} ${path.split('?')[0]}`;
    const route = routes[key];
    if (route) return json(route.body, route.status ?? 200);

    return json({ error: { code: 'not_found', message: `sin mock: ${key}` } }, 404);
  });
}

function renderApp(initial = '/') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const business = {
  id: 'keyko',
  name: 'Keyko Pet Grooming',
  slug: 'keyko',
  timezone: 'America/Bogota',
  currency: 'COP',
};

const owner = { id: 'user-1', email: 'demo@keyko.local', name: 'Demo Keyko' };

beforeEach(() => {
  localStorage.clear();
  calls = [];
  bodies = [];
  routes = {};
  mockFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('login', () => {
  it('muestra el formulario con los datos de la demo', () => {
    renderApp('/login');

    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeTruthy();
    expect(screen.getByDisplayValue('demo@keyko.local')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeTruthy();
  });

  it('muestra el error cuando las credenciales fallan', async () => {
    routes['POST /api/v1/auth/login'] = {
      status: 401,
      body: { error: { code: 'unauthorized', message: 'Credenciales inválidas' } },
    };

    renderApp('/login');
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    await waitFor(() => {
      expect(screen.getByText('Credenciales inválidas')).toBeTruthy();
    });
  });
});

describe('agenda', () => {
  beforeEach(() => {
    localStorage.setItem('keyko.token', 'token-de-prueba');

    routes['GET /api/v1/auth/me'] = {
      body: { user: owner, business, role: 'owner' },
    };
    routes['GET /api/v1/clients'] = {
      body: {
        data: [
          {
            id: 1,
            businessId: 'keyko',
            phone: '+573001112233',
            whatsappContactKey: '+573001112233',
            fullName: 'Ana Pérez',
            email: null,
            notes: null,
            source: 'manual',
            consentMarketing: 0,
            extra: null,
            createdAt: '',
            updatedAt: '',
            deletedAt: null,
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
    routes['GET /api/v1/pets'] = {
      body: {
        data: [
          {
            id: 'pet-luna',
            businessId: 'keyko',
            clientId: 1,
            name: 'Luna',
            species: 'gato',
            breed: 'Siamés',
            sex: 'hembra',
            birthdate: null,
            weightKg: 4.2,
            allergies: null,
            temperament: null,
            photoUrl: null,
            active: 1,
            deletedAt: null,
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
    routes['GET /api/v1/appointments'] = {
      body: {
        data: [
          {
            id: 'appt-1',
            businessId: 'keyko',
            clientId: 1,
            petId: 'pet-luna',
            groomerId: null,
            startsAt: '2026-11-02T15:00:00.000Z',
            endsAt: '2026-11-02T16:00:00.000Z',
            startsAtLocal: `${TODAY}T10:00:00`,
            endsAtLocal: `${TODAY}T11:00:00`,
            status: 'scheduled',
            notes: null,
            createdAt: '',
            updatedAt: '',
            warnings: [
              {
                type: 'overlap',
                severity: 'warning',
                message: 'Se cruza 30 min con Toby de Carlos Ruiz.',
              },
            ],
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
  });

  it('pinta la cita con su aviso de cruce', async () => {
    renderApp('/agenda');

    await waitFor(() => {
      expect(screen.getByText(/Luna/)).toBeTruthy();
    });

    expect(screen.getByRole('button', { name: /Nueva cita/ })).toBeTruthy();
    // La cita tiene un aviso: se marca como conflicto y muestra el icono.
    const block = screen.getByText(/Luna/).closest('button');
    expect(block?.className).toContain('is-conflict');
  });

  it('permite cambiar a la vista semanal', async () => {
    renderApp('/agenda');

    await waitFor(() => expect(screen.getByText(/Luna/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Semana' }));

    await waitFor(() => {
      expect(screen.getAllByText(weekdayShort(TODAY)).length).toBeGreaterThan(0);
    });
  });

  it('la sesión sin token redirige al login', async () => {
    localStorage.clear();
    renderApp('/');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Entrar' })).toBeTruthy();
    });
  });
});

describe('editor de citas', () => {
  const appointment = {
    id: 'appt-1',
    businessId: 'keyko',
    clientId: 1,
    petId: 'pet-luna',
    groomerId: null,
    startsAt: `${TODAY}T15:00:00.000Z`,
    endsAt: `${TODAY}T16:00:00.000Z`,
    startsAtLocal: `${TODAY}T10:00:00`,
    endsAtLocal: `${TODAY}T11:00:00`,
    status: 'scheduled',
    notes: null,
    createdAt: '',
    updatedAt: '',
    warnings: [],
  };

  beforeEach(() => {
    localStorage.setItem('keyko.token', 'token-de-prueba');
    routes['GET /api/v1/auth/me'] = {
      body: { user: owner, business, role: 'owner' },
    };
    routes['GET /api/v1/clients'] = {
      body: {
        data: [
          {
            id: 1,
            businessId: 'keyko',
            phone: '+573001112233',
            whatsappContactKey: '+573001112233',
            fullName: 'Ana Pérez',
            email: null,
            notes: null,
            source: 'manual',
            consentMarketing: 0,
            extra: null,
            createdAt: '',
            updatedAt: '',
            deletedAt: null,
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
    routes['GET /api/v1/pets'] = {
      body: {
        data: [
          {
            id: 'pet-luna',
            businessId: 'keyko',
            clientId: 1,
            name: 'Luna',
            species: 'gato',
            breed: null,
            sex: null,
            birthdate: null,
            weightKg: null,
            allergies: null,
            temperament: null,
            photoUrl: null,
            active: 1,
            deletedAt: null,
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
    routes['GET /api/v1/appointments'] = {
      body: {
        data: [
          appointment,
          {
            ...appointment,
            id: 'appt-2',
            petId: 'pet-luna',
            startsAtLocal: `${TODAY}T10:30:00`,
            endsAtLocal: `${TODAY}T11:30:00`,
          },
        ],
        pagination: { limit: 100, offset: 0, count: 2 },
      },
    };
    routes['PATCH /api/v1/appointments/appt-1'] = {
      body: {
        data: { ...appointment, endsAtLocal: `${TODAY}T11:30:00` },
        warnings: [
          {
            type: 'overlap',
            severity: 'warning',
            message: 'Se cruza 30 min.',
          },
        ],
      },
    };
  });

  it('abre la cita, muestra el cruce y guarda con la nueva duración', async () => {
    renderApp('/agenda');

    await waitFor(() => expect(screen.getAllByText(/Luna/).length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByText(/Luna/)[0]!.closest('button')!);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Editar cita' })).toBeTruthy();
    });

    // Aviso en vivo: la otra cita del día se cruza.
    expect(screen.getByText(/Se cruza 30 min con/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '1 h 30 min' }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    // El aviso del servidor se muestra en el toast, no bloquea el guardado.
    await waitFor(() => {
      expect(screen.getByText(/Cita actualizada\. Tiene 1 aviso/)).toBeTruthy();
    });

    const patch = bodies.find((item) => item.path === '/api/v1/appointments/appt-1');
    expect(patch).toBeDefined();
    expect((patch?.body as { durationMin: number }).durationMin).toBe(90);
    expect(patch?.headers['idempotency-key']).toBeTruthy();
  });

  it('crear una cita envía la fecha y hora elegidas', async () => {
    routes['POST /api/v1/appointments'] = {
      body: { data: appointment, warnings: [] },
    };

    renderApp('/agenda');
    await waitFor(() => expect(screen.getAllByText(/Luna/).length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /Nueva cita/ }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Nueva cita' })).toBeTruthy();
    });

    // El cliente se elige y la mascota única se selecciona sola.
    fireEvent.change(screen.getAllByRole('combobox')[0]!, {
      target: { value: '1' },
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Guardar' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    await waitFor(() => {
      const post = bodies.find((item) => item.path === '/api/v1/appointments');
      expect(post).toBeDefined();
      const payload = post?.body as { startsAt: string; petId: string };
      expect(payload.petId).toBe('pet-luna');
      expect(payload.startsAt).toContain(TODAY);
    });
  });
});

describe('mascotas como pantalla principal', () => {
  const petRow = {
    id: 'pet-luna',
    businessId: 'keyko',
    clientId: 1,
    name: 'Luna',
    species: 'gato',
    breed: 'Siamés',
    sex: 'hembra',
    birthdate: null,
    weightKg: 4.2,
    allergies: 'Pollo',
    temperament: null,
    photoUrl: null,
    active: 1,
    deletedAt: null,
    size: 'small',
    sizeLabel: 'Pequeño',
    clientName: 'Ana Pérez',
    clientPhone: '+573001112233',
  };

  beforeEach(() => {
    localStorage.setItem('keyko.token', 'token-de-prueba');
    routes['GET /api/v1/auth/me'] = {
      body: { user: owner, business, role: 'owner' },
    };
    routes['GET /api/v1/clients'] = {
      body: {
        data: [
          {
            id: 1,
            businessId: 'keyko',
            phone: '+573001112233',
            whatsappContactKey: '+573001112233',
            fullName: 'Ana Pérez',
            email: null,
            notes: null,
            source: 'manual',
            consentMarketing: 0,
            extra: null,
            createdAt: '',
            updatedAt: '',
            deletedAt: null,
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
    routes['GET /api/v1/pets'] = {
      body: { data: [petRow], pagination: { limit: 100, offset: 0, count: 1 } },
    };
  });

  it('abre en Mascotas y muestra el propietario', async () => {
    renderApp('/');

    await waitFor(() => expect(screen.getByText('Luna')).toBeTruthy());
    expect(screen.getAllByText(/Ana Pérez/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Siamés/)).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: 'Mascotas' }).length).toBeGreaterThan(0);
  });

  it('filtra por especie contra la API', async () => {
    renderApp('/');
    await waitFor(() => expect(screen.getByText('Luna')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Gato' }));

    await waitFor(() => {
      expect(
        calls.some((call) => call.includes('/pets?') && call.includes('species=gato')),
      ).toBe(true);
    });
  });

  it('muestra el vacío cuando no hay mascotas', async () => {
    routes['GET /api/v1/pets'] = {
      body: { data: [], pagination: { limit: 100, offset: 0, count: 0 } },
    };

    renderApp('/');
    await waitFor(() => {
      expect(screen.getByText('Todavía no hay mascotas')).toBeTruthy();
    });
  });
});

describe('nueva venta', () => {
  beforeEach(() => {
    localStorage.setItem('keyko.token', 'token-de-prueba');
    routes['GET /api/v1/auth/me'] = {
      body: { user: owner, business, role: 'owner' },
    };
    routes['GET /api/v1/clients'] = {
      body: {
        data: [
          {
            id: 1,
            businessId: 'keyko',
            phone: '+573001112233',
            whatsappContactKey: '+573001112233',
            fullName: 'Ana Pérez',
            email: null,
            notes: null,
            source: 'manual',
            consentMarketing: 0,
            extra: null,
            createdAt: '',
            updatedAt: '',
            deletedAt: null,
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
    routes['GET /api/v1/pets'] = {
      body: {
        data: [
          {
            id: 'pet-luna',
            businessId: 'keyko',
            clientId: 1,
            name: 'Luna',
            species: 'gato',
            breed: null,
            sex: null,
            birthdate: null,
            weightKg: null,
            allergies: null,
            temperament: null,
            photoUrl: null,
            active: 1,
            deletedAt: null,
            size: null,
            sizeLabel: null,
            clientName: 'Ana Pérez',
            clientPhone: '+573001112233',
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
    routes['GET /api/v1/products'] = {
      body: { data: [], pagination: { limit: 100, offset: 0, count: 0 } },
    };
    routes['POST /api/v1/sales'] = {
      body: { data: { id: 'sale-1' } },
    };
    routes['GET /api/v1/sales/sale-1'] = {
      body: {
        data: {
          id: 'sale-1',
          clientId: 1,
          appointmentId: null,
          status: 'paid',
          subtotalCents: 5500000,
          discountCents: 0,
          totalCents: 5500000,
          notes: null,
          paidAt: null,
          createdAt: '2026-11-02 10:00:00',
          paidCents: 5500000,
          pendingCents: 0,
          client: { id: 1, name: 'Ana Pérez', phone: '+573001112233' },
          items: [],
          payments: [],
        },
      },
    };
  });

  it('registra un servicio con precio libre desde la mascota', async () => {
    renderApp('/sales/new?petId=pet-luna&clientId=1');

    await waitFor(() => {
      expect(screen.getAllByRole('heading', { name: 'Nueva venta' }).length).toBeGreaterThan(0);
    });

    // El cliente llega desde la ficha de la mascota.
    await waitFor(() => {
      const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
      expect(select.value).toBe('1');
    });

    const serviceSelect = screen
      .getAllByRole('combobox')
      .find((select) =>
        Array.from((select as HTMLSelectElement).options).some(
          (option) => option.value === 'Baño y peluquería',
        ),
      ) as HTMLSelectElement;
    fireEvent.change(serviceSelect, {
      target: { value: 'Baño y peluquería' },
    });
    fireEvent.change(screen.getByPlaceholderText('55.000'), {
      target: { value: '55.000' },
    });

    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: 'Guardar venta' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Guardar venta' }));

    await waitFor(() => {
      const post = bodies.find((item) => item.path === '/api/v1/sales');
      expect(post).toBeDefined();
      const payload = post?.body as {
        clientId: number;
        items: Array<{ type: string; name: string; petId: string; unitPriceCents: number }>;
        payments: Array<{ method: string; amountCents: number }>;
      };
      expect(payload.clientId).toBe(1);
      expect(payload.items[0]).toMatchObject({
        type: 'service',
        name: 'Baño y peluquería',
        petId: 'pet-luna',
        unitPriceCents: 5_500_000,
      });
      expect(payload.payments[0]?.amountCents).toBe(5_500_000);
      expect(post?.headers['idempotency-key']).toBeTruthy();
    });
  });
});

describe('ventas y egresos', () => {
  beforeEach(() => {
    localStorage.setItem('keyko.token', 'token-de-prueba');
    routes['GET /api/v1/auth/me'] = {
      body: { user: owner, business, role: 'owner' },
    };
    routes['GET /api/v1/sales'] = {
      body: { data: [], pagination: { limit: 100, offset: 0, count: 0 } },
    };
    routes['GET /api/v1/sales/summary'] = {
      body: {
        data: {
          from: null,
          to: null,
          salesCount: 3,
          soldCents: 25_000_000,
          collectedCents: 20_000_000,
          refundedCents: 0,
          netCollectedCents: 20_000_000,
          pendingCents: 5_000_000,
          servicesCents: 15_000_000,
          servicesCount: 4,
          productsCents: 10_000_000,
          productsCount: 3,
          expensesCents: 15_000_000,
          expenseCount: 1,
        },
      },
    };
    routes['GET /api/v1/expenses'] = {
      body: {
        data: [
          {
            id: 'exp-1',
            businessId: 'keyko',
            category: 'luz',
            reason: 'Recibo de luz de octubre',
            amountCents: 15_000_000,
            incurredAt: '2026-11-02',
            vendor: 'Enel',
            createdBy: 'user-1',
            createdAt: '2026-11-02 10:00:00',
            deletedAt: null,
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
  });

  it('muestra ingresos, egresos y balance, y permite abrir los egresos', async () => {
    renderApp('/sales');

    await waitFor(() => expect(screen.getByText('Ingresos')).toBeTruthy());
    expect(screen.getByText('Balance')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('$ 200.000')).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: 'Egresos' }));

    await waitFor(() =>
      expect(screen.getByText('Recibo de luz de octubre')).toBeTruthy(),
    );
    expect(screen.getByText('Luz · Enel')).toBeTruthy();
    expect(screen.getByText('-$ 150.000')).toBeTruthy();
  });

  it('cada venta tiene sus acciones de editar y eliminar', async () => {
    routes['GET /api/v1/sales'] = {
      body: {
        data: [
          {
            id: 'sale-1',
            clientId: 5,
            appointmentId: null,
            status: 'paid',
            subtotalCents: 5_000_000,
            discountCents: 0,
            totalCents: 5_000_000,
            notes: null,
            createdAt: '2026-11-04 10:00:00',
            createdAtLocal: '2026-11-04T05:00:00',
            clientName: 'Lorena',
            clientPhone: '+573152392415',
            paidCents: 5_000_000,
            refundedCents: 0,
            netPaidCents: 5_000_000,
            pendingCents: 0,
            overpaidCents: 0,
            petNames: ['Dino'],
            services: ['Solo baño'],
            itemCount: 1,
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
    routes['DELETE /api/v1/sales/sale-1'] = {
      body: { data: { id: 'sale-1', deleted: true } },
    };

    renderApp('/sales');

    await waitFor(() => expect(screen.getByText(/Lorena/)).toBeTruthy());
    expect(screen.getByLabelText('Editar venta')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Eliminar venta'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sí, eliminar' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sí, eliminar' }));

    await waitFor(() =>
      expect(calls).toContain('DELETE /api/v1/sales/sale-1'),
    );
  });
});

describe('catálogo solo de artículos', () => {
  beforeEach(() => {
    localStorage.setItem('keyko.token', 'token-de-prueba');
    routes['GET /api/v1/auth/me'] = {
      body: { user: owner, business, role: 'owner' },
    };
    routes['GET /api/v1/products'] = {
      body: {
        data: [
          {
            id: 'prod-1',
            sku: 'SH-01',
            name: 'Shampoo',
            priceCents: 3_200_000,
            costCents: 1_800_000,
            stock: 8,
            minStock: 2,
            active: 1,
            deletedAt: null,
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
  });

  it('no ofrece servicios en el catálogo visible', async () => {
    renderApp('/catalog');

    await waitFor(() => expect(screen.getByText('Shampoo')).toBeTruthy());
    expect(screen.queryByRole('tab', { name: 'Servicios' })).toBeNull();
    expect(screen.getByText(/Los servicios se escriben en cada venta/)).toBeTruthy();
  });
});

describe('editar una venta', () => {
  beforeEach(() => {
    localStorage.setItem('keyko.token', 'token-de-prueba');
    routes['GET /api/v1/auth/me'] = {
      body: { user: owner, business, role: 'owner' },
    };
    routes['GET /api/v1/clients'] = {
      body: {
        data: [
          {
            id: 1,
            businessId: 'keyko',
            phone: '+573001112233',
            whatsappContactKey: '+573001112233',
            fullName: 'Ana Pérez',
            email: null,
            notes: null,
            source: 'manual',
            consentMarketing: 0,
            extra: null,
            createdAt: '',
            updatedAt: '',
            deletedAt: null,
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
    routes['GET /api/v1/pets'] = {
      body: {
        data: [
          {
            id: 'pet-luna',
            businessId: 'keyko',
            clientId: 1,
            name: 'Luna',
            species: 'gato',
            breed: null,
            sex: null,
            birthdate: null,
            weightKg: null,
            allergies: null,
            temperament: null,
            photoUrl: null,
            active: 1,
            deletedAt: null,
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
    routes['GET /api/v1/products'] = {
      body: { data: [], pagination: { limit: 100, offset: 0, count: 0 } },
    };
    routes['GET /api/v1/sales/sale-1'] = {
      body: {
        data: {
          id: 'sale-1',
          clientId: 1,
          appointmentId: null,
          status: 'paid',
          subtotalCents: 5_500_000,
          discountCents: 500_000,
          totalCents: 5_000_000,
          notes: 'Nota original',
          paidAt: null,
          createdAt: '2026-11-02 10:00:00',
          paidCents: 5_000_000,
          refundedCents: 0,
          netPaidCents: 5_000_000,
          pendingCents: 0,
          overpaidCents: 0,
          client: { id: 1, name: 'Ana Pérez', phone: '+573001112233' },
          items: [
            {
              id: 'item-1',
              saleId: 'sale-1',
              itemType: 'service',
              itemId: null,
              name: 'Baño y peluquería',
              petId: 'pet-luna',
              petName: 'Luna',
              appointmentId: null,
              qty: 1,
              unitPriceCents: 5_500_000,
              discountCents: 0,
              totalCents: 5_500_000,
              returnedQty: 0,
              notes: null,
              createdAt: '',
            },
          ],
          payments: [],
          history: [],
        },
      },
    };
    routes['PATCH /api/v1/sales/sale-1'] = {
      body: {
        data: {
          id: 'sale-1',
          clientId: 1,
          appointmentId: null,
          status: 'paid',
          subtotalCents: 6_000_000,
          discountCents: 0,
          totalCents: 6_000_000,
          notes: null,
          paidAt: null,
          createdAt: '2026-11-02 10:00:00',
          paidCents: 5_000_000,
          refundedCents: 0,
          netPaidCents: 5_000_000,
          pendingCents: 1_000_000,
          overpaidCents: 0,
          client: { id: 1, name: 'Ana Pérez', phone: '+573001112233' },
          items: [],
          payments: [],
          history: [],
        },
      },
    };
  });

  it('precarga las líneas y guarda con PATCH conservando sus ids', async () => {
    renderApp('/sales/sale-1/edit');

    await waitFor(() => {
      expect(screen.getByDisplayValue('Baño y peluquería')).toBeTruthy();
    });

    const price = screen.getByDisplayValue('55.000');
    fireEvent.change(price, { target: { value: '60.000' } });

    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() => {
      const patch = bodies.find((item) => item.path === '/api/v1/sales/sale-1');
      expect(patch).toBeDefined();
      const payload = patch?.body as {
        items: Array<{ id?: string; name: string; unitPriceCents: number }>;
      };
      expect(payload.items[0]?.id).toBe('item-1');
      expect(payload.items[0]?.name).toBe('Baño y peluquería');
      expect(payload.items[0]?.unitPriceCents).toBe(6_000_000);
    });
  });
});

describe('sugerencias de IA', () => {
  const suggestion = {
    id: 'sugg-1',
    status: 'pending',
    confidence: 0.92,
    model: 'fake-rule-based',
    createdAt: '2026-11-01 10:00:00',
    targetEntity: null,
    targetId: null,
    kind: 'client_create',
    title: 'Cliente nuevo',
    clientId: null,
    petId: null,
    fields: [
      {
        field: 'fullName',
        label: 'Nombre',
        value: 'Sofía Ramírez',
        confidence: 0.92,
        evidence: ['wamid.1'],
        quotes: ['Hola, me llamo Sofía Ramírez y tengo una perrita llamada Nala.'],
        conflict: false,
      },
    ],
    pets: [
      {
        fields: [
          {
            field: 'name',
            label: 'Nombre',
            value: 'Nala',
            confidence: 0.93,
            evidence: ['wamid.1'],
            quotes: [],
            conflict: false,
          },
        ],
      },
    ],
    conversation: {
      requestedService: 'baño y corte',
      wantsAppointment: true,
      requestedDate: 'sábado',
      requestedTime: '10:00',
      openQuestions: ['¿Tienen cupo?'],
      notes: null,
    },
    summary: 'Cliente nuevo con una mascota y una solicitud de cita.',
  };

  beforeEach(() => {
    localStorage.setItem('keyko.token', 'token-de-prueba');
    routes['GET /api/v1/auth/me'] = {
      body: { user: owner, business, role: 'owner' },
    };
    routes['GET /api/v1/ai/suggestions'] = {
      body: {
        data: [suggestion],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
    routes['GET /api/v1/ai/usage'] = {
      body: {
        data: {
          enabled: true,
          provider: 'fake',
          model: 'fake-rule-based',
          autoApply: false,
          budgetUsdMicros: 100_000,
          daily: { spentUsdMicros: 1_100, budgetUsdMicros: 100_000 },
          monthlyBudget: { spentUsdMicros: 1_100, budgetUsdMicros: 5_000_000 },
          monthlyUsage: [],
          errors: 0,
          blocked: null,
          storeRawResponse: false,
          rawRetentionDays: 7,
          alerts: [],
          calls: 1,
          tokensIn: 80,
          tokensOut: 0,
          costUsdMicros: 0,
          pendingSuggestions: 1,
        },
      },
    };
    routes['POST /api/v1/ai/suggestions/sugg-1/accept'] = {
      body: { data: { ...suggestion, status: 'applied' } },
    };
    routes['POST /api/v1/ai/process'] = {
      body: {
        data: {
          enqueued: 1,
          processed: 1,
          failed: 0,
          skipped: 0,
          suggestions: 1,
          applied: 0,
          reason: null,
          enabled: true,
          provider: 'fake',
          model: 'fake-rule-based',
          autoApply: false,
        },
      },
    };
  });

  it('muestra los datos, su origen y permite aceptar', async () => {
    renderApp('/ai');

    await waitFor(() => expect(screen.getByText('Sofía Ramírez')).toBeTruthy());
    expect(screen.getAllByText('Cliente nuevo').length).toBeGreaterThan(0);
    expect(screen.getByText(/me llamo Sofía Ramírez/)).toBeTruthy();
    expect(screen.getByText(/sábado/)).toBeTruthy();
    expect(screen.getByText(/llamada Nala/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Aceptar' }));

    await waitFor(() => {
      expect(
        bodies.some((item) =>
          item.path.endsWith('/ai/suggestions/sugg-1/accept'),
        ),
      ).toBe(true);
    });
  });

  it('procesa los mensajes pendientes desde la pantalla', async () => {
    renderApp('/ai');
    await waitFor(() => expect(screen.getByText('Sofía Ramírez')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Procesar mensajes/ }));

    await waitFor(() => {
      expect(calls.some((call) => call === 'POST /api/v1/ai/process')).toBe(true);
    });
  });
});

describe('completitud de perfil', () => {
  const pet = {
    id: 'pet-luna',
    businessId: 'keyko',
    clientId: 1,
    name: 'Luna',
    species: 'gato',
    breed: null,
    sex: null,
    birthdate: null,
    weightKg: null,
    allergies: null,
    temperament: null,
    photoUrl: null,
    active: 1,
    deletedAt: null,
    size: null,
    sizeLabel: null,
    clientName: 'Ana Pérez',
    clientPhone: '+573001112233',
    completeness: {
      percent: 40,
      earned: 40,
      applicable: 100,
      fields: [],
      complete: ['name', 'species'],
      missing: ['breed', 'sizeOrWeight', 'age', 'sex', 'photo'],
      pending: [],
      unknown: [],
      notApplicable: [],
      priorities: [
        { key: 'photo', label: 'Fotografía', weight: 20, priority: 'high', action: 'Agregar fotografía', status: 'missing' },
      ],
    },
  };

  beforeEach(() => {
    localStorage.setItem('keyko.token', 'token-de-prueba');
    routes['GET /api/v1/auth/me'] = {
      body: { user: owner, business, role: 'owner' },
    };
    routes['GET /api/v1/clients'] = {
      body: {
        data: [
          {
            id: 1,
            businessId: 'keyko',
            phone: '+573001112233',
            whatsappContactKey: '+573001112233',
            fullName: 'Ana Pérez',
            email: null,
            notes: null,
            source: 'manual',
            consentMarketing: 0,
            extra: null,
            createdAt: '',
            updatedAt: '',
            deletedAt: null,
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
    routes['GET /api/v1/pets'] = {
      body: { data: [pet], pagination: { limit: 100, offset: 0, count: 1 } },
    };
    routes['GET /api/v1/stats/data-quality'] = {
      body: {
        data: {
          contactsWithoutClient: 1,
          clientsWithoutName: 1,
          contactsWithoutPets: 1,
          petsWithoutPhoto: 1,
          petsIncomplete: 1,
          averagePetCompleteness: 62,
          totalClients: 5,
          totalPets: 6,
          details: {
            contactsWithoutClient: [
              {
                conversationId: 'conv-pending',
                contactKey: 'CO.PENDIENTE',
                contactName: 'Contacto pendiente',
                phone: null,
              },
            ],
            clientsWithoutName: [
              { id: 9, fullName: null, phone: '+573001119999' },
            ],
            contactsWithoutPets: [
              { id: 9, fullName: null, phone: '+573001119999' },
            ],
            petsWithoutPhoto: [
              {
                id: 'pet-sin-foto',
                name: 'Sin Foto',
                clientId: 9,
                clientName: null,
                percent: 80,
              },
            ],
            petsIncomplete: [
              {
                id: 'pet-sin-foto',
                name: 'Sin Foto',
                clientId: 9,
                clientName: null,
                percent: 80,
              },
            ],
            allPets: [
              {
                id: 'pet-sin-foto',
                name: 'Sin Foto',
                clientId: 9,
                clientName: null,
                percent: 80,
              },
            ],
          },
        },
      },
    };
  });

  it('muestra el porcentaje y la calidad de datos', async () => {
    renderApp('/');

    await waitFor(() => expect(screen.getByText('Luna')).toBeTruthy());
    expect(screen.getByText('40 %')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Contactos sin ficha/ }));
    await waitFor(() =>
      expect(screen.getByText('Contacto pendiente')).toBeTruthy(),
    );
    expect(screen.getByText('CO.PENDIENTE')).toBeTruthy();
    expect(screen.getByText('62 %')).toBeTruthy();
    expect(screen.getByText('Mascotas sin foto')).toBeTruthy();
  });

  it('filtra mascotas sin fotografía contra la API', async () => {
    renderApp('/');
    await waitFor(() => expect(screen.getByText('Luna')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Información faltante'), {
      target: { value: 'photo' },
    });

    await waitFor(() => {
      expect(
        calls.some((call) => call.includes('/pets?') && call.includes('missing=photo')),
      ).toBe(true);
    });
  });
});

describe('ficha de mascota', () => {
  const completeness = {
    percent: 70,
    earned: 70,
    applicable: 100,
    fields: [
      {
        key: 'photo',
        label: 'Fotografía',
        weight: 20,
        priority: 'high',
        action: 'Agregar fotografía',
        status: 'missing',
      },
    ],
    complete: ['name', 'species', 'breed', 'weightKg', 'sex'],
    missing: ['age', 'photo'],
    pending: [],
    unknown: ['age'],
    notApplicable: [],
    priorities: [
      {
        key: 'photo',
        label: 'Fotografía',
        weight: 20,
        priority: 'high',
        action: 'Agregar fotografía',
        status: 'missing',
      },
      {
        key: 'age',
        label: 'Edad',
        weight: 10,
        priority: 'medium',
        action: 'Registrar edad',
        status: 'missing',
      },
    ],
  };

  beforeEach(() => {
    localStorage.setItem('keyko.token', 'token-de-prueba');
    routes['GET /api/v1/auth/me'] = {
      body: { user: owner, business, role: 'owner' },
    };
    routes['GET /api/v1/clients'] = {
      body: { data: [], pagination: { limit: 100, offset: 0, count: 0 } },
    };
    routes['GET /api/v1/pets/pet-1/history'] = {
      body: {
        data: {
          pet: {
            id: 'pet-1',
            businessId: 'keyko',
            clientId: 1,
            name: 'Luna',
            species: 'gato',
            breed: 'Siamés',
            sex: 'hembra',
            birthdate: null,
            weightKg: 4.2,
            allergies: null,
            temperament: null,
            photoUrl: null,
            active: 1,
            deletedAt: null,
            size: 'small',
            sizeLabel: 'Pequeño',
          },
          completeness,
          client: { id: 1, name: 'Ana Pérez', phone: '+573001112233', email: null },
          stats: {
            totalSpentCents: 6_500_000,
            servicesCount: 2,
            productsCount: 1,
            salesCount: 2,
            visitsCount: 1,
            upcomingCount: 1,
            lastServiceAt: '2026-10-01T15:00:00.000Z',
            lastServiceName: 'Baño',
          },
          appointments: [
            {
              id: 'appt-1',
              startsAtLocal: '2026-11-05T10:00:00',
              endsAtLocal: '2026-11-05T11:00:00',
              status: 'scheduled',
              notes: 'Primera visita',
            },
          ],
          timeline: [],
        },
      },
    };
  });

  it('muestra la ficha, la completitud y las citas con su hora', async () => {
    renderApp('/pets/pet-1');

    await waitFor(() => expect(screen.getByText('Luna')).toBeTruthy());
    expect(screen.getByText(/70 %/)).toBeTruthy();
    expect(screen.getByText(/Agregar fotografía/)).toBeTruthy();
    expect(screen.getByText(/10:00–11:00/)).toBeTruthy();
    expect(screen.getByText(/Ana Pérez/)).toBeTruthy();
    expect(screen.getByText('Pendiente por confirmar')).toBeTruthy();
  });
});

describe('nueva cita desde una mascota', () => {
  const pet = {
    id: 'pet-1',
    businessId: 'keyko',
    clientId: 1,
    name: 'Luna',
    species: 'gato',
    breed: 'Siamés',
    sex: 'hembra',
    birthdate: null,
    weightKg: 4.2,
    allergies: null,
    temperament: null,
    photoUrl: null,
    active: 1,
    deletedAt: null,
    size: 'small' as const,
    sizeLabel: 'Pequeño',
    clientName: 'Ana Pérez',
    clientPhone: '+573001112233',
  };

  const completeness = {
    percent: 70,
    earned: 70,
    applicable: 100,
    fields: [],
    complete: ['name'],
    missing: ['photo'],
    pending: [],
    unknown: [],
    notApplicable: [],
    priorities: [],
  };

  beforeEach(() => {
    localStorage.setItem('keyko.token', 'token-de-prueba');
    routes['GET /api/v1/auth/me'] = {
      body: { user: owner, business, role: 'owner' },
    };
    routes['GET /api/v1/clients'] = {
      body: {
        data: [
          {
            id: 1,
            businessId: 'keyko',
            phone: '+573001112233',
            whatsappContactKey: '+573001112233',
            fullName: 'Ana Pérez',
            email: null,
            notes: null,
            source: 'manual',
            consentMarketing: 0,
            extra: null,
            createdAt: '',
            updatedAt: '',
            deletedAt: null,
          },
        ],
        pagination: { limit: 100, offset: 0, count: 1 },
      },
    };
    routes['GET /api/v1/pets'] = {
      body: { data: [pet], pagination: { limit: 100, offset: 0, count: 1 } },
    };
    routes['GET /api/v1/appointments'] = {
      body: { data: [], pagination: { limit: 100, offset: 0, count: 0 } },
    };
    routes['GET /api/v1/pets/pet-1/history'] = {
      body: {
        data: {
          pet,
          completeness,
          client: { id: 1, name: 'Ana Pérez', phone: '+573001112233', email: null },
          stats: {
            totalSpentCents: 0,
            servicesCount: 0,
            productsCount: 0,
            salesCount: 0,
            visitsCount: 0,
            upcomingCount: 0,
            lastServiceAt: null,
            lastServiceName: null,
          },
          appointments: [],
          timeline: [],
        },
      },
    };
  });

  it('al cerrar el modal vuelve a la ficha de la mascota', async () => {
    renderApp('/agenda?petId=pet-1&new=1&from=%2Fpets%2Fpet-1');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Nueva cita' })).toBeTruthy();
    });

    const closeButtons = screen.getAllByRole('button', { name: 'Cerrar' });
    fireEvent.click(closeButtons[closeButtons.length - 1] as HTMLElement);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Luna' })).toBeTruthy();
    });
    expect(screen.queryByRole('heading', { name: 'Nueva cita' })).toBeNull();
  });
});
