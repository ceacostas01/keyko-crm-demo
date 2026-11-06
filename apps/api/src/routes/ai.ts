import { aiExtractions } from '@keyko/db';
import { nowSqlite } from '@keyko/domain';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { acceptSuggestion, rejectSuggestion } from '../lib/ai/accept';
import type { SuggestionPayload } from '../lib/ai/apply';
import { aiConfig } from '../lib/ai/config';
import {
  aggregateAndPruneUsage,
  budgetState,
  pruneAiData,
  pruneReviewedSuggestions,
  recentAlerts,
} from '../lib/ai/budget';
import { processAiJobs } from '../lib/ai/jobs';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { parse, readJson } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import {
  aiAcceptSchema,
  aiProcessSchema,
  aiSuggestionQuerySchema,
  aiUsageQuerySchema,
} from '../schemas';

export const aiRoutes = new Hono<AppEnv>();

aiRoutes.use('*', requireAuth);

function serialize(row: typeof aiExtractions.$inferSelect) {
  const payload = row.parsedJson
    ? (JSON.parse(row.parsedJson) as SuggestionPayload)
    : null;

  return {
    id: row.id,
    status: row.status,
    confidence: row.confidence,
    model: row.model,
    createdAt: row.createdAt,
    targetEntity: row.targetEntity,
    targetId: row.targetId,
    kind: payload?.kind ?? 'client_update',
    title: payload?.title ?? 'Sugerencia',
    clientId: payload?.clientId ?? null,
    petId: payload?.petId ?? null,
    fields: payload?.fields ?? [],
    pets: payload?.pets ?? [],
    conversation: payload?.conversation ?? null,
    contactKey: payload?.contactKey ?? null,
    summary: payload?.summary ?? '',
  };
}

aiRoutes.get('/suggestions', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const query = parse(aiSuggestionQuerySchema, c.req.query());

  const rows = await db
    .select()
    .from(aiExtractions)
    .where(
      and(
        eq(aiExtractions.businessId, businessId),
        eq(aiExtractions.status, query.status),
      ),
    )
    .orderBy(desc(aiExtractions.createdAt))
    .limit(query.limit)
    .offset(query.offset);

  return c.json({
    data: rows.map(serialize),
    pagination: { limit: query.limit, offset: query.offset, count: rows.length },
  });
});

aiRoutes.get('/suggestions/:id', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');

  const [row] = await db
    .select()
    .from(aiExtractions)
    .where(
      and(
        eq(aiExtractions.id, c.req.param('id')),
        eq(aiExtractions.businessId, businessId),
      ),
    )
    .limit(1);

  if (!row) throw notFound('Sugerencia no encontrada');
  return c.json({ data: serialize(row) });
});

aiRoutes.post('/suggestions/:id/accept', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const body = parse(aiAcceptSchema, await readJson(c));

  const [row] = await db
    .select()
    .from(aiExtractions)
    .where(
      and(
        eq(aiExtractions.id, c.req.param('id')),
        eq(aiExtractions.businessId, businessId),
      ),
    )
    .limit(1);

  if (!row) throw notFound('Sugerencia no encontrada');
  if (row.status !== 'pending') {
    throw conflict('suggestion_reviewed', 'Esta sugerencia ya fue revisada');
  }

  const result = await acceptSuggestion({
    db,
    businessId,
    extraction: row,
    ...(body.fields ? { corrections: body.fields } : {}),
    ...(body.pets ? { petCorrections: body.pets } : {}),
    userId,
  });

  const [updated] = await db
    .select()
    .from(aiExtractions)
    .where(eq(aiExtractions.id, row.id))
    .limit(1);

  return c.json({
    data: {
      ...(updated ? serialize(updated) : serialize(row)),
      applied: result,
    },
  });
});

aiRoutes.post('/suggestions/:id/reject', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');

  const [row] = await db
    .select()
    .from(aiExtractions)
    .where(
      and(
        eq(aiExtractions.id, c.req.param('id')),
        eq(aiExtractions.businessId, businessId),
      ),
    )
    .limit(1);

  if (!row) throw notFound('Sugerencia no encontrada');
  if (row.status !== 'pending') {
    throw conflict('suggestion_reviewed', 'Esta sugerencia ya fue revisada');
  }

  const ok = await rejectSuggestion({
    db,
    businessId,
    extractionId: row.id,
    userId,
  });
  if (!ok) throw unprocessable('No se pudo descartar la sugerencia');

  return c.json({ data: { id: row.id, status: 'rejected' } });
});

/**
 * Procesa los mensajes pendientes. En producción lo hará la cola; aquí se
 * puede disparar a mano para probar el flujo completo.
 */
aiRoutes.post('/process', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const config = aiConfig(c.env);
  const body = parse(aiProcessSchema, await readJson(c));
  const result = await processAiJobs(db, businessId, {
    config,
    limit: body.limit,
    ...(body.contactKey
      ? { contactKeys: [body.contactKey], since: null }
      : config.testContacts.length > 0
        ? { contactKeys: config.testContacts, since: config.startedAt }
        : { since: config.startedAt }),
  });

  return c.json({
    data: {
      ...result,
      enabled: config.enabled,
      provider: config.provider,
      model: config.model,
      autoApply: config.autoApply,
    },
  });
});

/** Borra respuestas crudas antiguas. Se ejecuta también al procesar. */
aiRoutes.post('/prune', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const config = aiConfig(c.env);

  const removed = await pruneAiData(db, businessId, config.rawRetentionDays);
  const suggestions = await pruneReviewedSuggestions(
    db,
    businessId,
    config.suggestionRetentionDays,
  );
  const usage = await aggregateAndPruneUsage(
    db,
    businessId,
    config.usageRetentionDays,
  );

  return c.json({
    data: {
      cleared: removed,
      removedSuggestions: suggestions,
      aggregatedUsageMonths: usage.aggregated,
      prunedUsageRows: usage.deleted,
      retentionDays: config.rawRetentionDays,
      suggestionRetentionDays: config.suggestionRetentionDays,
      usageRetentionDays: config.usageRetentionDays,
    },
  });
});

aiRoutes.get('/usage', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const query = parse(aiUsageQuerySchema, c.req.query());
  const config = aiConfig(c.env);

  const from = query.from ?? '0000-01-01';
  const to = query.to ?? '9999-12-31';

  const [totals] = await db.all<{
    calls: number;
    tokens_in: number;
    tokens_out: number;
    audio_seconds: number;
    cost: number;
    errors: number;
  }>(sql`
    SELECT COUNT(*) AS calls,
           COALESCE(SUM(tokens_in), 0) AS tokens_in,
           COALESCE(SUM(tokens_out), 0) AS tokens_out,
           COALESCE(SUM(audio_seconds), 0) AS audio_seconds,
           COALESCE(SUM(cost_usd_micros), 0) AS cost,
           COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors
      FROM ai_usage
     WHERE business_id = ${businessId}
       AND date(created_at) >= ${from}
       AND date(created_at) <= ${to}
  `);

  const monthly = await db.all<{
    month: string;
    model: string;
    calls: number;
    errors: number;
    tokens_in: number;
    tokens_out: number;
    cost: number;
    latency: number | null;
  }>(sql`
    SELECT month, model, calls, errors, tokens_in, tokens_out,
           cost_usd_micros AS cost, latency_ms_avg AS latency
      FROM ai_usage_monthly
     WHERE business_id = ${businessId}
     ORDER BY month DESC, model ASC
     LIMIT 24
  `);

  const recent = await db.all<{
    id: string;
    model: string;
    tokens_in: number;
    tokens_out: number;
    audio_seconds: number | null;
    cost_usd_micros: number;
    latency_ms: number | null;
    created_at: string;
  }>(sql`
    SELECT id, model, tokens_in, tokens_out, audio_seconds, cost_usd_micros, latency_ms, created_at
      FROM ai_usage
     WHERE business_id = ${businessId}
     ORDER BY created_at DESC
     LIMIT 20
  `);

  const [pending] = await db.all<{ n: number }>(sql`
    SELECT COUNT(*) AS n
      FROM ai_extractions
     WHERE business_id = ${businessId} AND status = 'pending'
  `);

  const budget = await budgetState(db, businessId, config);
  const alerts = await recentAlerts(db, businessId);

  return c.json({
    data: {
      enabled: config.enabled,
      provider: config.provider,
      model: config.model,
      autoApply: config.autoApply,
      autoCreatePets: config.autoCreatePets,
      verifyPetCandidates: config.verifyPetCandidates,
      visionEnabled: config.visionEnabled,
      visionModel: config.visionModel,
      transcriptionEnabled: config.transcriptionEnabled,
      transcriptionModel: config.transcriptionModel,
      transcriptionLanguage: config.transcriptionLanguage,
      autoCreateAppointmentRequests: config.autoCreateAppointmentRequests,
      autoConfirmAppointments: config.autoConfirmAppointments,
      autoProcess: config.autoProcess,
      testContacts: config.testContacts,
      budgetUsdMicros: config.dailyBudgetUsdMicros,
      daily: {
        spentUsdMicros: budget.spent.today,
        budgetUsdMicros: budget.dailyBudget,
      },
      monthlyBudget: {
        spentUsdMicros: budget.spent.month,
        budgetUsdMicros: budget.monthlyBudget,
      },
      blocked: budget.blocked,
      storeRawResponse: config.storeRawResponse,
      rawRetentionDays: config.rawRetentionDays,
      alerts,
      calls: Number(totals?.calls ?? 0),
      errors: Number(totals?.errors ?? 0),
      tokensIn: Number(totals?.tokens_in ?? 0),
      tokensOut: Number(totals?.tokens_out ?? 0),
      audioSeconds: Number(totals?.audio_seconds ?? 0),
      costUsdMicros: Number(totals?.cost ?? 0),
      monthlyUsage: monthly.map((row) => ({
        month: row.month,
        model: row.model,
        calls: Number(row.calls),
        errors: Number(row.errors),
        tokensIn: Number(row.tokens_in),
        tokensOut: Number(row.tokens_out),
        costUsdMicros: Number(row.cost),
        latencyMsAvg: row.latency === null ? null : Number(row.latency),
      })),
      pendingSuggestions: Number(pending?.n ?? 0),
      recent: recent.map((row) => ({
        id: row.id,
        model: row.model,
        tokensIn: Number(row.tokens_in),
        tokensOut: Number(row.tokens_out),
        audioSeconds:
          row.audio_seconds === null ? null : Number(row.audio_seconds),
        costUsdMicros: Number(row.cost_usd_micros),
        latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
        createdAt: row.created_at,
      })),
      generatedAt: nowSqlite(),
    },
  });
});
