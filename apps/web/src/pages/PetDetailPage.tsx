import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, mediaUrl } from '../api/client';
import type { Pet } from '../api/types';
import { useAsync } from '../api/useAsync';
import { Icon } from '../components/Icon';
import {
  Avatar,
  Badge,
  Button,
  Confirm,
  EmptyState,
  Spinner,
  useToast,
} from '../components/ui';
import { formatPetAge } from '../lib/age';
import { durationMinutes, humanDuration, localTime, shortDate } from '../lib/date';
import {
  formatCop,
  prettyPhone,
  SIZE_LABELS,
  SPECIES_LABELS,
  stampLocal,
  STATUS_LABELS,
} from '../lib/format';
import { PetPhotoModal } from '../components/PetPhotoModal';
import { PetEditor } from './PetEditor';

export function PetDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedFrom = searchParams.get('from');
  const backTo =
    requestedFrom && requestedFrom.startsWith('/') && !requestedFrom.startsWith('//')
      ? requestedFrom
      : '/';
  const backLabel = backTo.startsWith('/clients') ? 'Clientes' : 'Mascotas';
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [focusField, setFocusField] = useState<string | null>(null);
  const [flagBusy, setFlagBusy] = useState<string | null>(null);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const history = useAsync(() => api.pets.history(String(id)), [id]);
  const clients = useAsync(() => api.clients.list(), []);

  const data = history.data?.data ?? null;

  const timeline = useMemo(() => data?.timeline ?? [], [data]);

  function readFlags(): { unknown: string[]; na: string[] } {
    try {
      const raw = (data?.pet as { profileFlagsJson?: string | null } | undefined)
        ?.profileFlagsJson;
      if (!raw) return { unknown: [], na: [] };
      const parsed = JSON.parse(raw) as { unknown?: string[]; na?: string[] };
      return {
        unknown: Array.isArray(parsed.unknown) ? parsed.unknown : [],
        na: Array.isArray(parsed.na) ? parsed.na : [],
      };
    } catch {
      return { unknown: [], na: [] };
    }
  }

  async function toggleFlag(key: string, mode: 'unknown' | 'na') {
    if (!data) return;
    setFlagBusy(key);

    const flags = readFlags();
    const other = mode === 'unknown' ? 'na' : 'unknown';
    const list = flags[mode];

    const next = {
      unknown: mode === 'unknown'
        ? list.includes(key)
          ? list.filter((entry) => entry !== key)
          : [...list, key]
        : flags.unknown.filter((entry) => entry !== key),
      na: mode === 'na'
        ? list.includes(key)
          ? list.filter((entry) => entry !== key)
          : [...list, key]
        : flags.na.filter((entry) => entry !== key),
    };

    try {
      await api.pets.update(data.pet.id, { profileFlags: next });
      history.reload();
      toast(next.na.includes(key) || next.unknown.includes(key)
        ? 'Campo marcado.'
        : 'Marca retirada.');
    } catch {
      toast('No se pudo actualizar la marca.', 'error');
    } finally {
      setFlagBusy(null);
    }
  }

  async function removePet() {
    if (!data) return;
    setBusy(true);
    try {
      await api.pets.remove(data.pet.id);
      toast('Mascota eliminada.');
      navigate('/');
    } catch {
      toast('No se pudo eliminar la mascota.', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (history.loading) {
    return (
      <div className="card card-pad">
        <Spinner label="Cargando ficha…" />
      </div>
    );
  }

  if (history.error || !data) {
    return (
      <EmptyState
        icon="alert"
        title="No se encontró la mascota"
        hint={history.error?.message}
        action={<Button onClick={() => navigate(backTo)}>Volver a {backLabel.toLowerCase()}</Button>}
      />
    );
  }

  const { pet, client, stats } = data;

  return (
    <div className="col" style={{ gap: 18 }}>
      <Link to={backTo} className="row muted small" style={{ gap: 6 }}>
        <Icon name="back" size={16} /> {backLabel}
      </Link>

      <header className="pet-header card">
        <button
          type="button"
          className="pet-photo-button"
          onClick={() => setPhotoOpen(true)}
          aria-label={pet.photoUrl ? 'Cambiar fotografía' : 'Añadir fotografía'}
          title={pet.photoUrl ? 'Cambiar fotografía' : 'Añadir fotografía'}
        >
          {pet.photoUrl ? (
            <img
              src={mediaUrl(pet.photoUrl) ?? undefined}
              alt={pet.name}
              className="pet-avatar pet-avatar-lg"
            />
          ) : (
            <Avatar name={pet.name} size={58} />
          )}
          <span className="pet-photo-hint">
            <Icon name="plus" size={12} />
          </span>
        </button>
        <div className="grow">
          <h1>{pet.name}</h1>
          <p className="muted small">
            {SPECIES_LABELS[pet.species] ?? pet.species}
            {pet.breed ? ` · ${pet.breed}` : ''}
            {pet.sex ? ` · ${pet.sex === 'macho' ? 'Macho' : 'Hembra'}` : ''}
            {pet.weightKg ? ` · ${pet.weightKg} kg` : ''}
            {pet.size ? ` · ${SIZE_LABELS[pet.size]}` : ''}
            {pet.ageYears != null ? ` · ${formatPetAge(pet.ageYears)}` : ''}
          </p>
          <Link to={`/clients/${client.id}`} className="owner-link">
            <Icon name="users" size={15} />
            {client.name ?? 'Propietario'}
            {client.phone ? ` · ${prettyPhone(client.phone)}` : ''}
          </Link>
        </div>
        <div className="pet-header-actions">
          <Button variant="subtle" icon="trash" onClick={() => setConfirmDelete(true)} aria-label="Eliminar mascota" />
          <Button onClick={() => setPhotoOpen(true)}>
            {pet.photoUrl ? 'Cambiar foto' : 'Añadir foto'}
          </Button>
          <Button onClick={() => setEditing(true)}>Editar</Button>
        </div>
      </header>

      <div className="quick-actions">
        <Button
          variant="primary"
          icon="tag"
          onClick={() => navigate(`/sales/new?petId=${pet.id}&clientId=${client.id}`)}
        >
          Registrar venta
        </Button>
        <Button
          icon="calendar"
          onClick={() =>
            navigate(
              `/agenda?petId=${pet.id}&new=1&from=${encodeURIComponent(`/pets/${pet.id}`)}`,
            )
          }
        >
          Nueva cita
        </Button>
        <Button icon="users" onClick={() => navigate(`/clients/${client.id}`)}>
          Ver propietario
        </Button>
        <Button
          icon="clock"
          onClick={() =>
            document.getElementById('historial')?.scrollIntoView({ behavior: 'smooth' })
          }
        >
          Ver historial
        </Button>
      </div>

      <section className="card card-pad completeness-card">
        <div className="row-between">
          <h2 className="section-title">Completitud del perfil</h2>
          <strong className="completeness-value">{data.completeness.percent} %</strong>
        </div>
        <div className="progress" aria-hidden="true">
          <span style={{ width: `${data.completeness.percent}%` }} />
        </div>
        <p className="muted small">
          {data.completeness.applicable} puntos aplicables ·{' '}
          {data.completeness.earned} conseguidos
          {data.completeness.notApplicable.length > 0
            ? ` · ${data.completeness.notApplicable.length} campo(s) no aplican`
            : ''}
        </p>

        {data.completeness.priorities.length === 0 ? (
          <p className="small" style={{ color: 'var(--ok)', fontWeight: 600 }}>
            Perfil completo.
          </p>
        ) : (
          <div className="missing-list">
            {data.completeness.priorities.map((field) => (
              <div className="missing-row" key={field.key}>
                <button
                  type="button"
                  className={`missing-chip ${field.status === 'pending' ? 'is-pending' : ''}`}
                  onClick={() => {
                    setFocusField(field.key);
                    setEditing(true);
                  }}
                >
                  {field.status === 'pending' ? 'Pendiente: ' : ''}
                  {field.action}
                  <span>{field.weight} pts</span>
                </button>
                {field.key !== 'name' && field.key !== 'species' ? (
                  <>
                    <button
                      type="button"
                      className="flag-action"
                      disabled={flagBusy === field.key}
                      onClick={() => toggleFlag(field.key, 'unknown')}
                      title="No lo sabemos"
                    >
                      No lo sé
                    </button>
                    <button
                      type="button"
                      className="flag-action"
                      disabled={flagBusy === field.key}
                      onClick={() => toggleFlag(field.key, 'na')}
                      title="No aplica a esta mascota"
                    >
                      No aplica
                    </button>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {data.completeness.unknown.length > 0 ? (
          <div className="flag-section">
            <span className="section-title">Pendiente por confirmar</span>
            <div className="flag-list">
              {data.completeness.unknown.map((key) => {
                const field = data.completeness.fields.find(
                  (entry) => entry.key === key,
                );
                return (
                  <div className="flag-row" key={`unknown-${key}`}>
                    <span className="flag-name">{field?.label ?? key}</span>
                    <button
                      type="button"
                      className="flag-action"
                      onClick={() => {
                        setFocusField(key);
                        setEditing(true);
                      }}
                    >
                      Confirmar
                    </button>
                    <button
                      type="button"
                      className="flag-action"
                      onClick={() => toggleFlag(key, 'unknown')}
                      title="Quitar la marca sin confirmar"
                    >
                      Quitar marca
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {data.completeness.notApplicable.length > 0 ? (
          <div className="flag-section">
            <span className="section-title">No aplica</span>
            <div className="flag-list">
              {data.completeness.notApplicable.map((key) => {
                const field = data.completeness.fields.find(
                  (entry) => entry.key === key,
                );
                return (
                  <button
                    key={`na-${key}`}
                    type="button"
                    className="flag-chip"
                    onClick={() => toggleFlag(key, 'na')}
                    title="Quitar marca"
                  >
                    {field?.label ?? key}
                    <span>no aplica</span>
                    <Icon name="close" size={12} />
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </section>

      <section className="stat-grid">
        <Stat
          label="Gastado en total"
          value={formatCop(stats.totalSpentCents)}
          hint={`${stats.salesCount} venta${stats.salesCount === 1 ? '' : 's'}`}
        />
        <Stat
          label="Último servicio"
          value={stats.lastServiceName ?? 'Sin servicios'}
          hint={
            stats.lastServiceAt
              ? stampLocal(stats.lastServiceAt)
              : 'Aún no se le ha cobrado nada'
          }
        />
        <Stat
          label="Servicios"
          value={String(stats.servicesCount)}
          hint={`${stats.productsCount} artículo${stats.productsCount === 1 ? '' : 's'} vendidos`}
        />
        <Stat
          label="Citas"
          value={String(stats.visitsCount)}
          hint={`${stats.upcomingCount} próxima${stats.upcomingCount === 1 ? '' : 's'}`}
        />
      </section>

      {pet.allergies || pet.temperament ? (
        <section className="card card-pad">
          <h2 className="section-title" style={{ marginBottom: 8 }}>
            Observaciones
          </h2>
          {pet.allergies ? (
            <p className="small" style={{ marginBottom: 4 }}>
              <strong>Alergias:</strong> {pet.allergies}
            </p>
          ) : null}
          {pet.temperament ? (
            <p className="small">
              <strong>Temperamento:</strong> {pet.temperament}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="card" id="historial">
        <div className="card-head">
          <h2>Historial</h2>
          <Button variant="subtle" icon="refresh" onClick={history.reload}>
            Actualizar
          </Button>
        </div>
        <div className="card-pad">
          {timeline.length === 0 ? (
            <EmptyState
              icon="clock"
              title="Sin historial todavía"
              hint="Cuando registres una venta o una cita, aparecerá aquí."
              action={
                <Button
                  variant="primary"
                  icon="tag"
                  onClick={() =>
                    navigate(`/sales/new?petId=${pet.id}&clientId=${client.id}`)
                  }
                >
                  Registrar venta
                </Button>
              }
            />
          ) : (
            <ol className="timeline">
              {timeline.map((entry) => (
                <li key={`${entry.type}-${entry.id}`} className={`timeline-item is-${entry.type}`}>
                  <span className="timeline-dot">
                    <Icon
                      name={
                        entry.type === 'service'
                          ? 'sparkle'
                          : entry.type === 'product'
                            ? 'box'
                            : entry.type === 'appointment'
                              ? 'calendar'
                              : entry.type === 'health'
                                ? 'alert'
                                : 'tag'
                      }
                      size={14}
                    />
                  </span>
                  <div className="grow">
                    <div className="row-between" style={{ gap: 8 }}>
                      <strong className="small">{entry.title}</strong>
                      {entry.amountCents !== null ? (
                        <span className="price small">{formatCop(entry.amountCents)}</span>
                      ) : null}
                    </div>
                    <span className="muted small">
                      {stampLocal(entry.at)}
                      {entry.type === 'appointment' && entry.status
                        ? ` · ${STATUS_LABELS[entry.status] ?? entry.status}`
                        : ''}
                      {entry.type === 'product' ? ' · artículo' : ''}
                    </span>
                    {entry.detail ? (
                      <p className="small" style={{ marginTop: 2 }}>
                        {entry.detail}
                      </p>
                    ) : null}
                    {entry.saleId ? (
                      <Link to={`/sales/${entry.saleId}`} className="small link">
                        Ver venta
                      </Link>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Citas</h2>
          <Badge tone={stats.upcomingCount > 0 ? 'accent' : 'neutral'}>
            {stats.upcomingCount} próxima{stats.upcomingCount === 1 ? '' : 's'}
          </Badge>
        </div>
        <div className="list">
          {data.appointments.length === 0 ? (
            <p className="muted small" style={{ padding: 16 }}>
              Sin citas registradas.
            </p>
          ) : (
            data.appointments.slice(0, 12).map((appointment) => (
              <div className="list-item" key={appointment.id} style={{ cursor: 'default' }}>
                <span className="empty-icon" style={{ width: 38, height: 38 }}>
                  <Icon name="calendar" size={17} />
                </span>
                <div className="list-item-body">
                  <strong>
                    {shortDate(appointment.startsAtLocal.slice(0, 10))} ·{' '}
                    {localTime(appointment.startsAtLocal)}–
                    {localTime(appointment.endsAtLocal)}
                  </strong>
                  <span>
                    {humanDuration(
                      Math.max(
                        15,
                        durationMinutes(
                          appointment.startsAtLocal,
                          appointment.endsAtLocal,
                        ),
                      ),
                    )}
                    {appointment.notes ? ` · ${appointment.notes}` : ''}
                  </span>
                </div>
                <Badge
                  tone={
                    appointment.status === 'cancelled'
                      ? 'neutral'
                      : appointment.status === 'done'
                        ? 'ok'
                        : 'accent'
                  }
                >
                  {STATUS_LABELS[appointment.status] ?? appointment.status}
                </Badge>
              </div>
            ))
          )}
        </div>
      </section>

      <PetEditor
        open={editing}
        pet={pet as Pet}
        clients={clients.data?.data ?? []}
        focusField={focusField}
        onClose={() => {
          setEditing(false);
          setFocusField(null);
        }}
        onSaved={() => {
          setEditing(false);
          history.reload();
          toast('Mascota actualizada.');
        }}
      />

      <PetPhotoModal
        open={photoOpen}
        petId={pet.id}
        petName={pet.name}
        hasPhoto={Boolean(pet.photoUrl)}
        onClose={() => setPhotoOpen(false)}
        onSaved={() => {
          setPhotoOpen(false);
          history.reload();
        }}
      />

      <Confirm
        open={confirmDelete}
        title="Eliminar mascota"
        message={`${pet.name} dejará de aparecer en la lista. Sus ventas y citas se conservan en el historial del negocio.`}
        confirmLabel="Eliminar"
        busy={busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={removePet}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      <span className="stat-hint">{hint}</span>
    </div>
  );
}
