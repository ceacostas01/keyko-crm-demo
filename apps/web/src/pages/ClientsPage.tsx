import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Client, Pet } from '../api/types';
import { useAsync } from '../api/useAsync';
import { Icon } from '../components/Icon';
import { WhatsAppIcon } from '../components/WhatsAppIcon';
import {
  Avatar,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Spinner,
  Textarea,
  useToast,
} from '../components/ui';
import { prettyPhone } from '../lib/format';

export function ClientsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const clients = useAsync(() => api.clients.list(), []);
  const pets = useAsync(() => api.pets.list(), []);

  const petCount = useMemo(() => {
    const map = new Map<number, number>();
    for (const pet of pets.data?.data ?? []) {
      map.set(pet.clientId, (map.get(pet.clientId) ?? 0) + 1);
    }
    return map;
  }, [pets.data]);

  const rows = (clients.data?.data ?? []).filter((client) => {
    if (!search.trim()) return true;
    const term = search.trim().toLowerCase();
    return (
      (client.fullName ?? '').toLowerCase().includes(term) ||
      (client.whatsappName ?? '').toLowerCase().includes(term) ||
      (client.phone ?? '').includes(term) ||
      (client.email ?? '').toLowerCase().includes(term)
    );
  });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Clientes</h1>
          <p>Personas, teléfonos y sus mascotas.</p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          Nuevo cliente
        </Button>
      </div>

      <div className="search" style={{ marginBottom: 14 }}>
        <Icon name="search" size={18} />
        <Input
          placeholder="Buscar por nombre, teléfono o correo…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          inputMode="search"
        />
      </div>

      {clients.loading ? (
        <div className="card card-pad">
          <Spinner label="Cargando clientes…" />
        </div>
      ) : clients.error ? (
        <EmptyState
          icon="alert"
          title="No se pudieron cargar los clientes"
          hint={clients.error.message}
          action={<Button onClick={clients.reload}>Reintentar</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="users"
          title={search ? 'Sin resultados' : 'Todavía no hay clientes'}
          hint={
            search
              ? 'Prueba con otro nombre o teléfono.'
              : 'Crea el primero para poder agendar citas.'
          }
          action={
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              Nuevo cliente
            </Button>
          }
        />
      ) : (
        <div className="card">
          <div className="list">
            {rows.map((client) => (
              <div className="list-item client-row" key={client.id}>
                <button
                  type="button"
                  className="client-row-main"
                  onClick={() => navigate(`/clients/${client.id}`)}
                >
                  <Avatar name={client.fullName ?? client.whatsappName ?? client.phone} />
                  <span className="list-item-body">
                    <strong>
                      {client.fullName ??
                        client.whatsappName ??
                        `Cliente ${client.id}`}
                    </strong>
                    <span>
                      {prettyPhone(client.phone)}
                      {petCount.get(client.id)
                        ? ` · ${petCount.get(client.id)} mascota${petCount.get(client.id) === 1 ? '' : 's'}`
                        : ' · sin mascotas'}
                    </span>
                  </span>
                  {client.completeness ? (
                    <span
                      className={`completeness-badge ${
                        client.completeness.percent < 50
                          ? 'is-low'
                          : client.completeness.percent < 80
                            ? 'is-mid'
                            : 'is-high'
                      }`}
                    >
                      {client.completeness.percent} %
                    </span>
                  ) : null}
                </button>
                <Link
                  className="whatsapp-action"
                  to={`/inbox?clientId=${client.id}`}
                  aria-label={`Abrir WhatsApp de ${client.fullName ?? 'este cliente'}`}
                  title="Abrir conversación de WhatsApp"
                >
                  <WhatsAppIcon size={17} />
                </Link>
                <Icon name="right" size={18} />
              </div>
            ))}
          </div>
        </div>
      )}

      <NewClientModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          clients.reload();
          pets.reload();
          toast('Cliente creado.');
        }}
      />
    </div>
  );
}

function NewClientModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setFullName('');
    setPhone('');
    setEmail('');
    setNotes('');
    setError(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.clients.create({
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: email.trim() === '' ? null : email.trim(),
        notes: notes.trim() === '' ? null : notes.trim(),
      });
      reset();
      onCreated();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'No se pudo crear el cliente.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Nuevo cliente"
      subtitle="Solo el nombre y el teléfono son obligatorios."
      onClose={() => {
        reset();
        onClose();
      }}
      footer={
        <>
          <Button
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={busy}
          >
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} loading={busy}>
            Guardar
          </Button>
        </>
      }
    >
      {error ? <div className="login-error" style={{ marginBottom: 14 }}>{error}</div> : null}

      <div className="form-grid">
        <div className="span-2">
          <Field label="Nombre completo">
            <Input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Ana Pérez"
              autoFocus
            />
          </Field>
        </div>
        <Field label="Teléfono" hint="Se normaliza a +57… y no puede repetirse">
          <Input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="312 575 4547"
            inputMode="tel"
          />
        </Field>
        <Field label="Correo (opcional)">
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="ana@correo.com"
            inputMode="email"
          />
        </Field>
        <div className="span-2">
          <Field label="Notas">
            <Textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Preferencias, cómo llegar, quién recomienda…"
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

export type { Client, Pet };
