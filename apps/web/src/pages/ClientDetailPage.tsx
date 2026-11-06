import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Client, Pet } from '../api/types';
import { useAsync } from '../api/useAsync';
import { BreedInput } from '../components/BreedInput';
import { Icon } from '../components/Icon';
import { WhatsAppIcon } from '../components/WhatsAppIcon';
import {
  Badge,
  Button,
  Confirm,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
  useToast,
} from '../components/ui';
import { ageFromInput, ageToInput, type AgeUnit } from '../lib/age';
import { prettyPhone, SPECIES_LABELS } from '../lib/format';

type ClientWithPets = Client & { pets: Pet[] };

export function ClientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const requestedFrom = new URLSearchParams(location.search).get('from');
  const backTo =
    requestedFrom && requestedFrom.startsWith('/') && !requestedFrom.startsWith('//')
      ? requestedFrom
      : '/clients';
  const backLabel = backTo.startsWith('/inbox') ? 'Bandeja' : 'Clientes';
  const { toast } = useToast();

  const [petForm, setPetForm] = useState<Pet | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [petToDelete, setPetToDelete] = useState<Pet | null>(null);
  const [busy, setBusy] = useState(false);

  const clientId = Number(id);
  const detail = useAsync(
    () => api.clients.get(clientId),
    [clientId],
  );

  const client = detail.data?.data ?? null;

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);

  useEffect(() => {
    if (!client) return;
    setFullName(client.fullName ?? '');
    setPhone(client.phone ?? '');
    setEmail(client.email ?? '');
    setNotes(client.notes ?? '');
    setConsent(client.consentMarketing === 1);
  }, [client]);

  const nameUnknown = (() => {
    try {
      const raw = client?.profileFlagsJson;
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { unknown?: string[] };
      return (parsed.unknown ?? []).includes('name');
    } catch {
      return false;
    }
  })();

  const hasName = (client?.fullName ?? '').trim().length >= 2;
  const whatsappName = (client?.whatsappName ?? '').trim();
  const displayName =
    client?.fullName?.trim() ||
    whatsappName ||
    (client ? `Contacto ${prettyPhone(client.phone)}` : '');

  async function toggleUnknownName() {
    if (!client) return;
    setFlagBusy(true);
    try {
      let flags: { unknown: string[]; na: string[] } = { unknown: [], na: [] };
      try {
        const parsed = client.profileFlagsJson
          ? (JSON.parse(client.profileFlagsJson) as { unknown?: string[]; na?: string[] })
          : {};
        flags = {
          unknown: parsed.unknown ?? [],
          na: parsed.na ?? [],
        };
      } catch {
        // Se reinician las marcas si el JSON está corrupto.
      }

      flags.unknown = nameUnknown
        ? flags.unknown.filter((key) => key !== 'name')
        : [...new Set([...flags.unknown, 'name'])];

      await api.clients.update(clientId, { profileFlags: flags });
      detail.reload();
      toast(nameUnknown ? 'Marca retirada.' : 'Nombre marcado como desconocido.');
    } catch (cause) {
      toast(
        cause instanceof ApiError ? cause.message : 'No se pudo actualizar.',
        'error',
      );
    } finally {
      setFlagBusy(false);
    }
  }

  const dirty =
    client !== null &&
    (fullName !== (client.fullName ?? '') ||
      phone !== (client.phone ?? '') ||
      email !== (client.email ?? '') ||
      notes !== (client.notes ?? '') ||
      consent !== (client.consentMarketing === 1));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.clients.update(clientId, {
        ...(fullName.trim().length >= 2 ? { fullName: fullName.trim() } : {}),
        phone: phone.trim(),
        email: email.trim() === '' ? null : email.trim(),
        notes: notes.trim() === '' ? null : notes.trim(),
        consentMarketing: consent,
      });
      detail.reload();
      toast('Cliente actualizado.');
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'No se pudo guardar el cliente.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeClient() {
    setBusy(true);
    try {
      await api.clients.remove(clientId);
      toast('Cliente eliminado.');
      navigate('/clients');
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'No se pudo eliminar.',
      );
      setBusy(false);
    }
  }

  async function removePet() {
    if (!petToDelete) return;
    setBusy(true);
    try {
      await api.pets.remove(petToDelete.id);
      setPetToDelete(null);
      detail.reload();
      toast('Mascota eliminada.');
    } catch (cause) {
      toast(
        cause instanceof ApiError ? cause.message : 'No se pudo eliminar.',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }

  if (detail.loading) {
    return (
      <div className="card card-pad">
        <Spinner label="Cargando ficha…" />
      </div>
    );
  }

  if (detail.error || !client) {
    return (
      <EmptyState
        icon="alert"
        title="No se encontró el cliente"
        hint={detail.error?.message}
        action={
          <Button onClick={() => navigate('/clients')}>Volver a clientes</Button>
        }
      />
    );
  }

  return (
    <div className="col" style={{ gap: 18 }}>
      <Link to={backTo} className="row muted small" style={{ gap: 6 }}>
        <Icon name="back" size={16} /> {backLabel}
      </Link>

      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>{displayName}</h1>
          <p>{prettyPhone(client.phone)}</p>
          {whatsappName && hasName && whatsappName !== client.fullName ? (
            <p className="muted small">Nombre en WhatsApp: {whatsappName}</p>
          ) : null}
          {!hasName && !nameUnknown ? (
            <button
              type="button"
              className="flag-action"
              onClick={toggleUnknownName}
              disabled={flagBusy}
              style={{ marginTop: 6 }}
            >
              Aún no sé el nombre
            </button>
          ) : null}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Link
            className="btn btn-whatsapp"
            to={`/inbox?clientId=${client.id}`}
            aria-label={`Abrir WhatsApp de ${client.fullName ?? 'este cliente'}`}
          >
            <WhatsAppIcon size={18} />
            <span>WhatsApp</span>
          </Link>
          <Badge tone={client.consentMarketing ? 'ok' : 'neutral'}>
            {client.consentMarketing ? 'Acepta marketing' : 'Sin marketing'}
          </Badge>
          <Button variant="subtle" icon="trash" onClick={() => setConfirmDelete(true)}>
            Eliminar
          </Button>
        </div>
      </div>

      {error ? <div className="login-error">{error}</div> : null}

      {nameUnknown ? (
        <div className="card card-pad flag-section">
          <span className="section-title">Pendiente por confirmar</span>
          <div className="flag-row">
            <span className="flag-name">Nombre</span>
            <button
              type="button"
              className="flag-action"
              onClick={() => document.getElementById('client-name')?.focus()}
            >
              Confirmar
            </button>
            <button
              type="button"
              className="flag-action"
              onClick={toggleUnknownName}
              disabled={flagBusy}
            >
              Quitar marca
            </button>
          </div>
        </div>
      ) : null}

      <div className="card card-pad">
        <div className="form-grid">
          <Field
            label="Nombre completo"
            hint={
              whatsappName && whatsappName !== fullName
                ? `En WhatsApp aparece como ${whatsappName}`
                : undefined
            }
          >
            <Input
              id="client-name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
            />
          </Field>
          <Field label="Teléfono" hint="También se usa para vincular WhatsApp; no puede repetirse">
            <Input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              inputMode="tel"
            />
          </Field>
          <Field label="Correo">
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              inputMode="email"
            />
          </Field>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="switch">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              Acepta recibir promociones
            </label>
          </div>
          <div className="span-2">
            <Field label="Notas">
              <Textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Alergias, preferencias, historial…"
              />
            </Field>
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <Button onClick={detail.reload} disabled={!dirty || busy}>
            Descartar
          </Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={!dirty}>
            Guardar cambios
          </Button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Mascotas</h2>
          <Button icon="plus" onClick={() => setPetForm('new')}>
            Añadir
          </Button>
        </div>

        <div className="card-pad">
          {client.pets.length === 0 ? (
            <EmptyState
              icon="paw"
              title="Sin mascotas todavía"
              hint="Añade una para poder agendarle citas."
              action={
                <Button variant="primary" icon="plus" onClick={() => setPetForm('new')}>
                  Añadir mascota
                </Button>
              }
            />
          ) : (
            client.pets.map((pet) => (
              <div className="pet-row" key={pet.id}>
                <span className="empty-icon" style={{ width: 42, height: 42 }}>
                  <Icon name="paw" size={20} />
                </span>
                <div className="grow">
                  <strong style={{ display: 'block' }}>{pet.name}</strong>
                  <span className="muted small">
                    {SPECIES_LABELS[pet.species] ?? pet.species}
                    {pet.breed ? ` · ${pet.breed}` : ''}
                    {pet.weightKg ? ` · ${pet.weightKg} kg` : ''}
                    {pet.allergies ? ` · Alergias: ${pet.allergies}` : ''}
                  </span>
                </div>
                <Link
                  className="btn btn-subtle btn-sm"
                  to={`/pets/${pet.id}?from=${encodeURIComponent(`${location.pathname}${location.search}`)}`}
                >
                  Ver ficha
                </Link>
                <Button
                  variant="subtle"
                  className="btn-sm"
                  onClick={() => setPetForm(pet)}
                >
                  Editar
                </Button>
                <Button
                  variant="subtle"
                  icon="trash"
                  className="btn-sm btn-icon"
                  onClick={() => setPetToDelete(pet)}
                  aria-label={`Eliminar ${pet.name}`}
                />
              </div>
            ))
          )}
        </div>
      </div>

      <PetEditor
        clientId={clientId}
        pet={petForm === 'new' ? null : petForm}
        open={petForm !== null}
        onClose={() => setPetForm(null)}
        onSaved={() => {
          setPetForm(null);
          detail.reload();
          toast(petForm === 'new' ? 'Mascota añadida.' : 'Mascota actualizada.');
        }}
      />

      <Confirm
        open={confirmDelete}
        title="Eliminar cliente"
        message={`${client.fullName ?? 'Este cliente'} dejará de aparecer en la lista. Sus citas se conservan en el historial.`}
        confirmLabel="Eliminar"
        busy={busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={removeClient}
      />

      <Confirm
        open={petToDelete !== null}
        title="Eliminar mascota"
        message={`${petToDelete?.name ?? 'La mascota'} dejará de aparecer en la ficha. Las citas anteriores se conservan.`}
        confirmLabel="Eliminar"
        busy={busy}
        onCancel={() => setPetToDelete(null)}
        onConfirm={removePet}
      />
    </div>
  );
}

function PetEditor({
  clientId,
  pet,
  open,
  onClose,
  onSaved,
}: {
  clientId: number;
  pet: Pet | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [species, setSpecies] = useState<'perro' | 'gato'>('perro');
  const [sex, setSex] = useState<'' | 'macho' | 'hembra'>('');
  const [breed, setBreed] = useState('');
  const [ageValue, setAgeValue] = useState('');
  const [ageUnit, setAgeUnit] = useState<AgeUnit>('years');
  const [weight, setWeight] = useState('');
  const [allergies, setAllergies] = useState('');
  const [temperament, setTemperament] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(pet?.name ?? '');
    setSpecies(pet?.species ?? 'perro');
    setSex(pet?.sex ?? '');
    setBreed(pet?.breed ?? '');
    const age = ageToInput(pet?.ageYears);
    setAgeValue(age.value);
    setAgeUnit(age.unit);
    setWeight(pet?.weightKg ? String(pet.weightKg) : '');
    setAllergies(pet?.allergies ?? '');
    setTemperament(pet?.temperament ?? '');
    setError(null);
  }, [open, pet]);

  async function save() {
    setBusy(true);
    setError(null);

    const payload = {
      name: name.trim(),
      species,
      sex: sex === '' ? null : sex,
      breed: breed.trim() === '' ? null : breed.trim(),
      ageYears: ageFromInput(ageValue, ageUnit),
      weightKg: weight.trim() === '' ? null : Number(weight),
      allergies: allergies.trim() === '' ? null : allergies.trim(),
      temperament: temperament.trim() === '' ? null : temperament.trim(),
    };

    try {
      if (pet) await api.pets.update(pet.id, payload);
      else await api.pets.create({ ...payload, clientId });
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'No se pudo guardar.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={pet ? 'Editar mascota' : 'Nueva mascota'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
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
        <Field label="Nombre">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Luna"
            autoFocus
          />
        </Field>
        <Field label="Especie">
          <Select
            value={species}
            onChange={(event) =>
              setSpecies(event.target.value as 'perro' | 'gato')
            }
          >
            <option value="perro">Perro</option>
            <option value="gato">Gato</option>
          </Select>
        </Field>
        <Field label="Sexo">
          <Select
            value={sex}
            onChange={(event) =>
              setSex(event.target.value as '' | 'macho' | 'hembra')
            }
          >
            <option value="">Sin definir</option>
            <option value="macho">Macho</option>
            <option value="hembra">Hembra</option>
          </Select>
        </Field>
        <Field label="Raza" hint="Escribe para buscar o crea una raza nueva">
          <BreedInput value={breed} onChange={setBreed} />
        </Field>
        <Field label="Edad" hint="Elige meses o años y escribe el número">
          <div className="row" style={{ gap: 8 }}>
            <Input
              type="number"
              min="0"
              step={ageUnit === 'months' ? '1' : '0.5'}
              value={ageValue}
              onChange={(event) => setAgeValue(event.target.value)}
              inputMode="decimal"
              style={{ flex: 1 }}
            />
            <Select
              value={ageUnit}
              onChange={(event) => setAgeUnit(event.target.value as AgeUnit)}
              style={{ maxWidth: 120 }}
            >
              <option value="years">Años</option>
              <option value="months">Meses</option>
            </Select>
          </div>
        </Field>
        <Field label="Peso (kg)">
          <Input
            type="number"
            step="0.1"
            min="0"
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
            inputMode="decimal"
          />
        </Field>
        <div className="span-2">
          <Field label="Alergias">
            <Input
              value={allergies}
              onChange={(event) => setAllergies(event.target.value)}
              placeholder="Pollo, shampoo con perfume…"
            />
          </Field>
        </div>
        <div className="span-2">
          <Field label="Temperamento">
            <Input
              value={temperament}
              onChange={(event) => setTemperament(event.target.value)}
              placeholder="Tranquila, nerviosa con la secadora…"
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
