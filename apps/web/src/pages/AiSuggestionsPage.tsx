import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { AiSuggestion, AiSuggestionField } from '../api/types';
import { useAsync } from '../api/useAsync';
import { Icon } from '../components/Icon';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Spinner,
  useToast,
} from '../components/ui';
import { SPECIES_LABELS } from '../lib/format';

const KIND_LABELS: Record<string, string> = {
  client_create: 'Cliente nuevo',
  client_update: 'Actualizar cliente',
  pet_create: 'Mascota nueva',
  pet_update: 'Actualizar mascota',
  appointment_request: 'Solicitud de cita',
  availability_inquiry: 'Consulta de disponibilidad',
  service_inquiry: 'Consulta de servicio',
  conversation_note: 'Nota de conversación',
};

const REVIEW_ONLY: string[] = [
  'appointment_request',
  'availability_inquiry',
  'service_inquiry',
];

const KIND_TONES: Record<string, 'accent' | 'warn' | 'ok' | 'neutral'> = {
  client_create: 'accent',
  client_update: 'neutral',
  pet_create: 'accent',
  pet_update: 'neutral',
  appointment_request: 'warn',
  availability_inquiry: 'neutral',
  service_inquiry: 'neutral',
  conversation_note: 'neutral',
};

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

function prettyValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'number') return String(value);
  const text = String(value);
  return SPECIES_LABELS[text] ?? text;
}

export function AiSuggestionsPage() {
  const { toast } = useToast();
  const [processing, setProcessing] = useState(false);
  const [correcting, setCorrecting] = useState<AiSuggestion | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<'pending' | 'applied' | 'rejected'>(
    'pending',
  );

  const suggestions = useAsync(() => api.ai.suggestions(status), [status]);
  const usage = useAsync(() => api.ai.usage(), []);

  async function runProcessor() {
    setProcessing(true);
    try {
      const result = await api.ai.process();
      const data = result.data;

      if (!data.enabled) {
        toast('El procesamiento de IA está desactivado.', 'warn');
      } else if (data.reason === 'budget') {
        toast('Se alcanzó el presupuesto diario de IA.', 'warn');
      } else if (data.failed > 0 && data.processed === 0) {
        toast('No se pudo procesar. Revisa la configuración.', 'error');
      } else if (data.suggestions === 0 && data.applied === 0) {
        toast('No hay información nueva que extraer.');
      } else {
        toast(
          `${data.processed} lote(s): ${data.suggestions} sugerencia(s) y ${data.applied} aplicación(es) automáticas.`,
        );
      }

      suggestions.reload();
      usage.reload();
    } catch (cause) {
      toast(
        cause instanceof ApiError ? cause.message : 'No se pudo procesar.',
        'error',
      );
    } finally {
      setProcessing(false);
    }
  }

  async function accept(suggestion: AiSuggestion) {
    setBusyId(suggestion.id);
    try {
      await api.ai.accept(suggestion.id, {});
      toast('Sugerencia aplicada.');
      suggestions.reload();
      usage.reload();
    } catch (cause) {
      toast(
        cause instanceof ApiError ? cause.message : 'No se pudo aplicar.',
        'error',
      );
    } finally {
      setBusyId(null);
    }
  }

  async function reject(suggestion: AiSuggestion) {
    setBusyId(suggestion.id);
    try {
      await api.ai.reject(suggestion.id);
      toast('Sugerencia descartada.');
      suggestions.reload();
      usage.reload();
    } catch (cause) {
      toast(
        cause instanceof ApiError ? cause.message : 'No se pudo descartar.',
        'error',
      );
    } finally {
      setBusyId(null);
    }
  }

  const rows = suggestions.data?.data ?? [];
  const stats = usage.data?.data ?? null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Sugerencias de IA</h1>
          <p>
            Información extraída de WhatsApp. Nada se aplica sin tu revisión
            cuando es ambiguo.
          </p>
        </div>
        <Button
          variant="primary"
          icon="sparkle"
          onClick={runProcessor}
          loading={processing}
        >
          Procesar mensajes
        </Button>
      </div>

      <div className="tabs section-tabs" role="tablist" style={{ marginBottom: 14 }}>
        {(
          [
            ['pending', 'Pendientes'],
            ['applied', 'Aplicadas'],
            ['rejected', 'Descartadas'],
          ] as Array<[typeof status, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={status === value}
            onClick={() => setStatus(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {stats ? (
        <section className="ai-usage card card-pad">
          <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
            <span className="small">
              <strong>{stats.provider}</strong> · {stats.model}
            </span>
            <span className="small muted">
              {stats.calls} llamada{stats.calls === 1 ? '' : 's'} ·{' '}
              {stats.tokensIn + stats.tokensOut} tokens · {usd(stats.costUsdMicros)}
              {stats.audioSeconds > 0
                ? ` · ${Math.round(stats.audioSeconds)} s de audio`
                : ''}
              {(stats.errors ?? 0) > 0
                ? ` · ${stats.errors} error${stats.errors === 1 ? '' : 'es'}`
                : ''}
            </span>
            <span className="small muted">
              Hoy {usd(stats.daily.spentUsdMicros)} / {usd(stats.daily.budgetUsdMicros)} ·
              Mes {usd(stats.monthlyBudget.spentUsdMicros)} / {usd(stats.monthlyBudget.budgetUsdMicros)}
            </span>
            {stats.blocked ? (
              <Badge tone="danger">
                Límite {stats.blocked === 'daily' ? 'diario' : 'mensual'} alcanzado
              </Badge>
            ) : null}
            {stats.alerts.length > 0 ? (
              <Badge tone="warn">
                {stats.alerts.length} alerta{stats.alerts.length === 1 ? '' : 's'} de gasto
              </Badge>
            ) : null}
            <span className="grow" />
            <Badge tone={stats.enabled ? 'ok' : 'danger'}>
              {stats.enabled ? 'Activo' : 'Desactivado'}
            </Badge>
            <Badge tone={stats.autoApply ? 'warn' : 'neutral'}>
              {stats.autoApply ? 'Auto-aplicación activa' : 'Solo sugerencias'}
            </Badge>
            <Badge tone={stats.autoCreatePets ? 'accent' : 'neutral'}>
              {stats.autoCreatePets
                ? 'Mascotas nuevas automáticas'
                : 'Mascotas con revisión'}
            </Badge>
            <Badge tone={stats.verifyPetCandidates ? 'accent' : 'neutral'}>
              {stats.verifyPetCandidates
                ? 'Verificador de mascotas'
                : 'Sin verificador'}
            </Badge>
            <Badge tone={stats.visionEnabled ? 'accent' : 'neutral'}>
              {stats.visionEnabled ? 'Visión de fotos' : 'Sin visión'}
            </Badge>
            <Badge tone={stats.transcriptionEnabled ? 'accent' : 'neutral'}>
              {stats.transcriptionEnabled
                ? 'Transcripción de audios'
                : 'Sin transcripción'}
            </Badge>
            {(stats.testContacts?.length ?? 0) > 0 ? (
              <Badge tone="warn">
                Solo pruebas · {stats.testContacts.length} contacto
                {stats.testContacts.length === 1 ? '' : 's'}
              </Badge>
            ) : (
              <Badge tone="accent">Todos los contactos</Badge>
            )}
            <Badge tone={stats.autoProcess ? 'accent' : 'neutral'}>
              {stats.autoProcess ? 'Cron activo' : 'Cron pausado'}
            </Badge>
          </div>
        </section>
      ) : null}

      {suggestions.loading ? (
        <div className="card card-pad">
          <Spinner label="Cargando sugerencias…" />
        </div>
      ) : suggestions.error ? (
        <EmptyState
          icon="alert"
          title="No se pudieron cargar las sugerencias"
          hint={suggestions.error.message}
          action={<Button onClick={suggestions.reload}>Reintentar</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="sparkle"
          title={
            status === 'pending'
              ? 'No hay sugerencias pendientes'
              : status === 'applied'
                ? 'Sin sugerencias aplicadas'
                : 'Sin sugerencias descartadas'
          }
          hint={
            status === 'pending'
              ? 'Pulsa «Procesar mensajes» para analizar las conversaciones nuevas.'
              : 'Cuando revises sugerencias aparecerán en esta pestaña.'
          }
          action={
            status === 'pending' ? (
              <Button icon="refresh" onClick={runProcessor} loading={processing}>
                Procesar ahora
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="col" style={{ gap: 12 }}>
          {rows.map((suggestion) => (
            <article className="card ai-card" key={suggestion.id}>
              <div className="ai-card-head">
                <Badge tone={KIND_TONES[suggestion.kind] ?? 'neutral'}>
                  {KIND_LABELS[suggestion.kind] ?? suggestion.kind}
                </Badge>
                <strong>{suggestion.title}</strong>
                <span className="grow" />
                <Badge
                  tone={
                    suggestion.status === 'applied'
                      ? 'ok'
                      : suggestion.status === 'rejected'
                        ? 'neutral'
                        : 'accent'
                  }
                >
                  {suggestion.status === 'applied'
                    ? 'Aplicada'
                    : suggestion.status === 'rejected'
                      ? 'Descartada'
                      : 'Pendiente'}
                </Badge>
                {suggestion.confidence !== null ? (
                  <span className="confidence">
                    {Math.round(suggestion.confidence * 100)}% confianza
                  </span>
                ) : null}
              </div>

              {suggestion.summary ? (
                <p className="small muted ai-summary">{suggestion.summary}</p>
              ) : null}

              {suggestion.contactKey ? (
                <Link
                  className="small link"
                  to={`/inbox?contact=${encodeURIComponent(suggestion.contactKey)}`}
                >
                  Ver conversación de origen
                </Link>
              ) : null}

              {suggestion.fields.length > 0 ? (
                <div className="ai-fields">
                  {suggestion.fields.map((field) => (
                    <FieldRow key={field.field} field={field} />
                  ))}
                </div>
              ) : null}

              {suggestion.pets.map((pet, index) => (
                <div className="ai-pet" key={index}>
                  <span className="section-title">Mascota {index + 1}</span>
                  <div className="ai-fields">
                    {pet.fields.map((field) => (
                      <FieldRow key={field.field} field={field} />
                    ))}
                  </div>
                </div>
              ))}

              {suggestion.conversation ? (
                <div className="ai-conversation">
                  {suggestion.conversation.requestedService ? (
                    <span>
                      <strong>Servicio:</strong>{' '}
                      {suggestion.conversation.requestedService}
                    </span>
                  ) : null}
                  {suggestion.conversation.requestedDate ||
                  suggestion.conversation.requestedTime ? (
                    <span>
                      <strong>Cuándo:</strong>{' '}
                      {[suggestion.conversation.requestedDate, suggestion.conversation.requestedTime]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  ) : null}
                  {suggestion.conversation.openQuestions.length > 0 ? (
                    <span>
                      <strong>Pendiente:</strong>{' '}
                      {suggestion.conversation.openQuestions.join(' ')}
                    </span>
                  ) : null}
                  {suggestion.conversation.notes ? (
                    <span>
                      <strong>Nota:</strong> {suggestion.conversation.notes}
                    </span>
                  ) : null}
                </div>
              ) : null}

              {suggestion.kind === 'appointment_request' ? (
                <p className="small muted" style={{ marginTop: 8 }}>
                  Se registrará una solicitud pendiente. La cita se agenda o
                  confirma desde Agenda, con las advertencias de cruce.
                </p>
              ) : null}

              {status === 'pending' ? (
              <div className="ai-actions">
                {!REVIEW_ONLY.includes(suggestion.kind) ? (
                  <Button
                    variant="primary"
                    onClick={() => accept(suggestion)}
                    loading={busyId === suggestion.id}
                  >
                    Aceptar
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={() => accept(suggestion)}
                    loading={busyId === suggestion.id}
                  >
                    {suggestion.kind === 'appointment_request'
                      ? 'Registrar solicitud'
                      : 'Marcar como revisada'}
                  </Button>
                )}
                {suggestion.fields.length > 0 ||
                suggestion.pets.length > 0 ? (
                  <Button onClick={() => setCorrecting(suggestion)}>
                    Corregir
                  </Button>
                ) : null}
                <Button
                  variant="subtle"
                  icon="trash"
                  onClick={() => reject(suggestion)}
                  disabled={busyId === suggestion.id}
                >
                  Descartar
                </Button>
              </div>
              ) : null}
            </article>
          ))}
        </div>
      )}

      <CorrectionModal
        suggestion={correcting}
        onClose={() => setCorrecting(null)}
        onSaved={() => {
          setCorrecting(null);
          suggestions.reload();
          usage.reload();
          toast('Sugerencia aplicada con tus correcciones.');
        }}
      />
    </div>
  );
}

function FieldRow({ field }: { field: AiSuggestionField }) {
  return (
    <div className={`ai-field ${field.conflict ? 'is-conflict' : ''}`}>
      <span className="ai-field-label">{field.label}</span>
      <span className="ai-field-value">{prettyValue(field.value)}</span>
      <span className="ai-field-conf">
        {Math.round(field.confidence * 100)}%
      </span>
      {field.conflict ? <Badge tone="warn">Contradice la ficha</Badge> : null}
      {field.quotes.length > 0 ? (
        <span className="ai-quote">“{field.quotes[0]}”</span>
      ) : null}
    </div>
  );
}

function CorrectionModal({
  suggestion,
  onClose,
  onSaved,
}: {
  suggestion: AiSuggestion | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [petValues, setPetValues] = useState<Array<Record<string, string>>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fields = suggestion?.fields ?? [];

  useEffect(() => {
    if (!suggestion) return;
    const initial: Record<string, string> = {};
    for (const field of suggestion.fields) {
      initial[field.field] = String(field.value ?? '');
    }
    setValues(initial);
    setPetValues(
      suggestion.pets.map((pet) =>
        Object.fromEntries(
          pet.fields.map((field) => [field.field, String(field.value ?? '')]),
        ),
      ),
    );
    setError(null);
  }, [suggestion]);

  async function save() {
    if (!suggestion) return;
    setBusy(true);
    setError(null);

    const corrections: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = values[field.field];
      if (raw === undefined) continue;
      corrections[field.field] =
        typeof field.value === 'number' ? Number(raw) : raw;
    }

    const petCorrections = suggestion.pets.map((pet, index) =>
      Object.fromEntries(
        pet.fields.map((field) => {
          const raw = petValues[index]?.[field.field] ?? String(field.value ?? '');
          return [
            field.field,
            typeof field.value === 'number' ? Number(raw) : raw,
          ];
        }),
      ),
    );

    try {
      await api.ai.accept(suggestion.id, {
        ...(fields.length > 0 ? { fields: corrections } : {}),
        ...(suggestion.pets.length > 0 ? { pets: petCorrections } : {}),
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'No se pudo aplicar.');
    } finally {
      setBusy(false);
    }
  }

  if (!suggestion) return null;

  return (
    <Modal
      open
      wide
      title="Corregir antes de aplicar"
      subtitle="Lo que escribas aquí queda marcado como dato manual."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} loading={busy}>
            Aplicar
          </Button>
        </>
      }
    >
      {error ? <div className="login-error" style={{ marginBottom: 14 }}>{error}</div> : null}

      <div className="form-grid">
        {fields.map((field) => (
          <Field key={field.field} label={field.label}>
            <Input
              value={values[field.field] ?? String(field.value ?? '')}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  [field.field]: event.target.value,
                }))
              }
            />
          </Field>
        ))}
      </div>

      {suggestion.pets.map((pet, index) => (
        <div key={index} style={{ marginTop: 16 }}>
          <p className="section-title" style={{ marginBottom: 8 }}>
            Mascota {index + 1}
          </p>
          <div className="form-grid">
            {pet.fields.map((field) => (
              <Field key={field.field} label={field.label}>
                <Input
                  value={
                    petValues[index]?.[field.field] ?? String(field.value ?? '')
                  }
                  onChange={(event) =>
                    setPetValues((current) => {
                      const next = [...current];
                      next[index] = {
                        ...(next[index] ?? {}),
                        [field.field]: event.target.value,
                      };
                      return next;
                    })
                  }
                />
              </Field>
            ))}
          </div>
        </div>
      ))}
    </Modal>
  );
}
