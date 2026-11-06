import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Conversation, Message } from '../api/types';
import { useAsync } from '../api/useAsync';
import { Icon } from '../components/Icon';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Spinner,
  Textarea,
  useToast,
} from '../components/ui';
import { relativeStamp } from '../lib/date';
import { prettyPhone } from '../lib/format';

type Filter = 'all' | 'active' | 'closed';

export function InboxPage() {
  const conversations = useAsync(() => api.conversations.list(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [searchParams] = useSearchParams();
  const requestedContact = searchParams.get('contact');
  const requestedClientId = searchParams.get('clientId');

  const allRows = conversations.data?.data ?? [];
  const rows = allRows.filter((row) =>
    filter === 'all' ? true : row.status === filter,
  );

  useEffect(() => {
    if (selected) return;
    if (requestedContact) {
      const match = allRows.find((row) => row.waContact === requestedContact);
      if (match) setSelected(match.id);
      return;
    }
    if (requestedClientId) {
      const numericId = Number(requestedClientId);
      const match = allRows.find((row) => row.clientId === numericId);
      if (match) setSelected(match.id);
    }
  }, [requestedContact, requestedClientId, selected, allRows]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Bandeja</h1>
          <p>
            Solo lectura: las conversaciones las escribe el webhook de WhatsApp.
          </p>
        </div>
        <Button
          icon="refresh"
          onClick={conversations.reload}
          loading={conversations.loading}
        >
          Actualizar
        </Button>
      </div>

      <div className="tabs" role="tablist" style={{ marginBottom: 14 }}>
        {(
          [
            ['all', 'Todas'],
            ['active', 'Activas'],
            ['closed', 'Cerradas'],
          ] as Array<[Filter, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {conversations.loading ? (
        <div className="card card-pad">
          <Spinner label="Cargando conversaciones…" />
        </div>
      ) : conversations.error ? (
        <EmptyState
          icon="alert"
          title="No se pudo cargar la bandeja"
          hint={conversations.error.message}
          action={<Button onClick={conversations.reload}>Reintentar</Button>}
        />
      ) : (
        <div className={`inbox ${selected ? 'has-selection' : ''}`}>
          <div className="inbox-list">
            {rows.length === 0 ? (
              <div style={{ padding: 18 }}>
                <EmptyState
                  icon="chat"
                  title="Sin conversaciones"
                  hint="Cuando llegue un mensaje de WhatsApp aparecerá aquí."
                />
              </div>
            ) : (
              <div className="inbox-scroll">
                {rows.map((row) => (
                  <ConversationRow
                    key={row.id}
                    row={row}
                    active={row.id === selected}
                    onClick={() => setSelected(row.id)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="inbox-thread">
            {selected ? (
              <Thread
                id={selected}
                onBack={() => setSelected(null)}
                onNewMessage={() => conversations.reload()}
              />
            ) : (
              <div style={{ display: 'grid', placeItems: 'center', flex: 1, padding: 24 }}>
                <EmptyState
                  icon="chat"
                  title="Elige una conversación"
                  hint="Verás el historial completo, sin poder escribir desde aquí."
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConversationRow({
  row,
  active,
  onClick,
}: {
  row: Conversation;
  active: boolean;
  onClick: () => void;
}) {
  const name = row.client
    ? row.client.name ?? 'Cliente sin nombre'
    : row.contactName ?? prettyPhone(row.waContact);
  const initials = name.slice(0, 2);

  return (
    <button
      type="button"
      className={`list-item ${active ? 'is-active' : ''}`}
      onClick={onClick}
      style={active ? { background: 'var(--accent-soft)' } : undefined}
    >
      <Avatar name={initials} />
      <span className="list-item-body">
        <strong>{name}</strong>
        <span>
          {row.lastMessage?.direction === 'outbound' ? 'Tú: ' : ''}
          {row.lastMessage?.body ?? 'Sin mensajes'}
        </span>
        {row.completeness ? (
          <em className={`conv-quality ${row.completeness.percent >= 100 ? 'is-high' : 'is-low'}`}>
            {row.completeness.percent} % completo
            {row.missing && row.missing.length > 0
              ? ` · falta ${row.missing.join(', ')}`
              : ''}
            {row.hasPets === false ? ' · sin mascotas' : ''}
          </em>
        ) : null}
      </span>
      {row.completeness ? (
        <span
          className={`completeness-badge ${
            row.completeness.percent < 50
              ? 'is-low'
              : row.completeness.percent < 80
                ? 'is-mid'
                : 'is-high'
          }`}
        >
          {row.completeness.percent} %
        </span>
      ) : null}
      <span className="small muted" style={{ alignSelf: 'flex-start', paddingTop: 3 }}>
        {relativeStamp(row.lastMessageAt)}
      </span>
    </button>
  );
}

function Thread({
  id,
  onBack,
  onNewMessage,
}: {
  id: string;
  onBack: () => void;
  onNewMessage: () => void;
}) {
  const detail = useAsync(() => api.conversations.get(id), [id]);
  const data = detail.data?.data ?? null;
  const { toast } = useToast();
  const navigate = useNavigate();
  const [processing, setProcessing] = useState(false);

  async function processAi() {
    if (!data) return;
    setProcessing(true);
    try {
      const result = await api.ai.process({ contactKey: data.waContact });
      const info = result.data;
      if (!info.enabled) {
        toast('La IA está desactivada en este momento.', 'warn');
      } else if (info.reason === 'budget_daily' || info.reason === 'budget_monthly') {
        toast('Se alcanzó el presupuesto de IA.', 'warn');
      } else if (info.failed > 0 && info.processed === 0) {
        toast('No se pudo procesar la conversación.', 'error');
      } else if (info.suggestions === 0) {
        toast('La IA no encontró datos nuevos.');
      } else {
        toast(
          `${info.suggestions} sugerencia${info.suggestions === 1 ? '' : 's'} generada${info.suggestions === 1 ? '' : 's'}.`,
        );
      }
      detail.reload();
      onNewMessage();
    } catch (cause) {
      toast(
        cause instanceof ApiError ? cause.message : 'No se pudo procesar la conversación.',
        'error',
      );
    } finally {
      setProcessing(false);
    }
  }

  if (detail.loading) {
    return (
      <>
        <div className="thread-head">
          <Button
            variant="subtle"
            icon="back"
            onClick={onBack}
            aria-label="Volver"
            className="thread-back"
          />
          <Spinner label="Cargando conversación…" />
        </div>
      </>
    );
  }

  if (detail.error || !data) {
    return (
      <>
        <div className="thread-head">
          <Button
            variant="subtle"
            icon="back"
            onClick={onBack}
            aria-label="Volver"
            className="thread-back"
          />
          <span className="muted small">No se pudo abrir</span>
        </div>
        <div className="card-pad">
          <EmptyState
            icon="alert"
            title="No se pudo abrir la conversación"
            hint={detail.error?.message}
            action={<Button onClick={detail.reload}>Reintentar</Button>}
          />
        </div>
      </>
    );
  }

  const name = data.client
    ? data.client.name ?? 'Cliente sin nombre'
    : data.contactName ?? prettyPhone(data.waContact);
  const phone = data.client?.phone ?? data.messages[0]?.contactPhone ?? null;
  const allProcessed =
    data.messages.length > 0 &&
    data.ai.processedMessages >= data.messages.length;

  return (
    <>
      <div className="thread-head">
        <Button
          variant="subtle"
          icon="back"
          onClick={onBack}
          aria-label="Volver"
          className="thread-back"
        />
        <Avatar name={name} size={38} />
        <div className="grow" style={{ minWidth: 0 }}>
          <strong style={{ display: 'block', fontSize: 14.5 }}>{name}</strong>
          <span className="muted small">
            {phone ? prettyPhone(phone) : data.waContact}
          </span>
        </div>
        <div className="thread-actions">
          {data.client ? (
            <Link
              className="btn btn-subtle btn-sm"
              to={`/clients/${data.client.id}?from=${encodeURIComponent(`/inbox?clientId=${data.client.id}`)}`}
            >
              <Icon name="users" size={16} />
              <span>Cliente</span>
            </Link>
          ) : null}
          <Badge tone={data.client ? 'ok' : 'neutral'}>
            {data.client ? 'Cliente' : 'Sin ficha'}
          </Badge>
          <Badge tone={allProcessed ? 'ok' : 'neutral'}>
            {allProcessed
              ? `IA · ${data.ai.processedMessages}/${data.messages.length}`
              : data.ai.processedMessages > 0
                ? `IA · ${data.ai.processedMessages}/${data.messages.length}`
                : 'Sin procesar'}
          </Badge>
          <Button
            variant="primary"
            icon="sparkle"
            className="btn-sm"
            onClick={processAi}
            loading={processing}
            disabled={allProcessed}
            title={
              allProcessed
                ? 'Todos los mensajes de esta conversación ya fueron procesados.'
                : 'Procesa solo los mensajes nuevos.'
            }
          >
            {allProcessed ? 'Procesada' : 'Procesar con IA'}
          </Button>
          {data.ai.suggestions > 0 ? (
            <Button
              variant="subtle"
              className="btn-sm"
              onClick={() => navigate('/ai')}
            >
              Ver sugerencias
            </Button>
          ) : null}
          <Button
            variant="subtle"
            icon="refresh"
            onClick={() => {
              detail.reload();
              onNewMessage();
            }}
            aria-label="Actualizar"
          />
        </div>
      </div>
      {data.ai.lastJobStatus === 'failed' && data.ai.lastError ? (
        <div className="warn-item" style={{ margin: '10px 16px' }}>
          <Icon name="alert" size={15} />
          <span>Error de IA: {data.ai.lastError}</span>
        </div>
      ) : null}

      <div className="inbox-scroll">
        <div className="messages">
          {data.messages.map((message) => {
            const isAudio =
              message.messageType === 'audio' ||
              message.messageType === 'voice' ||
              message.messageType === 'ptt';

            return (
              <div
                key={message.messageId}
                className={`bubble ${
                  message.direction === 'outbound' ? 'bubble-out' : 'bubble-in'
                }`}
              >
                {isAudio ? (
                  <AudioMessage
                    message={message}
                    conversationId={data.id}
                    onReprocess={processAi}
                  />
                ) : (
                  (message.body ?? `[${message.messageType ?? 'mensaje'}]`)
                )}
                <span className="bubble-time">
                  {relativeStamp(message.sentAt)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="readonly-note">
        <Icon name="chat" size={14} />
        Solo lectura. Para responder, usa WhatsApp: este CRM no envía mensajes.
      </div>
    </>
  );
}

function formatAudioDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function AudioMessage({
  message,
  conversationId,
  onReprocess,
}: {
  message: Message;
  conversationId: string;
  onReprocess: () => Promise<void>;
}) {
  const transcription = message.transcription;
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBusy, setAudioBusy] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(transcription?.text ?? '');
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (!editing) setDraft(transcription?.text ?? '');
  }, [editing, transcription?.text]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  async function playAudio() {
    setAudioBusy(true);
    setAudioError(null);
    try {
      const blob = await api.conversations.audio(conversationId, message.messageId);
      setAudioUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(blob);
      });
    } catch (cause) {
      setAudioError(
        cause instanceof ApiError
          ? cause.message
          : 'El audio ya no está disponible.',
      );
    } finally {
      setAudioBusy(false);
    }
  }

  async function saveCorrection() {
    const text = draft.trim();
    if (text.length === 0) return;
    setSaving(true);
    try {
      await api.conversations.correctTranscription(
        conversationId,
        message.messageId,
        text,
      );
      setEditing(false);
      toast('Transcripción corregida.');
      await onReprocess();
    } catch (cause) {
      toast(
        cause instanceof ApiError
          ? cause.message
          : 'No se pudo guardar la corrección.',
        'error',
      );
    } finally {
      setSaving(false);
    }
  }

  async function retry() {
    setRetrying(true);
    try {
      await api.conversations.retryTranscription(
        conversationId,
        message.messageId,
      );
      toast('Reintentando la transcripción.');
      await onReprocess();
    } catch (cause) {
      toast(
        cause instanceof ApiError
          ? cause.message
          : 'No se pudo reintentar la transcripción.',
        'error',
      );
    } finally {
      setRetrying(false);
    }
  }

  const status = transcription?.status ?? 'pending';
  const duration = formatAudioDuration(
    transcription?.durationSeconds ?? null,
  );
  const statusLabel =
    status === 'completed'
      ? transcription?.correctedAt
        ? 'Corregida'
        : 'Transcrita'
      : status === 'processing'
        ? 'Transcribiendo…'
        : status === 'failed'
          ? 'Error'
          : 'Pendiente';
  const tone =
    status === 'failed'
      ? 'danger'
      : status === 'completed'
        ? transcription?.correctedAt
          ? 'accent'
          : 'ok'
        : status === 'processing'
          ? 'warn'
          : 'neutral';

  return (
    <div className="audio-message">
      <div className="audio-message-head">
        <Icon name="mic" size={15} />
        <strong>Nota de voz</strong>
        {duration ? <span className="muted small">{duration}</span> : null}
        <Badge tone={tone}>{statusLabel}</Badge>
        <Badge tone="accent">IA</Badge>
      </div>

      {audioUrl ? (
        <audio className="audio-player" controls src={audioUrl} />
      ) : (
        <Button
          className="btn-sm"
          icon="chat"
          onClick={playAudio}
          loading={audioBusy}
        >
          Reproducir audio
        </Button>
      )}
      {audioError ? (
        <p className="field-error" style={{ marginTop: 6 }}>
          {audioError}
        </p>
      ) : null}

      {transcription?.text ? (
        <p className="audio-transcript">{transcription.text}</p>
      ) : status === 'processing' ? (
        <p className="muted small">Transcribiendo la nota de voz…</p>
      ) : status === 'failed' ? (
        <p className="field-error">
          {transcription?.error ?? 'No se pudo transcribir el audio.'}
        </p>
      ) : (
        <p className="muted small">Pendiente de transcripción.</p>
      )}

      {editing ? (
        <div className="audio-edit">
          <Textarea
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Escribe la transcripción correcta"
          />
          <div className="row" style={{ gap: 8 }}>
            <Button
              variant="primary"
              className="btn-sm"
              onClick={saveCorrection}
              loading={saving}
              disabled={draft.trim().length === 0}
            >
              Guardar corrección
            </Button>
            <Button
              variant="subtle"
              className="btn-sm"
              onClick={() => {
                setEditing(false);
                setDraft(transcription?.text ?? '');
              }}
              disabled={saving}
            >
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ gap: 8, marginTop: 4 }}>
          <Button
            variant="subtle"
            className="btn-sm"
            onClick={() => setEditing(true)}
          >
            {transcription?.text ? 'Corregir transcripción' : 'Escribir transcripción'}
          </Button>
          {status === 'failed' ? (
            <Button
              variant="subtle"
              className="btn-sm"
              icon="refresh"
              onClick={retry}
              loading={retrying}
            >
              Reintentar
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
