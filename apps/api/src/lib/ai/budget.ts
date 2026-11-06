import type { Db } from '@keyko/db';
import { aiAlerts, aiExtractions } from '@keyko/db';
import { nowSqlite, todayLocal } from '@keyko/domain';
import { and, eq, sql } from 'drizzle-orm';
import type { AiConfig } from './config';

export type Spend = { today: number; month: number };

const MICROS = 1_000_000;

function dayStartSql(): string {
  return `${todayLocal()} 00:00:00`;
}

function monthStartSql(): string {
  return `${todayLocal().slice(0, 7)}-01 00:00:00`;
}

/** Gasto del día y del mes en micro-dólares. */
export async function spendFor(db: Db, businessId: string): Promise<Spend> {
  const [daily] = await db.all<{ spent: number }>(sql`
    SELECT COALESCE(SUM(cost_usd_micros), 0) AS spent
      FROM ai_usage
     WHERE business_id = ${businessId}
       AND created_at >= ${dayStartSql()}
  `);

  const [monthly] = await db.all<{ spent: number }>(sql`
    SELECT COALESCE(SUM(cost_usd_micros), 0) AS spent
      FROM ai_usage
     WHERE business_id = ${businessId}
       AND created_at >= ${monthStartSql()}
  `);

  return {
    today: Number(daily?.spent ?? 0),
    month: Number(monthly?.spent ?? 0),
  };
}

export type BudgetState = {
  spent: Spend;
  dailyBudget: number;
  monthlyBudget: number;
  blocked: 'daily' | 'monthly' | null;
};

export async function budgetState(
  db: Db,
  businessId: string,
  config: AiConfig,
): Promise<BudgetState> {
  const spent = await spendFor(db, businessId);

  return {
    spent,
    dailyBudget: config.dailyBudgetUsdMicros,
    monthlyBudget: config.monthlyBudgetUsdMicros,
    blocked:
      spent.today >= config.dailyBudgetUsdMicros
        ? 'daily'
        : spent.month >= config.monthlyBudgetUsdMicros
          ? 'monthly'
          : null,
  };
}

/**
 * Registra una alerta por umbral (80 % y 100 %) y periodo. La clave única
 * evita repetir la misma alerta con cada mensaje.
 */
export async function registerBudgetAlerts(
  db: Db,
  businessId: string,
  config: AiConfig,
  spent: Spend,
): Promise<void> {
  const periods = [
    {
      kind: 'daily_budget' as const,
      spent: spent.today,
      budget: config.dailyBudgetUsdMicros,
      period: todayLocal(),
    },
    {
      kind: 'monthly_budget' as const,
      spent: spent.month,
      budget: config.monthlyBudgetUsdMicros,
      period: todayLocal().slice(0, 7),
    },
  ];

  for (const entry of periods) {
    if (entry.budget <= 0) continue;
    const ratio = entry.spent / entry.budget;
    if (ratio < 0.8) continue;

    const threshold = ratio >= 1 ? 100 : 80;

    await db
      .insert(aiAlerts)
      .values({
        id: crypto.randomUUID(),
        businessId,
        kind: entry.kind,
        threshold,
        spentUsdMicros: entry.spent,
        budgetUsdMicros: entry.budget,
        period: entry.period,
        createdAt: nowSqlite(),
      })
      .onConflictDoNothing();

    console.warn(
      `ai_budget_${threshold}`,
      entry.kind,
      `${(entry.spent / MICROS).toFixed(4)}/${(entry.budget / MICROS).toFixed(2)} USD`,
    );
  }
}

/**
 * Borra la respuesta cruda del modelo pasado el periodo de retención.
 * Los resultados estructurados, la evidencia y las métricas se conservan.
 */
export async function pruneAiData(
  db: Db,
  businessId: string,
  retentionDays: number,
): Promise<number> {
  if (retentionDays <= 0) return 0;

  const cutoff = nowSqlite(
    new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000),
  );

  const rows = await db.all<{ id: string }>(sql`
    UPDATE ai_extractions
       SET raw_response = ''
     WHERE business_id = ${businessId}
       AND raw_response <> ''
       AND created_at < ${cutoff}
    RETURNING id
  `);

  return rows.length;
}

/**
 * Borra sugerencias ya revisadas pasado el periodo de retención. El rastro de
 * lo que cambió queda en `audit_log` (acción `ai.apply`), que no se toca.
 */
export async function pruneReviewedSuggestions(
  db: Db,
  businessId: string,
  retentionDays: number,
): Promise<number> {
  if (retentionDays <= 0) return 0;

  const cutoff = nowSqlite(
    new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000),
  );

  const rows = await db.all<{ id: string }>(sql`
    DELETE FROM ai_extractions
     WHERE business_id = ${businessId}
       AND status IN ('applied', 'rejected', 'validated')
       AND created_at < ${cutoff}
    RETURNING id
  `);

  return rows.length;
}

/**
 * Pasa el detalle de consumo antiguo a un agregado mensual sin datos
 * personales (solo modelo, llamadas, tokens, costo, errores y latencia).
 * El detalle se conserva `retentionDays` días.
 */
export async function aggregateAndPruneUsage(
  db: Db,
  businessId: string,
  retentionDays: number,
): Promise<{ aggregated: number; deleted: number }> {
  if (retentionDays <= 0) return { aggregated: 0, deleted: 0 };

  const cutoff = nowSqlite(
    new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000),
  );

  const aggregated = await db.all<{ month: string }>(sql`
    INSERT INTO ai_usage_monthly
      (business_id, month, model, calls, errors, tokens_in, tokens_out,
       cost_usd_micros, latency_ms_avg, updated_at)
    SELECT business_id,
           substr(created_at, 1, 7) AS month,
           model,
           COUNT(*) AS calls,
           SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
           COALESCE(SUM(tokens_in), 0),
           COALESCE(SUM(tokens_out), 0),
           COALESCE(SUM(cost_usd_micros), 0),
           CAST(AVG(latency_ms) AS INTEGER),
           ${nowSqlite()}
      FROM ai_usage
     WHERE business_id = ${businessId}
       AND created_at < ${cutoff}
     GROUP BY business_id, month, model
    ON CONFLICT (business_id, month, model) DO UPDATE SET
      calls = ai_usage_monthly.calls + excluded.calls,
      errors = ai_usage_monthly.errors + excluded.errors,
      tokens_in = ai_usage_monthly.tokens_in + excluded.tokens_in,
      tokens_out = ai_usage_monthly.tokens_out + excluded.tokens_out,
      cost_usd_micros = ai_usage_monthly.cost_usd_micros + excluded.cost_usd_micros,
      latency_ms_avg = excluded.latency_ms_avg,
      updated_at = excluded.updated_at
    RETURNING month
  `);

  const deleted = await db.all<{ id: string }>(sql`
    DELETE FROM ai_usage
     WHERE business_id = ${businessId}
       AND created_at < ${cutoff}
    RETURNING id
  `);

  return { aggregated: aggregated.length, deleted: deleted.length };
}

export async function recentAlerts(
  db: Db,
  businessId: string,
  limit = 10,
): Promise<
  Array<{
    id: string;
    kind: string;
    threshold: number;
    spentUsdMicros: number;
    budgetUsdMicros: number;
    period: string;
    createdAt: string;
  }>
> {
  const rows = await db
    .select()
    .from(aiAlerts)
    .where(eq(aiAlerts.businessId, businessId))
    .orderBy(sql`${aiAlerts.createdAt} DESC`)
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    threshold: row.threshold,
    spentUsdMicros: row.spentUsdMicros,
    budgetUsdMicros: row.budgetUsdMicros,
    period: row.period,
    createdAt: row.createdAt,
  }));
}

export async function clearAlertsForTests(db: Db, businessId: string): Promise<void> {
  await db.delete(aiAlerts).where(and(eq(aiAlerts.businessId, businessId)));
}

export { aiExtractions };
