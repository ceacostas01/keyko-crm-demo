import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Appointment, AppointmentRequest, Client, Pet } from '../api/types';
import { useAsync } from '../api/useAsync';
import { Icon } from '../components/Icon';
import { Badge, Button, EmptyState, Spinner, useToast } from '../components/ui';
import { assignLanes } from '../lib/agenda';
import {
  addDays,
  dayNumber,
  durationMinutes,
  humanDuration,
  isToday,
  localDayOf,
  localTime,
  longDate,
  minutesOfDay,
  shortDate,
  startOfWeek,
  today,
  weekDays,
  weekdayShort,
} from '../lib/date';
import { dayLabel, STATUS_LABELS } from '../lib/format';
import {
  AppointmentEditor,
  type EditorTarget,
} from './AppointmentEditor';

const HOUR_PX = 64;
const MIN_HOUR = 6;
const MAX_HOUR = 23;

export function AgendaPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  /** Si la cita se abrió desde una mascota, al cerrar se vuelve allí. */
  const returnTo = useRef<string | null>(null);
  const [view, setView] = useState<'day' | 'week'>('day');
  const [anchor, setAnchor] = useState(today());
  const [target, setTarget] = useState<EditorTarget | null>(null);
  const [pendingRequest, setPendingRequest] = useState<AppointmentRequest | null>(
    null,
  );

  const range = useMemo(() => {
    if (view === 'day') return { from: anchor, to: anchor };
    const start = startOfWeek(anchor);
    return { from: start, to: addDays(start, 6) };
  }, [view, anchor]);

  const appointments = useAsync(
    () => api.appointments.list(range.from, range.to),
    [range.from, range.to],
  );
  const requests = useAsync(
    () => api.appointmentRequests.list({ status: 'pending' }),
    [],
  );
  const clients = useAsync(() => api.clients.list(), []);
  const pets = useAsync(() => api.pets.list(), []);

  const rows = appointments.data?.data ?? [];
  const clientList = clients.data?.data ?? [];
  const petList = pets.data?.data ?? [];

  const requestRows = requests.data?.data ?? [];
  const petById = useMemo(
    () => new Map(petList.map((pet) => [pet.id, pet])),
    [petList],
  );
  const clientById = useMemo(
    () => new Map(clientList.map((client) => [client.id, client])),
    [clientList],
  );

  function petName(petId: string): string {
    return petById.get(petId)?.name ?? 'Mascota';
  }

  function clientName(clientId: number): string {
    return clientById.get(clientId)?.fullName ?? 'Cliente';
  }

  const dayRows = rows.filter((row) => localDayOf(row.startsAtLocal) === anchor);

  function openNew(date: string, time: string) {
    setPendingRequest(null);
    setTarget({ appointment: null, date, time });
  }

  function openEdit(appointment: Appointment) {
    setPendingRequest(null);
    setTarget({
      appointment,
      date: localDayOf(appointment.startsAtLocal),
      time: localTime(appointment.startsAtLocal),
    });
  }

  function openRequest(request: AppointmentRequest) {
    setPendingRequest(request);
    const [date = today(), time = '09:00'] = request.startsAtLocal
      ? [request.startsAtLocal.slice(0, 10), request.startsAtLocal.slice(11, 16)]
      : [];
    const details = [
      request.requestedService
        ? `Servicio solicitado: ${request.requestedService}`
        : null,
      request.requestedDate ? `Fecha solicitada: ${request.requestedDate}` : null,
      request.requestedTime ? `Hora solicitada: ${request.requestedTime}` : null,
      request.notes ?? null,
    ]
      .filter(Boolean)
      .join('\n');
    setTarget({
      appointment: null,
      date,
      time,
      ...(request.clientId ? { clientId: request.clientId } : {}),
      ...(request.petId ? { petId: request.petId } : {}),
      ...(details ? { notes: details } : {}),
    });
  }

  async function discardRequest(request: AppointmentRequest) {
    try {
      await api.appointmentRequests.update(request.id, { status: 'discarded' });
      requests.reload();
      toast('Solicitud descartada.');
    } catch {
      toast('No se pudo descartar la solicitud.', 'error');
    }
  }

  function shift(amount: number) {
    setAnchor((current) => addDays(current, view === 'day' ? amount : amount * 7));
  }

  async function handleSaved(
    message: string,
    warningsCount: number,
    saved: Appointment,
  ) {
    setTarget(null);

    // Si veníamos de una mascota, se vuelve a su ficha.
    if (returnTo.current) {
      leaveToOrigin();
    }

    // Si la cita se movió a otro día, la agenda salta allí para no perderla.
    setAnchor(localDayOf(saved.startsAtLocal));
    appointments.reload();
    if (pendingRequest) {
      try {
        await api.appointmentRequests.update(pendingRequest.id, {
          status: saved.status === 'confirmed' ? 'confirmed' : 'scheduled',
          appointmentId: saved.id,
          clientId: saved.clientId,
          petId: saved.petId,
        });
        requests.reload();
      } catch {
        toast('La cita se guardó, pero no se pudo vincular a la solicitud.', 'error');
      }
      setPendingRequest(null);
    }
    if (warningsCount > 0) {
      toast(
        `${message} Tiene ${warningsCount} aviso${warningsCount === 1 ? '' : 's'} de cruce.`,
        'warn',
      );
    } else {
      toast(message);
    }
  }

  // Llegada desde una mascota: abre el editor con ella ya elegida.
  useEffect(() => {
    const petId = searchParams.get('petId');
    if (searchParams.get('new') !== '1' || !petId || !pets.data) return;

    const pet = pets.data.data.find((row) => row.id === petId);
    if (!pet) return;

    const from = searchParams.get('from');
    returnTo.current = from && from.startsWith('/') ? from : null;

    setTarget({
      appointment: null,
      date: today(),
      time: '09:00',
      petId: pet.id,
      clientId: pet.clientId,
    });
    setSearchParams({}, { replace: true });
  }, [searchParams, pets.data, setSearchParams]);

  function leaveToOrigin() {
    const back = returnTo.current;
    returnTo.current = null;
    if (back) navigate(back);
  }

  function closeEditor() {
    setTarget(null);
    setPendingRequest(null);
    leaveToOrigin();
  }

  const busy = appointments.loading || clients.loading || pets.loading;

  return (
    <div>
      {requestRows.length > 0 ? (
        <section className="card requests-card">
          <div className="card-head">
            <h2>Solicitudes de cita</h2>
            <span className="muted small">
              {requestRows.length} pendiente{requestRows.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="list">
            {requestRows.map((request) => (
              <div className="list-item request-row" key={request.id}>
                <span className="empty-icon" style={{ width: 40, height: 40 }}>
                  <Icon name="calendar" size={18} />
                </span>
                <div className="list-item-body">
                  <strong>
                    {request.petName ??
                      request.clientName ??
                      `Contacto ${request.contactKey}`}
                  </strong>
                  <span>
                    {request.requestedService ?? 'Servicio sin especificar'}
                    {request.startsAtLocal
                      ? ` · ${dayLabel(request.startsAtLocal.slice(0, 10))} ${request.startsAtLocal.slice(11, 16)}`
                      : request.requestedDate
                        ? ` · ${request.requestedDate}${request.requestedTime ? ` ${request.requestedTime}` : ''}`
                        : ' · fecha por confirmar'}
                  </span>
                  <span className="small muted">
                    {request.clientId
                      ? request.clientName ?? 'Cliente sin nombre'
                      : 'Sin ficha de cliente'}
                    {request.appointmentId ? ' · cita vinculada' : ''}
                  </span>
                </div>
                <Badge tone="warn">Pendiente</Badge>
                <div className="row-actions">
                  <Button
                    variant="primary"
                    className="btn-sm"
                    onClick={() => openRequest(request)}
                  >
                    Agendar
                  </Button>
                  <Button
                    variant="subtle"
                    className="btn-sm"
                    onClick={() => discardRequest(request)}
                  >
                    Descartar
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="agenda-toolbar">
        <div className="date-nav">
          <Button variant="subtle" icon="left" onClick={() => shift(-1)} aria-label="Anterior" />
          <div className="date-label">
            <strong>
              {view === 'day'
                ? longDate(anchor)
                : `${shortDate(range.from)} – ${shortDate(range.to)}`}
            </strong>
            <span>
              {view === 'day'
                ? dayRows.length === 0
                  ? 'Sin citas'
                  : `${dayRows.length} cita${dayRows.length === 1 ? '' : 's'}`
                : `${rows.length} cita${rows.length === 1 ? '' : 's'} en la semana`}
            </span>
          </div>
          <Button variant="subtle" icon="right" onClick={() => shift(1)} aria-label="Siguiente" />
        </div>

        <Button onClick={() => setAnchor(today())} disabled={isToday(anchor)}>
          Hoy
        </Button>

        <div className="segmented" role="group" aria-label="Vista">
          <button
            type="button"
            aria-pressed={view === 'day'}
            onClick={() => setView('day')}
          >
            Día
          </button>
          <button
            type="button"
            aria-pressed={view === 'week'}
            onClick={() => setView('week')}
          >
            Semana
          </button>
        </div>

        <span className="grow" />

        <Button
          variant="primary"
          icon="plus"
          onClick={() => openNew(anchor, defaultTimeFor(dayRows))}
        >
          Nueva cita
        </Button>
      </div>

      {busy ? (
        <div className="card card-pad">
          <Spinner label="Cargando agenda…" />
        </div>
      ) : appointments.error ? (
        <EmptyState
          icon="alert"
          title="No se pudo cargar la agenda"
          hint={appointments.error.message}
          action={<Button onClick={appointments.reload}>Reintentar</Button>}
        />
      ) : view === 'day' ? (
        <DayView
          date={anchor}
          rows={dayRows}
          petName={petName}
          clientName={clientName}
          onCreate={(time) => openNew(anchor, time)}
          onEdit={openEdit}
        />
      ) : (
        <WeekView
          anchor={anchor}
          rows={rows}
          petName={petName}
          clientName={clientName}
          onPickDay={(date) => {
            setAnchor(date);
            setView('day');
          }}
          onCreate={(date) => openNew(date, '09:00')}
          onEdit={openEdit}
        />
      )}

      <AppointmentEditor
        target={target}
        clients={clientList}
        pets={petList}
        dayAppointments={rows}
        onClose={closeEditor}
        onSaved={(message, warnings, saved) => {
          handleSaved(message, warnings.length, saved);
        }}
      />
    </div>
  );
}

function defaultTimeFor(rows: Appointment[]): string {
  if (rows.length === 0) return '09:00';
  const last = [...rows]
    .map((row) => minutesOfDay(row.endsAtLocal))
    .sort((a, b) => b - a)[0];
  const minutes = last ?? 540;
  const rounded = Math.min(19 * 60, Math.ceil(minutes / 30) * 30);
  return `${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(
    rounded % 60,
  ).padStart(2, '0')}`;
}

type DayProps = {
  date: string;
  rows: Appointment[];
  petName: (id: string) => string;
  clientName: (id: number) => string;
  onCreate: (time: string) => void;
  onEdit: (appointment: Appointment) => void;
};

function DayView({ date, rows, petName, clientName, onCreate, onEdit }: DayProps) {
  const { startHour, endHour } = boundsFor(rows);
  const hours = Array.from(
    { length: endHour - startHour },
    (_, index) => startHour + index,
  );

  const lanes = assignLanes(
    rows.map((row) => {
      const start = minutesOfDay(row.startsAtLocal) - startHour * 60;
      const length = Math.max(15, durationMinutes(row.startsAtLocal, row.endsAtLocal));
      return { id: row.id, start, end: start + length };
    }),
  );

  return (
    <div className="day-grid" style={{ minHeight: hours.length * HOUR_PX }}>
      {hours.map((hour) => (
        <div className="hour-row" key={hour} style={{ height: HOUR_PX }}>
          <div className="hour-label">{`${String(hour).padStart(2, '0')}:00`}</div>
          <div
            className="hour-slot"
            onClick={() => onCreate(`${String(hour).padStart(2, '0')}:00`)}
            role="presentation"
          />
        </div>
      ))}

      <div className="day-layer">
        {rows.map((row) => {
          const placement = lanes.get(row.id) ?? { lane: 0, lanes: 1 };
          const start = minutesOfDay(row.startsAtLocal) - startHour * 60;
          const length = Math.max(15, durationMinutes(row.startsAtLocal, row.endsAtLocal));
          const hasWarning = (row.warnings?.length ?? 0) > 0;
          const width = 100 / placement.lanes;

          return (
            <button
              key={row.id}
              type="button"
              className={[
                'appt',
                hasWarning ? 'is-conflict' : '',
                row.status === 'cancelled' ? 'is-cancelled' : '',
                row.status === 'done' ? 'is-done' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{
                top: (start / 60) * HOUR_PX,
                height: Math.max(32, (length / 60) * HOUR_PX - 4),
                left: `calc(${placement.lane * width}% + 4px)`,
                width: `calc(${width}% - 8px)`,
              }}
              onClick={() => onEdit(row)}
              title={(row.warnings ?? []).map((warning) => warning.message).join(' · ')}
            >
              <strong>
                {localTime(row.startsAtLocal)} {petName(row.petId)}
              </strong>
              <span>{clientName(row.clientId)}</span>
              {hasWarning ? (
                <span className="appt-flag">
                  <Icon name="alert" size={13} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function boundsFor(rows: Appointment[]): { startHour: number; endHour: number } {
  if (rows.length === 0) return { startHour: 8, endHour: 19 };

  let min = 8;
  let max = 19;

  for (const row of rows) {
    const start = Math.floor(minutesOfDay(row.startsAtLocal) / 60);
    const end = Math.ceil(
      (minutesOfDay(row.startsAtLocal) +
        Math.max(15, durationMinutes(row.startsAtLocal, row.endsAtLocal))) /
        60,
    );
    min = Math.min(min, start);
    max = Math.max(max, end);
  }

  return {
    startHour: Math.max(MIN_HOUR, min - 1),
    endHour: Math.min(MAX_HOUR, max),
  };
}

type WeekProps = {
  anchor: string;
  rows: Appointment[];
  petName: (id: string) => string;
  clientName: (id: number) => string;
  onPickDay: (date: string) => void;
  onCreate: (date: string) => void;
  onEdit: (appointment: Appointment) => void;
};

function WeekView({
  anchor,
  rows,
  petName,
  clientName,
  onPickDay,
  onCreate,
  onEdit,
}: WeekProps) {
  const days = weekDays(anchor);

  return (
    <div className="week-board">
      {days.map((day) => {
        const dayRows = rows
          .filter((row) => localDayOf(row.startsAtLocal) === day)
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

        return (
          <div
            className={`week-col ${isToday(day) ? 'is-today' : ''}`}
            key={day}
          >
            <div className="week-col-head">
              <button type="button" onClick={() => onPickDay(day)}>
                <span className="week-day-name">{weekdayShort(day)}</span>
                <span className="week-day-num">{dayNumber(day)}</span>
              </button>
              <Button
                variant="subtle"
                icon="plus"
                className="btn-sm btn-icon"
                onClick={() => onCreate(day)}
                aria-label={`Nueva cita el ${day}`}
              />
            </div>

            <div className="week-col-list">
              {dayRows.length === 0 ? (
                <span className="week-empty">Sin citas</span>
              ) : (
                dayRows.map((row) => {
                  const hasWarning = (row.warnings?.length ?? 0) > 0;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      className={[
                        'week-chip',
                        hasWarning ? 'is-conflict' : '',
                        row.status === 'cancelled' ? 'is-cancelled' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => onEdit(row)}
                      title={(row.warnings ?? [])
                        .map((warning) => warning.message)
                        .join(' · ')}
                    >
                      <strong>
                        {localTime(row.startsAtLocal)} · {petName(row.petId)}
                      </strong>
                      <span>{clientName(row.clientId)}</span>
                      {hasWarning ? (
                        <span>
                          <Icon name="alert" size={11} /> cruce
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
