// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PetPhotoModal } from './components/PetPhotoModal';
import { ToastProvider } from './components/ui';

vi.mock('./lib/image', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/image')>();
  return {
    ...actual,
    compressImage: vi.fn(async () => new Blob(['comprimida'], { type: 'image/jpeg' })),
  };
});

let calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

beforeEach(() => {
  localStorage.setItem('keyko.token', 'token-de-prueba');
  calls = [];

  Object.defineProperty(URL, 'createObjectURL', {
    writable: true,
    value: vi.fn(() => 'blob:preview'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    writable: true,
    value: vi.fn(),
  });

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
    });

    return new Response(
      JSON.stringify({
        data: { id: 'pet-1', photoUrl: '/api/v1/photos/pets/pet-1?token=x' },
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderModal(hasPhoto = false) {
  return render(
    <ToastProvider>
      <PetPhotoModal
        open
        petId="pet-1"
        petName="Luna"
        hasPhoto={hasPhoto}
        onClose={() => undefined}
        onSaved={() => undefined}
      />
    </ToastProvider>,
  );
}

describe('modal de foto', () => {
  it('comprime, muestra vista previa y sube la imagen', async () => {
    const { container } = renderModal();
    const input = container.querySelectorAll('input[type="file"]')[1] as HTMLInputElement;

    const file = new File([new Uint8Array(1000)], 'luna.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByAltText('Vista previa')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Guardar foto' }));

    await waitFor(() => {
      const upload = calls.find((call) => call.url.endsWith('/pets/pet-1/photo'));
      expect(upload).toBeDefined();
      expect(upload?.headers.authorization).toBe('Bearer token-de-prueba');
    });
  });

  it('rechaza un archivo que no es imagen', async () => {
    const { container } = renderModal();
    const input = container.querySelectorAll('input[type="file"]')[1] as HTMLInputElement;

    const file = new File(['texto'], 'nota.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText(/Formato no válido/)).toBeTruthy();
    });
    expect(screen.queryByAltText('Vista previa')).toBeNull();
  });

  it('permite quitar la foto con confirmación', async () => {
    renderModal(true);

    fireEvent.click(screen.getByRole('button', { name: 'Quitar foto' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar borrado' }));

    await waitFor(() => {
      const remove = calls.find(
        (call) => call.url.endsWith('/pets/pet-1/photo') && call.method === 'DELETE',
      );
      expect(remove).toBeDefined();
    });
  });
});
