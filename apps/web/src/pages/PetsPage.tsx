import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, mediaUrl } from '../api/client';
import type { Pet, PetWithClient } from '../api/types';
import { useAsync } from '../api/useAsync';
import type { DataQualitySummary } from '../api/types';
import { Icon } from '../components/Icon';
import {
  Avatar,
  Button,
  EmptyState,
  Input,
  Select,
  Spinner,
  useToast,
} from '../components/ui';
import {
  PET_SIZE_HELP,
  prettyPhone,
  SIZE_LABELS,
  SPECIES_LABELS,
} from '../lib/format';
import { PetEditor } from './PetEditor';

const SPECIES = ['', 'perro', 'gato'] as const;
const SIZES = ['', 'small', 'medium', 'large'] as const;

export function PetsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [species, setSpecies] = useState('');
  const [size, setSize] = useState('');
  const [breed, setBreed] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [missing, setMissing] = useState('');
  const [band, setBand] = useState('');
  const [editing, setEditing] = useState<Pet | 'new' | null>(null);
  const [qualityGroup, setQualityGroup] = useState<QualityGroup | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const pets = useAsync(
    () =>
      api.pets.list({
        ...(debounced ? { search: debounced } : {}),
        ...(species ? { species } : {}),
        ...(size ? { size } : {}),
        ...(breed.trim() ? { breed: breed.trim() } : {}),
        ...(ownerId ? { clientId: Number(ownerId) } : {}),
        ...(missing ? { missing } : {}),
        ...(band ? { completeness: band } : {}),
      }),
    [debounced, species, size, breed, ownerId, missing, band],
  );

  const clients = useAsync(() => api.clients.list(), []);
  const quality = useAsync<{ data: DataQualitySummary }>(
    () => api.stats.dataQuality(),
    [],
  );

  const rows = pets.data?.data ?? [];
  const ownerList = clients.data?.data ?? [];
  const filtersActive = Boolean(
    species || size || breed || ownerId || debounced || missing || band,
  );

  function toggleQualityGroup(group: QualityGroup) {
    setQualityGroup((current) => (current === group ? null : group));
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Mascotas</h1>
          <p>La ficha de cada mascota es el centro del CRM.</p>
        </div>
        <div className="row">
          <Link className="btn btn-ghost" to="/clients">
            <Icon name="users" size={18} />
            <span>Clientes</span>
          </Link>
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
            Nueva mascota
          </Button>
        </div>
      </div>

      {quality.data ? (
        <section className="quality-card card">
          <div className="quality-head">
            <strong>Calidad de datos</strong>
            <span className="muted small">
              Solo perfiles. No incluye ventas ni citas.
            </span>
          </div>
          <div className="quality-grid">
            <QualityItem
              label="Contactos sin ficha"
              value={quality.data.data.contactsWithoutClient}
              active={qualityGroup === 'contactsWithoutClient'}
              onClick={() => toggleQualityGroup('contactsWithoutClient')}
            />
            <QualityItem
              label="Clientes sin nombre"
              value={quality.data.data.clientsWithoutName}
              active={qualityGroup === 'clientsWithoutName'}
              onClick={() => toggleQualityGroup('clientsWithoutName')}
            />
            <QualityItem
              label="Contactos sin mascotas"
              value={quality.data.data.contactsWithoutPets}
              active={qualityGroup === 'contactsWithoutPets'}
              onClick={() => toggleQualityGroup('contactsWithoutPets')}
            />
            <QualityItem
              label="Mascotas sin foto"
              value={quality.data.data.petsWithoutPhoto}
              active={qualityGroup === 'petsWithoutPhoto'}
              onClick={() => toggleQualityGroup('petsWithoutPhoto')}
            />
            <QualityItem
              label="Mascotas incompletas"
              value={quality.data.data.petsIncomplete}
              active={qualityGroup === 'petsIncomplete'}
              onClick={() => toggleQualityGroup('petsIncomplete')}
            />
            <QualityItem
              label="Completitud media"
              value={`${quality.data.data.averagePetCompleteness} %`}
              active={qualityGroup === 'allPets'}
              onClick={() => toggleQualityGroup('allPets')}
            />
          </div>
          {qualityGroup ? (
            <QualityDetails
              group={qualityGroup}
              summary={quality.data.data}
              onClose={() => setQualityGroup(null)}
            />
          ) : null}
        </section>
      ) : null}

      <div className="search" style={{ marginBottom: 10 }}>
        <Icon name="search" size={18} />
        <Input
          placeholder="Buscar por nombre, raza, dueño o teléfono…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          inputMode="search"
        />
      </div>

      <div className="filter-bar">
        <div className="chips" role="group" aria-label="Especie">
          {SPECIES.map((value) => (
            <button
              key={value || 'all'}
              type="button"
              className={`chip ${species === value ? 'chip-active' : ''}`}
              onClick={() => setSpecies(value)}
            >
              {value === '' ? 'Todas' : SPECIES_LABELS[value]}
            </button>
          ))}
        </div>

        <Select
          value={size}
          onChange={(event) => setSize(event.target.value)}
          aria-label="Tamaño"
          title={PET_SIZE_HELP}
          style={{ width: 150 }}
        >
          <option value="">Tamaño</option>
          {SIZES.filter(Boolean).map((value) => (
            <option key={value} value={value}>
              {SIZE_LABELS[value]}
            </option>
          ))}
        </Select>

        <Select
          value={ownerId}
          onChange={(event) => setOwnerId(event.target.value)}
          aria-label="Propietario"
          style={{ width: 190 }}
        >
          <option value="">Todos los dueños</option>
          {ownerList.map((client) => (
            <option key={client.id} value={client.id}>
              {client.fullName ?? `Cliente ${client.id}`}
            </option>
          ))}
        </Select>

        <Input
          value={breed}
          onChange={(event) => setBreed(event.target.value)}
          placeholder="Raza"
          aria-label="Raza"
          style={{ width: 150 }}
        />

        <Select
          value={missing}
          onChange={(event) => setMissing(event.target.value)}
          aria-label="Información faltante"
          style={{ width: 170 }}
        >
          <option value="">Sin filtro de datos</option>
          <option value="photo">Sin fotografía</option>
          <option value="breed">Sin raza</option>
          <option value="age">Sin edad</option>
          <option value="sizeOrWeight">Sin peso</option>
          <option value="sex">Sin sexo</option>
        </Select>

        <Select
          value={band}
          onChange={(event) => setBand(event.target.value)}
          aria-label="Completitud"
          style={{ width: 170 }}
        >
          <option value="">Cualquier completitud</option>
          <option value="under50">Menos de 50 %</option>
          <option value="mid">Entre 50 % y 80 %</option>
          <option value="over80">Más de 80 %</option>
        </Select>

        {filtersActive ? (
          <Button
            variant="subtle"
            onClick={() => {
              setSearch('');
              setSpecies('');
              setSize('');
              setBreed('');
              setOwnerId('');
              setMissing('');
              setBand('');
            }}
          >
            Limpiar
          </Button>
        ) : null}
      </div>

      {pets.loading ? (
        <div className="card card-pad">
          <Spinner label="Cargando mascotas…" />
        </div>
      ) : pets.error ? (
        <EmptyState
          icon="alert"
          title="No se pudieron cargar las mascotas"
          hint={pets.error.message}
          action={<Button onClick={pets.reload}>Reintentar</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="paw"
          title={filtersActive ? 'Sin resultados' : 'Todavía no hay mascotas'}
          hint={
            filtersActive
              ? 'Prueba con otro nombre, raza o dueño.'
              : 'Registra la primera mascota para empezar a agendar y vender.'
          }
          action={
            <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
              Nueva mascota
            </Button>
          }
        />
      ) : (
        <>
          <p className="muted small" style={{ margin: '4px 0 10px' }}>
            {rows.length} mascota{rows.length === 1 ? '' : 's'}
            {filtersActive ? ' con los filtros aplicados' : ''}
          </p>
          <div className="pet-grid">
            {rows.map((pet) => (
              <PetCard
                key={pet.id}
                pet={pet}
                onClick={() => navigate(`/pets/${pet.id}`)}
              />
            ))}
          </div>
        </>
      )}

      <PetEditor
        open={editing !== null}
        pet={editing === 'new' ? null : (editing as Pet | null)}
        clients={ownerList}
        onClose={() => setEditing(null)}
        onSaved={(pet, createdClient) => {
          setEditing(null);
          clients.reload();
          pets.reload();
          toast(
            createdClient ? 'Cliente y mascota creados.' : 'Mascota guardada.',
          );
          navigate(`/pets/${pet.id}`);
        }}
      />
    </div>
  );
}

function PetCard({ pet, onClick }: { pet: PetWithClient; onClick: () => void }) {
  const percent = pet.completeness?.percent ?? 0;

  return (
    <button type="button" className="pet-card" onClick={onClick}>
      {pet.photoUrl ? (
        <img src={mediaUrl(pet.photoUrl) ?? undefined} alt={pet.name} className="pet-avatar" />
      ) : (
        <Avatar name={pet.name} size={44} />
      )}
      <span className="pet-card-body">
        <strong>{pet.name}</strong>
        <span>
          {SPECIES_LABELS[pet.species] ?? pet.species}
          {pet.breed ? ` · ${pet.breed}` : ''}
          {pet.sizeLabel ? ` · ${pet.sizeLabel}` : ''}
        </span>
        <em>{pet.clientName ?? 'Sin propietario'}</em>
      </span>
      <span className={`completeness-badge ${percent < 50 ? 'is-low' : percent < 80 ? 'is-mid' : 'is-high'}`}>
        {percent} %
      </span>
      <Icon name="right" size={18} />
    </button>
  );
}

type QualityGroup =
  | 'contactsWithoutClient'
  | 'clientsWithoutName'
  | 'contactsWithoutPets'
  | 'petsWithoutPhoto'
  | 'petsIncomplete'
  | 'allPets';

function QualityItem({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: number | string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`quality-item ${active ? 'is-active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <strong>{value}</strong>
      <span>{label}</span>
    </button>
  );
}

function QualityDetails({
  group,
  summary,
  onClose,
}: {
  group: QualityGroup;
  summary: DataQualitySummary;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const titles: Record<QualityGroup, string> = {
    contactsWithoutClient: 'Contactos sin ficha',
    clientsWithoutName: 'Clientes sin nombre',
    contactsWithoutPets: 'Contactos sin mascotas',
    petsWithoutPhoto: 'Mascotas sin foto',
    petsIncomplete: 'Mascotas incompletas',
    allPets: 'Todas las mascotas por completitud',
  };

  let content: React.ReactNode;
  if (group === 'contactsWithoutClient') {
    content = summary.details.contactsWithoutClient.length === 0 ? (
      <p className="muted small">No hay contactos pendientes.</p>
    ) : (
      summary.details.contactsWithoutClient.map((contact) => (
        <button
          type="button"
          className="quality-detail-row"
          key={contact.conversationId}
          onClick={() =>
            navigate(`/inbox?contact=${encodeURIComponent(contact.contactKey)}`)
          }
        >
          <span className="empty-icon" style={{ width: 34, height: 34 }}>
            <Icon name="chat" size={16} />
          </span>
          <span className="grow">
            <strong>{contact.contactName ?? 'Contacto sin ficha'}</strong>
            <span className="muted small">
              {contact.phone ? prettyPhone(contact.phone) : contact.contactKey}
            </span>
          </span>
          <Icon name="right" size={16} />
        </button>
      ))
    );
  } else if (
    group === 'clientsWithoutName' ||
    group === 'contactsWithoutPets'
  ) {
    const rows =
      group === 'clientsWithoutName'
        ? summary.details.clientsWithoutName
        : summary.details.contactsWithoutPets;
    content = rows.length === 0 ? (
      <p className="muted small">No hay clientes pendientes.</p>
    ) : (
      rows.map((client) => (
        <button
          type="button"
          className="quality-detail-row"
          key={client.id}
          onClick={() => navigate(`/clients/${client.id}`)}
        >
          <span className="empty-icon" style={{ width: 34, height: 34 }}>
            <Icon name="users" size={16} />
          </span>
          <span className="grow">
            <strong>{client.fullName ?? 'Cliente sin nombre'}</strong>
            <span className="muted small">
              {client.phone ? prettyPhone(client.phone) : 'Sin teléfono'}
            </span>
          </span>
          <Icon name="right" size={16} />
        </button>
      ))
    );
  } else {
    const rows =
      group === 'petsWithoutPhoto'
        ? summary.details.petsWithoutPhoto
        : group === 'petsIncomplete'
          ? summary.details.petsIncomplete
          : summary.details.allPets;
    content = rows.length === 0 ? (
      <p className="muted small">No hay mascotas pendientes.</p>
    ) : (
      rows.map((pet) => (
        <button
          type="button"
          className="quality-detail-row"
          key={pet.id}
          onClick={() => navigate(`/pets/${pet.id}`)}
        >
          <span className="empty-icon" style={{ width: 34, height: 34 }}>
            <Icon name="paw" size={16} />
          </span>
          <span className="grow">
            <strong>{pet.name}</strong>
            <span className="muted small">
              {pet.clientName ?? 'Sin propietario'}
            </span>
          </span>
          <span className="completeness-badge is-mid">{pet.percent} %</span>
          <Icon name="right" size={16} />
        </button>
      ))
    );
  }

  return (
    <div className="quality-details">
      <div className="quality-details-head">
        <strong>{titles[group]}</strong>
        <Button variant="subtle" icon="close" onClick={onClose} aria-label="Cerrar detalle" />
      </div>
      {content}
    </div>
  );
}
