import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type {
  Appointment,
  AppointmentStatus,
  Client,
  Pet,
  Warning,
} from '../api/types';
import { Icon } from '../components/Icon';
import {
  Button,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from '../components/ui';
import {
  durationMinutes,
  humanDuration,
  localDayOf,
  localTime,
  minutesOfDay,
  minutesToTime,
  timeToMinutes,
} from '../lib/date';
import { overlapsWith } from '../lib/agenda';
import { newIdempotencyKey } from '../lib/id';
import { STATUS_LABELS } from '../lib/format';

const DURATIONS = [30, 45, 60, 90, 120];
const STATUSES: AppointmentStatus[] = [
  'scheduled',
  'confirmed',
  'in_progress',
  'done',
  'no_show',
  'cancelled',
];

export type EditorTarget = {
  appointment: Appointment | null;
  date: string;
  time: string;
  /** Mascota preseleccionada (al llegar desde su ficha). */
  petId?: string;
  clientId?: number;
  notes?: string;
};

type Props = {
  target: EditorTarget | null;
  clients: Client[];
  pets: Pet[];
  dayAppointments: Appointment[];
  onClose: () => void;
  onSaved: (message: string, warnings: Warning[], saved: Appointment) => void;
};

export function AppointmentEditor({
  target,
  clients,
  pets,
  dayAppointments,
  onClose,
  onSaved,
}: Props) {
  const navigate = useNavigate();
  const idempotencyKey = useRef('');

  const [clientId, setClientId] = useState<number | ''>('');
  const [petId, setPetId] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('09:00');
  const [duration, setDuration] = useState(60);
  const [status, setStatus] = useState<AppointmentStatus>('scheduled');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appointment = target?.appointment ?? null;

  useEffect(() => {
    if (!target) return;
    idempotencyKey.current = newIdempotencyKey();
    setError(null);
    setBusy(false);

    if (appointment) {
      const minutes = durationMinutes(
        appointment.startsAtLocal,
        appointment.endsAtLocal,
      );
      setClientId(appointment.clientId);
      setPetId(appointment.petId);
      setDate(localDayOf(appointment.startsAtLocal));
      setTime(localTime(appointment.startsAtLocal));
      setDuration(minutes > 0 ? minutes : 60);
      setStatus(appointment.status);
      setNotes(appointment.notes ?? '');
      return;
    }

    setClientId(target.clientId ?? '');
    setPetId(target.petId ?? '');
    setDate(target.date);
    setTime(target.time);
    setDuration(60);
    setStatus('scheduled');
    setNotes(target.notes ?? '');
  }, [target, appointment]);

  const clientPets = useMemo(
    () => pets.filter((pet) => pet.clientId === clientId),
    [pets, clientId],
  );

  // Si el cliente tiene una sola mascota, se elige sola.
  useEffect(() => {
    if (!target || appointment) return;
    if (target.petId) return;
    if (clientPets.length === 1 && petId !== clientPets[0]?.id) {
      setPetId(clientPets[0]?.id ?? '');
    }
    if (clientPets.length === 0) setPetId('');
  }, [clientPets, appointment, target, petId]);

  // Cruces en vivo con las citas ya cargadas del día. Solo informan.
  const liveConflicts = useMemo(() => {
    if (!target || !date || !time) return [];
    const start = timeToMinutes(time);
    const end = start + duration;

    const others = dayAppointments
      .filter((item) => localDayOf(item.startsAtLocal) === date)
      .filter((item) => item.id !== appointment?.id)
      .filter((item) => item.status !== 'cancelled')
      .map((item) => ({
        id: item.id,
        start: minutesOfDay(item.startsAtLocal),
        end: minutesOfDay(item.startsAtLocal) +
          Math.max(15, durationMinutes(item.startsAtLocal, item.endsAtLocal)),
      }));

    return overlapsWith({ start, end }, others);
  }, [target, date, time, duration, dayAppointments, appointment?.id]);

  function petLabel(petId: string): string {
    const pet = pets.find((item) => item.id === petId);
    if (!pet) return 'otra mascota';
    const owner = clients.find((client) => client.id === pet.clientId);
    return owner?.fullName ? `${pet.name} de ${owner.fullName}` : pet.name;
  }

  async function save() {
    if (!petId) {
      setError('Elige una mascota.');
      return;
    }

    setBusy(true);
    setError(null);

    const payload = {
      petId,
      startsAt: `${date}T${time}`,
      durationMin: duration,
      notes: notes.trim() === '' ? null : notes.trim(),
    };

    try {
      if (appointment) {
        const result = await api.appointments.update(
          appointment.id,
          { ...payload, status },
          idempotencyKey.current,
        );
        onSaved('Cita actualizada.', result.warnings ?? [], result.data);
      } else {
        const result = await api.appointments.create(
          payload,
          idempotencyKey.current,
        );
        onSaved('Cita creada.', result.warnings ?? [], result.data);
      }
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'No se pudo guardar la cita.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function cancelAppointment() {
    if (!appointment) return;
    setBusy(true);
    try {
      await api.appointments.cancel(appointment.id);
      onSaved('Cita cancelada.', [], {
        ...appointment,
        status: 'cancelled',
      });
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'No se pudo cancelar.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function reactivate() {
    if (!appointment) return;
    setBusy(true);
    try {
      const result = await api.appointments.reactivate(appointment.id);
      onSaved('Cita reactivada.', result.warnings ?? [], result.data);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'No se pudo reactivar.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!target) return null;

  const totalOverlap = liveConflicts.reduce((sum, item) => sum + item.minutes, 0);

  return (
    <Modal
      open
      wide
      title={appointment ? 'Editar cita' : 'Nueva cita'}
      subtitle={
        appointment
          ? `${STATUS_LABELS[appointment.status] ?? appointment.status} · ${localTime(
              appointment.startsAtLocal,
            )}–${localTime(appointment.endsAtLocal)}`
          : 'Se guarda al confirmar. Nada te bloquea.'
      }
      onClose={onClose}
      footer={
        <>
          {appointment && appointment.status !== 'cancelled' ? (
            <Button variant="danger" onClick={cancelAppointment} disabled={busy}>
              Cancelar cita
            </Button>
          ) : null}
          {appointment && appointment.status === 'cancelled' ? (
            <Button variant="primary" onClick={reactivate} disabled={busy}>
              Reactivar
            </Button>
          ) : null}
          {appointment ? (
            <Button
              icon="tag"
              onClick={() =>
                navigate(
                  `/sales/new?petId=${appointment.petId}&clientId=${appointment.clientId}&appointmentId=${appointment.id}`,
                )
              }
              disabled={busy}
            >
              Registrar venta
            </Button>
          ) : null}
          <span className="grow" />
          <Button onClick={onClose} disabled={busy}>
            Cerrar
          </Button>
          <Button variant="primary" onClick={save} loading={busy}>
            Guardar
          </Button>
        </>
      }
    >
      {error ? <div className="login-error" style={{ marginBottom: 14 }}>{error}</div> : null}

      {clients.length === 0 ? (
        <div className="warn-item info" style={{ marginBottom: 14 }}>
          <Icon name="alert" size={16} />
          <span>
            Todavía no hay clientes. Crea uno en la sección Clientes y vuelve
            aquí.
          </span>
        </div>
      ) : null}

      <div className="form-grid">
        <Field label="Cliente">
          <Select
            value={clientId}
            onChange={(event) => {
              const value = event.target.value;
              setClientId(value === '' ? '' : Number(value));
              setPetId('');
            }}
          >
            <option value="">Elige un cliente…</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.fullName ?? `Cliente ${client.id}`}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Mascota"
          hint={
            clientId === '' || clientPets.length === 0
              ? 'Elige primero un cliente con mascotas'
              : undefined
          }
        >
          <Select
            value={petId}
            onChange={(event) => setPetId(event.target.value)}
            disabled={clientPets.length === 0}
          >
            <option value="">Elige una mascota…</option>
            {clientPets.map((pet) => (
              <option key={pet.id} value={pet.id}>
                {pet.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Fecha">
          <Input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </Field>

        <Field label="Hora de inicio">
          <Input
            type="time"
            step={900}
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        </Field>

        <div className="span-2">
          <div className="field">
            <span className="field-label">Duración</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {DURATIONS.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  className={`btn btn-sm ${duration === minutes ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setDuration(minutes)}
                >
                  {humanDuration(minutes)}
                </button>
              ))}
              <Input
                type="number"
                min={5}
                max={480}
                step={5}
                value={duration}
                onChange={(event) => setDuration(Number(event.target.value) || 5)}
                style={{ width: 96 }}
                aria-label="Duración en minutos"
              />
            </div>
            <span className="field-hint">
              Termina a las{' '}
              {minutesToTime((timeToMinutes(time) + duration) % 1440)}
            </span>
          </div>
        </div>

        {appointment ? (
          <Field label="Estado">
            <Select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as AppointmentStatus)
              }
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <div className={appointment ? '' : 'span-2'}>
          <Field label="Notas">
            <Textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Alergias, preferencias, lo que quieras recordar…"
            />
          </Field>
        </div>
      </div>

      {liveConflicts.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <div className="row" style={{ gap: 7, color: 'var(--warn)' }}>
            <Icon name="alert" size={16} />
            <strong style={{ fontSize: 13 }}>
              Se cruza {totalOverlap} min con {liveConflicts.length}{' '}
              {liveConflicts.length === 1 ? 'cita' : 'citas'}
            </strong>
          </div>
          <div className="warn-list">
            {liveConflicts.map((conflict) => (
              <div className="warn-item" key={conflict.id}>
                <Icon name="alert" size={15} />
                <span>
                  {petLabel(conflict.id)} · {conflict.minutes} min de cruce.
                  Puedes guardar igual.
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
