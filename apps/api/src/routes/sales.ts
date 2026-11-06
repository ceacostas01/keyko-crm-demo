import type { Db } from '@keyko/db';
import {
  appointments,
  auditLog,
  clients,
  expenses,
  payments,
  pets,
  products,
  saleItems,
  sales,
  stockMovements,
  users,
} from '@keyko/db';
import { BOGOTA_TZ, dayRangeUtc, localToUtc, nowSqliteMs, utcToLocal } from '@keyko/domain';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { recordAudit } from '../lib/audit';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { parse, readJson, readJsonOrEmpty } from '../lib/http';
import { idempotent } from '../lib/idempotency';
import {
  lineTotalCents,
  moneyPosition,
  netPaidCents,
  saleStatus,
} from '../lib/sales';
import { isoToSqlite, sqliteToIso } from '../lib/time';
import { requireAuth } from '../middleware/auth';
import {
  saleCreateSchema,
  salePaymentCreateSchema,
  saleQuerySchema,
  saleRefundSchema,
  saleReturnSchema,
  saleUpdateSchema,
  saleVoidSchema,
  salesSummaryQuerySchema,
} from '../schemas';

export const saleRoutes = new Hono<AppEnv>();

saleRoutes.use('*', requireAuth);

type SaleRow = typeof sales.$inferSelect;
type SaleItemRow = typeof saleItems.$inferSelect;
type PaymentRow = typeof payments.$inferSelect;

type ItemInput = {
  id?: string | undefined;
  type: 'service' | 'product';
  name?: string | undefined;
  productId?: string | null | undefined;
  petId?: string | null | undefined;
  qty: number;
  unitPriceCents?: number | undefined;
  discountCents: number;
  notes?: string | null | undefined;
};

type ResolvedLine = {
  id: string;
  type: 'service' | 'product';
  itemId: string | null;
  name: string;
  petId: string | null;
  qty: number;
  unitPriceCents: number;
  discountCents: number;
  totalCents: number;
  notes: string | null;
};

/**
 * Convierte un día local (Bogotá) en el timestamp SQLite de la venta,
 * conservando la hora actual para no alterar el orden dentro del día.
 */
function saleTimestampForDay(day: string): string {
  const localNow = utcToLocal(new Date().toISOString(), BOGOTA_TZ);
  const time = localNow.slice(11, 19);
  return nowSqliteMs(new Date(localToUtc(`${day}T${time}`, BOGOTA_TZ)));
}

function serializeItem(row: SaleItemRow, petName: string | null) {
  return {
    ...row,
    petName,
    createdAtLocal: utcToLocal(sqliteToIso(row.createdAt), BOGOTA_TZ),
  };
}

function serializeSale(
  sale: SaleRow,
  items: Array<{ row: SaleItemRow; petName: string | null }>,
  paymentRows: PaymentRow[],
  client: { id: number; name: string | null; phone: string | null } | null,
  history: Array<{
    id: string;
    action: string;
    actorName: string | null;
    diffJson: string | null;
    createdAt: string;
  }> = [],
) {
  const position = moneyPosition(
    sale.totalCents,
    paymentRows.map((payment) => ({
      amountCents: payment.amountCents,
      kind: payment.kind,
    })),
  );

  return {
    ...sale,
    ...position,
    createdAtLocal: utcToLocal(sqliteToIso(sale.createdAt), BOGOTA_TZ),
    client,
    items: items.map((item) => serializeItem(item.row, item.petName)),
    payments: paymentRows.map((payment) => ({
      ...payment,
      paidAtLocal: utcToLocal(sqliteToIso(payment.paidAt), BOGOTA_TZ),
    })),
    history: history.map((entry) => ({
      id: entry.id,
      action: entry.action,
      actorName: entry.actorName,
      diff: entry.diffJson ? (JSON.parse(entry.diffJson) as unknown) : null,
      createdAt: entry.createdAt,
      createdAtLocal: utcToLocal(sqliteToIso(entry.createdAt), BOGOTA_TZ),
    })),
  };
}

async function loadSale(db: Db, businessId: string, saleId: string) {
  const [sale] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
    .limit(1);

  if (!sale) return null;

  const itemRows = await db
    .select({ row: saleItems, petName: pets.name })
    .from(saleItems)
    .leftJoin(pets, eq(pets.id, saleItems.petId))
    .where(
      and(eq(saleItems.saleId, saleId), eq(saleItems.businessId, businessId)),
    )
    .orderBy(saleItems.createdAt);

  const paymentRows = await db
    .select()
    .from(payments)
    .where(
      and(eq(payments.saleId, saleId), eq(payments.businessId, businessId)),
    )
    .orderBy(payments.paidAt);

  const [client] = sale.clientId
    ? await db
        .select({
          id: clients.id,
          name: clients.fullName,
          phone: clients.phone,
        })
        .from(clients)
        .where(
          and(eq(clients.id, sale.clientId), eq(clients.businessId, businessId)),
        )
        .limit(1)
    : [];

  const history = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorName: users.name,
      diffJson: auditLog.diffJson,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(
      and(
        eq(auditLog.businessId, businessId),
        eq(auditLog.entity, 'sale'),
        eq(auditLog.entityId, saleId),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(50);

  return serializeSale(
    sale,
    itemRows.map((row) => ({ row: row.row, petName: row.petName })),
    paymentRows,
    client ?? null,
    history,
  );
}

/**
 * Valida las referencias de una venta (cliente, mascotas, productos) y
 * devuelve las líneas normalizadas. El precio de un servicio es libre; el de
 * un artículo se congela en la línea.
 */
async function resolveItems(
  db: Db,
  businessId: string,
  clientId: number | null,
  items: ItemInput[],
  existing?: Map<string, SaleItemRow>,
): Promise<ResolvedLine[]> {
  const petIds = [
    ...new Set(
      items
        .map((item) => item.petId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const productIds = [
    ...new Set(
      items
        .map((item) => item.productId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  const petRows = petIds.length
    ? await db
        .select({ id: pets.id, name: pets.name, clientId: pets.clientId })
        .from(pets)
        .where(and(eq(pets.businessId, businessId), inArray(pets.id, petIds)))
    : [];
  const petById = new Map(petRows.map((pet) => [pet.id, pet]));

  const productRows = productIds.length
    ? await db
        .select()
        .from(products)
        .where(
          and(
            eq(products.businessId, businessId),
            inArray(products.id, productIds),
          ),
        )
    : [];
  const productById = new Map(productRows.map((product) => [product.id, product]));

  return items.map((item, index) => {
    if (item.id && existing && !existing.has(item.id)) {
      throw unprocessable('La línea no pertenece a esta venta', [
        { path: `items.${index}.id`, message: 'Identificador desconocido' },
      ]);
    }

    if (item.type === 'service') {
      if (!item.name || item.name.trim().length < 2) {
        throw unprocessable('El servicio necesita un nombre', [
          { path: `items.${index}.name`, message: 'Escribe qué servicio se hizo' },
        ]);
      }
      // La mascota es opcional: una venta puede ser solo del cliente.
      const pet = item.petId ? petById.get(item.petId) : null;
      if (item.petId && !pet) throw notFound('Mascota no encontrada');
      if (pet && clientId !== null && pet.clientId !== clientId) {
        throw unprocessable('La mascota no pertenece a ese cliente', [
          { path: `items.${index}.petId`, message: 'Elige una mascota del cliente' },
        ]);
      }
      if (item.unitPriceCents === undefined) {
        throw unprocessable('El servicio necesita un precio', [
          { path: `items.${index}.unitPriceCents`, message: 'Indica cuánto se cobró' },
        ]);
      }

      return {
        id: item.id ?? crypto.randomUUID(),
        type: 'service',
        itemId: null,
        name: item.name.trim(),
        petId: pet?.id ?? null,
        qty: item.qty,
        unitPriceCents: item.unitPriceCents,
        discountCents: item.discountCents,
        totalCents: lineTotalCents({
          qty: item.qty,
          unitPriceCents: item.unitPriceCents,
          discountCents: item.discountCents,
        }),
        notes: item.notes ?? null,
      };
    }

    if (!item.productId) {
      throw unprocessable('El artículo necesita un producto del catálogo', [
        { path: `items.${index}.productId`, message: 'Elige un artículo' },
      ]);
    }
    const product = productById.get(item.productId);
    if (!product) throw notFound('Artículo no encontrado');

    if (item.petId) {
      const pet = petById.get(item.petId);
      if (!pet) throw notFound('Mascota no encontrada');
      if (clientId !== null && pet.clientId !== clientId) {
        throw unprocessable('La mascota no pertenece a ese cliente', [
          { path: `items.${index}.petId`, message: 'Elige una mascota del cliente' },
        ]);
      }
    }

    const unitPriceCents = item.unitPriceCents ?? product.priceCents;

    return {
      id: item.id ?? crypto.randomUUID(),
      type: 'product',
      itemId: product.id,
      name: item.name?.trim() || product.name,
      petId: item.petId ?? null,
      qty: item.qty,
      unitPriceCents,
      discountCents: item.discountCents,
      totalCents: lineTotalCents({
        qty: item.qty,
        unitPriceCents,
        discountCents: item.discountCents,
      }),
      notes: item.notes ?? null,
    };
  });
}

async function requireClient(db: Db, businessId: string, clientId: number) {
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.businessId, businessId)))
    .limit(1);
  if (!client) throw notFound('Cliente no encontrado');
}

async function requireAppointment(
  db: Db,
  businessId: string,
  appointmentId: string,
) {
  const [appointment] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.businessId, businessId),
      ),
    )
    .limit(1);
  if (!appointment) throw notFound('Cita no encontrada');
}

saleRoutes.get('/', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const query = parse(saleQuerySchema, c.req.query());

  const filters: SQL[] = [eq(sales.businessId, businessId)];
  if (query.from) {
    filters.push(gte(sales.createdAt, isoToSqlite(dayRangeUtc(query.from).startUtc)));
  }
  if (query.to) {
    filters.push(lt(sales.createdAt, isoToSqlite(dayRangeUtc(query.to).endUtc)));
  }
  if (query.status) filters.push(eq(sales.status, query.status));
  if (query.clientId) filters.push(eq(sales.clientId, query.clientId));
  if (query.petId) {
    filters.push(
      inArray(
        sales.id,
        db
          .select({ id: saleItems.saleId })
          .from(saleItems)
          .where(
            and(
              eq(saleItems.businessId, businessId),
              eq(saleItems.petId, query.petId),
            ),
          ),
      ),
    );
  }

  const rows = await db
    .select({ sale: sales, clientName: clients.fullName, clientPhone: clients.phone })
    .from(sales)
    .leftJoin(clients, eq(clients.id, sales.clientId))
    .where(and(...filters))
    .orderBy(desc(sales.createdAt))
    .limit(query.limit)
    .offset(query.offset);

  const ids = rows.map((row) => row.sale.id);

  const itemRows = ids.length
    ? await db
        .select({
          saleId: saleItems.saleId,
          petId: saleItems.petId,
          petName: pets.name,
          itemType: saleItems.itemType,
          name: saleItems.name,
          qty: saleItems.qty,
          totalCents: saleItems.totalCents,
        })
        .from(saleItems)
        .leftJoin(pets, eq(pets.id, saleItems.petId))
        .where(
          and(
            eq(saleItems.businessId, businessId),
            inArray(saleItems.saleId, ids),
          ),
        )
    : [];

  const paymentRows = ids.length
    ? await db
        .select({
          saleId: payments.saleId,
          amountCents: payments.amountCents,
          kind: payments.kind,
        })
        .from(payments)
        .where(
          and(eq(payments.businessId, businessId), inArray(payments.saleId, ids)),
        )
    : [];

  const itemsBySale = new Map<string, typeof itemRows>();
  for (const item of itemRows) {
    const list = itemsBySale.get(item.saleId) ?? [];
    list.push(item);
    itemsBySale.set(item.saleId, list);
  }

  const positionBySale = new Map<string, ReturnType<typeof moneyPosition>>();
  const movementsBySale = new Map<string, typeof paymentRows>();
  for (const payment of paymentRows) {
    const list = movementsBySale.get(payment.saleId) ?? [];
    list.push(payment);
    movementsBySale.set(payment.saleId, list);
  }

  for (const row of rows) {
    positionBySale.set(
      row.sale.id,
      moneyPosition(
        row.sale.totalCents,
        (movementsBySale.get(row.sale.id) ?? []).map((payment) => ({
          amountCents: payment.amountCents,
          kind: payment.kind,
        })),
      ),
    );
  }

  return c.json({
    data: rows.map((row) => {
      const items = itemsBySale.get(row.sale.id) ?? [];
      const position = positionBySale.get(row.sale.id);
      return {
        ...row.sale,
        createdAtLocal: utcToLocal(sqliteToIso(row.sale.createdAt), BOGOTA_TZ),
        clientName: row.clientName ?? null,
        clientPhone: row.clientPhone ?? null,
        paidCents: position?.paidCents ?? 0,
        refundedCents: position?.refundedCents ?? 0,
        netPaidCents: position?.netPaidCents ?? 0,
        pendingCents: position?.pendingCents ?? 0,
        overpaidCents: position?.overpaidCents ?? 0,
        petNames: [
          ...new Set(items.map((item) => item.petName).filter(Boolean) as string[]),
        ],
        services: items
          .filter((item) => item.itemType === 'service')
          .map((item) => item.name),
        itemCount: items.reduce((total, item) => total + item.qty, 0),
      };
    }),
    pagination: { limit: query.limit, offset: query.offset, count: rows.length },
  });
});

/**
 * Resumen económico. Separa lo vendido de lo cobrado, y lo cobrado de lo
 * reembolsado: `netCollectedCents` es el dinero que realmente quedó.
 */
saleRoutes.get('/summary', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const query = parse(salesSummaryQuerySchema, c.req.query());

  const from = query.from
    ? isoToSqlite(dayRangeUtc(query.from).startUtc)
    : '0000-01-01 00:00:00';
  const to = query.to
    ? isoToSqlite(dayRangeUtc(query.to).endUtc)
    : '9999-12-31 23:59:59';

  const [totals] = await db.all<{
    sold: number;
    count: number;
    pending: number;
  }>(sql`
    SELECT COALESCE(SUM(s.total_cents), 0) AS sold,
           COUNT(*) AS count,
           COALESCE(SUM(CASE
             WHEN m.net >= s.total_cents THEN 0
             ELSE s.total_cents - COALESCE(m.net, 0)
           END), 0) AS pending
      FROM sales s
      LEFT JOIN (
        SELECT sale_id,
               SUM(CASE WHEN kind = 'refund' THEN -amount_cents ELSE amount_cents END) AS net
          FROM payments
         WHERE business_id = ${businessId}
         GROUP BY sale_id
      ) m ON m.sale_id = s.id
     WHERE s.business_id = ${businessId}
       AND s.status <> 'void'
       AND s.created_at >= ${from}
       AND s.created_at < ${to}
  `);

  const [refunds] = await db.all<{ collected: number; refunded: number }>(sql`
    SELECT
      COALESCE(SUM(CASE WHEN p.kind = 'payment' THEN p.amount_cents ELSE 0 END), 0) AS collected,
      COALESCE(SUM(CASE WHEN p.kind = 'refund' THEN p.amount_cents ELSE 0 END), 0) AS refunded
      FROM payments p
      JOIN sales s ON s.id = p.sale_id
     WHERE p.business_id = ${businessId}
       AND s.status <> 'void'
       AND p.paid_at >= ${from}
       AND p.paid_at < ${to}
  `);

  const [items] = await db.all<{
    services_cents: number;
    products_cents: number;
    services_count: number;
    products_count: number;
  }>(sql`
    SELECT
      COALESCE(SUM(CASE WHEN i.item_type = 'service' THEN i.total_cents ELSE 0 END), 0) AS services_cents,
      COALESCE(SUM(CASE WHEN i.item_type = 'product' THEN i.total_cents ELSE 0 END), 0) AS products_cents,
      COALESCE(SUM(CASE WHEN i.item_type = 'service' THEN 1 ELSE 0 END), 0) AS services_count,
      COALESCE(SUM(CASE WHEN i.item_type = 'product' THEN i.qty ELSE 0 END), 0) AS products_count
      FROM sale_items i
      JOIN sales s ON s.id = i.sale_id
     WHERE i.business_id = ${businessId}
       AND s.status <> 'void'
       AND s.created_at >= ${from}
       AND s.created_at < ${to}
  `);

  const expenseFilters: SQL[] = [
    eq(expenses.businessId, businessId),
    isNull(expenses.deletedAt),
  ];
  if (query.from) expenseFilters.push(gte(expenses.incurredAt, query.from));
  if (query.to) expenseFilters.push(lte(expenses.incurredAt, query.to));

  const [expenseTotals] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${expenses.amountCents}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(expenses)
    .where(and(...expenseFilters));

  const collected = Number(refunds?.collected ?? 0);
  const refunded = Number(refunds?.refunded ?? 0);
  const expensesCents = Number(expenseTotals?.total ?? 0);

  return c.json({
    data: {
      from: query.from ?? null,
      to: query.to ?? null,
      salesCount: Number(totals?.count ?? 0),
      soldCents: Number(totals?.sold ?? 0),
      pendingCents: Number(totals?.pending ?? 0),
      collectedCents: collected,
      refundedCents: refunded,
      netCollectedCents: collected - refunded,
      servicesCents: Number(items?.services_cents ?? 0),
      servicesCount: Number(items?.services_count ?? 0),
      productsCents: Number(items?.products_cents ?? 0),
      productsCount: Number(items?.products_count ?? 0),
      expensesCents,
      expenseCount: Number(expenseTotals?.count ?? 0),
    },
  });
});

saleRoutes.get('/:id', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const sale = await loadSale(db, businessId, c.req.param('id'));
  if (!sale) throw notFound('Venta no encontrada');
  return c.json({ data: sale });
});

saleRoutes.post('/', idempotent, async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const body = parse(saleCreateSchema, await readJson(c));

  const petIds = [
    ...new Set(
      body.items
        .map((item) => item.petId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  const petRows = petIds.length
    ? await db
        .select({ id: pets.id, clientId: pets.clientId })
        .from(pets)
        .where(and(eq(pets.businessId, businessId), inArray(pets.id, petIds)))
    : [];
  const petById = new Map(petRows.map((pet) => [pet.id, pet]));

  const clientId =
    body.clientId ??
    (petIds.length > 0 ? petById.get(petIds[0] ?? '')?.clientId : undefined) ??
    null;

  if (clientId !== null) {
    await requireClient(db, businessId, clientId);
  }
  if (body.appointmentId) {
    await requireAppointment(db, businessId, body.appointmentId);
  }

  const lines = await resolveItems(db, businessId, clientId, body.items);
  const subtotalCents = lines.reduce((total, line) => total + line.totalCents, 0);

  if (body.discountCents > subtotalCents) {
    throw unprocessable('El descuento no puede superar el subtotal', [
      { path: 'discountCents', message: 'Revisa el descuento' },
    ]);
  }

  const totalCents = subtotalCents - body.discountCents;
  const paid = body.payments.reduce(
    (sum, payment) => sum + payment.amountCents,
    0,
  );

  if (paid > totalCents) {
    throw unprocessable('Los pagos superan el total de la venta', [
      { path: 'payments', message: `Total: ${totalCents} centavos` },
    ]);
  }

  const status = saleStatus(totalCents, paid);
  const saleId = crypto.randomUUID();
  const createdAt = body.soldOn
    ? saleTimestampForDay(body.soldOn)
    : nowSqliteMs();

  await db.transaction(async (tx) => {
    await tx.insert(sales).values({
      id: saleId,
      businessId,
      clientId,
      appointmentId: body.appointmentId ?? null,
      status,
      subtotalCents,
      discountCents: body.discountCents,
      totalCents,
      notes: body.notes ?? null,
      paidAt: status === 'paid' ? createdAt : null,
      createdBy: userId,
      createdAt,
    });

    await tx.insert(saleItems).values(
      lines.map((line) => ({
        id: line.id,
        businessId,
        saleId,
        itemType: line.type,
        itemId: line.itemId,
        name: line.name,
        petId: line.petId,
        appointmentId: body.appointmentId ?? null,
        qty: line.qty,
        unitPriceCents: line.unitPriceCents,
        discountCents: line.discountCents,
        totalCents: line.totalCents,
        notes: line.notes,
        createdAt,
      })),
    );

    for (const line of lines) {
      if (line.type !== 'product' || !line.itemId) continue;

      const [updated] = await tx
        .update(products)
        .set({
          stock: sql`${products.stock} - ${line.qty}`,
          updatedAt: nowSqliteMs(),
        })
        .where(
          and(
            eq(products.id, line.itemId),
            eq(products.businessId, businessId),
            gte(products.stock, line.qty),
          ),
        )
        .returning({ id: products.id });

      if (!updated) {
        throw conflict(
          'insufficient_stock',
          `No hay stock suficiente de ${line.name}`,
          { productId: line.itemId, qty: line.qty },
        );
      }

      await tx.insert(stockMovements).values({
        id: crypto.randomUUID(),
        businessId,
        productId: line.itemId,
        delta: -line.qty,
        reason: `Venta ${saleId.slice(0, 8)}`,
        refType: 'sale',
        refId: saleId,
      });
    }

    if (body.payments.length > 0) {
      await tx.insert(payments).values(
        body.payments.map((payment) => ({
          id: crypto.randomUUID(),
          businessId,
          saleId,
          method: payment.method,
          amountCents: payment.amountCents,
          kind: 'payment' as const,
          reference: payment.reference ?? null,
          paidAt: createdAt,
        })),
      );
    }
  });

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'sale.create',
    entity: 'sale',
    entityId: saleId,
    diff: {
      totalCents: { from: null, to: totalCents },
      paidCents: { from: null, to: paid },
      items: { from: null, to: lines.length },
      status: { from: null, to: status },
    },
  });

  const sale = await loadSale(db, businessId, saleId);
  return c.json({ data: sale }, 201);
});

/**
 * Corregir una venta.
 *
 * Reemplaza las líneas y recalcula totales. En productos solo se mueve la
 * DIFERENCIA de inventario:
 *   · subir cantidad  → descuenta la diferencia
 *   · bajar cantidad  → devuelve la diferencia
 *   · quitar la línea → devuelve lo que quede sin devolver
 *
 * No toca el dinero recibido. Si el total baja por debajo de lo cobrado, la
 * venta queda con saldo a favor (`overpaidCents`) y la devolución se registra
 * aparte, con su propio endpoint.
 */
saleRoutes.patch('/:id', idempotent, async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const saleId = c.req.param('id');
  const body = parse(saleUpdateSchema, await readJson(c));

  const [sale] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
    .limit(1);

  if (!sale) throw notFound('Venta no encontrada');
  if (sale.status === 'void') {
    throw conflict('sale_void', 'No se puede editar una venta anulada');
  }

  const currentItems = await db
    .select()
    .from(saleItems)
    .where(
      and(eq(saleItems.saleId, saleId), eq(saleItems.businessId, businessId)),
    );
  const currentById = new Map(currentItems.map((item) => [item.id, item]));

  let clientId = body.clientId ?? sale.clientId ?? null;
  if (clientId === null) {
    const firstPetId = body.items.find((item) => item.petId)?.petId;
    if (firstPetId) {
      const [pet] = await db
        .select({ clientId: pets.clientId })
        .from(pets)
        .where(
          and(eq(pets.id, firstPetId), eq(pets.businessId, businessId)),
        )
        .limit(1);
      clientId = pet?.clientId ?? null;
    }
  }

  if (clientId !== null) {
    await requireClient(db, businessId, clientId);
  }
  if (body.appointmentId) {
    await requireAppointment(db, businessId, body.appointmentId);
  }

  const lines = await resolveItems(
    db,
    businessId,
    clientId,
    body.items as ItemInput[],
    currentById,
  );

  // No se puede reducir una línea por debajo de lo ya devuelto.
  for (const line of lines) {
    const before = currentById.get(line.id);
    if (!before) continue;
    if (line.qty < before.returnedQty) {
      throw unprocessable(
        `La línea "${before.name}" ya tiene ${before.returnedQty} unidad(es) devueltas`,
        [{ path: 'items', message: 'Ajusta la cantidad o anula la devolución' }],
      );
    }
  }

  const subtotalCents = lines.reduce((total, line) => total + line.totalCents, 0);
  if (body.discountCents > subtotalCents) {
    throw unprocessable('El descuento no puede superar el subtotal', [
      { path: 'discountCents', message: 'Revisa el descuento' },
    ]);
  }
  const totalCents = subtotalCents - body.discountCents;

  const movements = await db
    .select({ amountCents: payments.amountCents, kind: payments.kind })
    .from(payments)
    .where(
      and(eq(payments.saleId, saleId), eq(payments.businessId, businessId)),
    );
  const net = netPaidCents(movements);
  const status = net >= totalCents ? 'paid' : 'open';

  const keptIds = new Set(lines.map((line) => line.id));
  const removed = currentItems.filter((item) => !keptIds.has(item.id));

  await db.transaction(async (tx) => {
    await tx
      .update(sales)
      .set({
        clientId,
        ...(body.soldOn ? { createdAt: saleTimestampForDay(body.soldOn) } : {}),
        appointmentId: body.appointmentId ?? sale.appointmentId,
        subtotalCents,
        discountCents: body.discountCents,
        totalCents,
        notes: body.notes ?? null,
        status,
        paidAt: status === 'paid' ? sale.paidAt ?? nowSqliteMs() : null,
      })
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)));

    // Líneas eliminadas: devolver lo que quede sin devolver.
    for (const item of removed) {
      if (item.itemType === 'product' && item.itemId) {
        const remaining = item.qty - item.returnedQty;
        if (remaining > 0) {
          await tx
            .update(products)
            .set({
              stock: sql`${products.stock} + ${remaining}`,
              updatedAt: nowSqliteMs(),
            })
            .where(
              and(
                eq(products.id, item.itemId),
                eq(products.businessId, businessId),
              ),
            );
          await tx.insert(stockMovements).values({
            id: crypto.randomUUID(),
            businessId,
            productId: item.itemId,
            delta: remaining,
            reason: `Corrección venta ${saleId.slice(0, 8)} (línea eliminada)`,
            refType: 'sale_adjust',
            refId: saleId,
          });
        }
      }
      await tx
        .delete(saleItems)
        .where(
          and(eq(saleItems.id, item.id), eq(saleItems.businessId, businessId)),
        );
    }

    for (const line of lines) {
      const before = currentById.get(line.id);

      if (!before) {
        await tx.insert(saleItems).values({
          id: line.id,
          businessId,
          saleId,
          itemType: line.type,
          itemId: line.itemId,
          name: line.name,
          petId: line.petId,
          appointmentId: body.appointmentId ?? sale.appointmentId,
          qty: line.qty,
          unitPriceCents: line.unitPriceCents,
          discountCents: line.discountCents,
          totalCents: line.totalCents,
          notes: line.notes,
          createdAt: nowSqliteMs(),
        });

        if (line.type === 'product' && line.itemId) {
          const [updated] = await tx
            .update(products)
            .set({
              stock: sql`${products.stock} - ${line.qty}`,
              updatedAt: nowSqliteMs(),
            })
            .where(
              and(
                eq(products.id, line.itemId),
                eq(products.businessId, businessId),
                gte(products.stock, line.qty),
              ),
            )
            .returning({ id: products.id });

          if (!updated) {
            throw conflict(
              'insufficient_stock',
              `No hay stock suficiente de ${line.name}`,
            );
          }

          await tx.insert(stockMovements).values({
            id: crypto.randomUUID(),
            businessId,
            productId: line.itemId,
            delta: -line.qty,
            reason: `Corrección venta ${saleId.slice(0, 8)} (línea nueva)`,
            refType: 'sale_adjust',
            refId: saleId,
          });
        }
        continue;
      }

      await tx
        .update(saleItems)
        .set({
          itemType: line.type,
          itemId: line.itemId,
          name: line.name,
          petId: line.petId,
          qty: line.qty,
          unitPriceCents: line.unitPriceCents,
          discountCents: line.discountCents,
          totalCents: line.totalCents,
          notes: line.notes,
        })
        .where(
          and(eq(saleItems.id, line.id), eq(saleItems.businessId, businessId)),
        );

      // Solo la diferencia de cantidad mueve inventario.
      const delta = line.qty - before.qty;
      if (line.type === 'product' && line.itemId && delta !== 0) {
        if (delta > 0) {
          const [updated] = await tx
            .update(products)
            .set({
              stock: sql`${products.stock} - ${delta}`,
              updatedAt: nowSqliteMs(),
            })
            .where(
              and(
                eq(products.id, line.itemId),
                eq(products.businessId, businessId),
                gte(products.stock, delta),
              ),
            )
            .returning({ id: products.id });

          if (!updated) {
            throw conflict(
              'insufficient_stock',
              `No hay stock suficiente de ${line.name}`,
            );
          }
        } else {
          await tx
            .update(products)
            .set({
              stock: sql`${products.stock} + ${Math.abs(delta)}`,
              updatedAt: nowSqliteMs(),
            })
            .where(
              and(
                eq(products.id, line.itemId),
                eq(products.businessId, businessId),
              ),
            );
        }

        await tx.insert(stockMovements).values({
          id: crypto.randomUUID(),
          businessId,
          productId: line.itemId,
          delta: -delta,
          reason: `Corrección venta ${saleId.slice(0, 8)}`,
          refType: 'sale_adjust',
          refId: saleId,
        });
      }
    }
  });

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'sale.update',
    entity: 'sale',
    entityId: saleId,
    diff: {
      totalCents: { from: sale.totalCents, to: totalCents },
      subtotalCents: { from: sale.subtotalCents, to: subtotalCents },
      discountCents: { from: sale.discountCents, to: body.discountCents },
      items: { from: currentItems.length, to: lines.length },
      status: { from: sale.status, to: status },
    },
  });

  const detail = await loadSale(db, businessId, saleId);
  return c.json({ data: detail });
});

saleRoutes.post('/:id/payments', idempotent, async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const saleId = c.req.param('id');
  const body = parse(salePaymentCreateSchema, await readJson(c));

  const [sale] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
    .limit(1);

  if (!sale) throw notFound('Venta no encontrada');
  if (sale.status === 'void') {
    throw conflict('sale_void', 'No se puede abonar a una venta anulada');
  }

  const movements = await db
    .select({ amountCents: payments.amountCents, kind: payments.kind })
    .from(payments)
    .where(
      and(eq(payments.saleId, saleId), eq(payments.businessId, businessId)),
    );

  const net = netPaidCents(movements);
  if (net + body.amountCents > sale.totalCents) {
    throw unprocessable('El abono supera el saldo pendiente', [
      {
        path: 'amountCents',
        message: `Pendiente: ${sale.totalCents - net} centavos`,
      },
    ]);
  }

  const paidAt = nowSqliteMs();
  const totalPaid = net + body.amountCents;

  await db.transaction(async (tx) => {
    await tx.insert(payments).values({
      id: crypto.randomUUID(),
      businessId,
      saleId,
      method: body.method,
      amountCents: body.amountCents,
      kind: 'payment',
      reference: body.reference ?? null,
      paidAt,
    });

    await tx
      .update(sales)
      .set({
        status: totalPaid >= sale.totalCents ? 'paid' : 'open',
        paidAt: totalPaid >= sale.totalCents ? paidAt : null,
      })
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)));
  });

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'sale.payment',
    entity: 'sale',
    entityId: saleId,
    diff: {
      amountCents: { from: net, to: totalPaid },
      method: { from: null, to: body.method },
    },
  });

  const detail = await loadSale(db, businessId, saleId);
  return c.json({ data: detail }, 201);
});

/**
 * Devolución de dinero. Se registra como un movimiento negativo explícito;
 * nunca se borran ni se editan los pagos anteriores.
 */
saleRoutes.post('/:id/refunds', idempotent, async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const saleId = c.req.param('id');
  const body = parse(saleRefundSchema, await readJson(c));

  const [sale] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
    .limit(1);

  if (!sale) throw notFound('Venta no encontrada');

  const movements = await db
    .select({ amountCents: payments.amountCents, kind: payments.kind })
    .from(payments)
    .where(
      and(eq(payments.saleId, saleId), eq(payments.businessId, businessId)),
    );

  const position = moneyPosition(sale.totalCents, movements);

  if (body.amountCents > position.netPaidCents) {
    throw unprocessable('No puedes devolver más dinero del que se recibió', [
      {
        path: 'amountCents',
        message: `Disponible para devolver: ${position.netPaidCents} centavos`,
      },
    ]);
  }

  const paidAt = nowSqliteMs();
  const netAfter = position.netPaidCents - body.amountCents;
  const status =
    sale.status === 'void'
      ? 'void'
      : netAfter >= sale.totalCents
        ? 'paid'
        : 'open';

  await db.transaction(async (tx) => {
    await tx.insert(payments).values({
      id: crypto.randomUUID(),
      businessId,
      saleId,
      method: body.method,
      amountCents: body.amountCents,
      kind: 'refund',
      reference: body.reference ?? null,
      notes: body.notes ?? null,
      paidAt,
    });

    await tx
      .update(sales)
      .set({
        status,
        paidAt: status === 'paid' ? sale.paidAt ?? paidAt : null,
      })
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)));
  });

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'sale.refund',
    entity: 'sale',
    entityId: saleId,
    diff: {
      refundedCents: { from: position.refundedCents, to: position.refundedCents + body.amountCents },
      method: { from: null, to: body.method },
      reason: { from: null, to: body.notes ?? null },
    },
  });

  const detail = await loadSale(db, businessId, saleId);
  return c.json({ data: detail }, 201);
});

/**
 * Devolver productos al inventario. Es independiente de anular: se puede
 * devolver mercancía de una venta que sigue vigente (cambio de talla, etc.).
 */
saleRoutes.post('/:id/returns', idempotent, async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const saleId = c.req.param('id');
  const body = parse(saleReturnSchema, await readJson(c));

  const [sale] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
    .limit(1);

  if (!sale) throw notFound('Venta no encontrada');

  const items = await db
    .select()
    .from(saleItems)
    .where(
      and(eq(saleItems.saleId, saleId), eq(saleItems.businessId, businessId)),
    );

  const productLines = items.filter(
    (item) => item.itemType === 'product' && item.itemId,
  );

  if (productLines.length === 0) {
    throw unprocessable('Esta venta no tiene artículos que devolver');
  }

  const targets = body.items
    ? body.items.map((requested) => {
        const line = productLines.find((item) => item.id === requested.saleItemId);
        if (!line) {
          throw unprocessable('La línea no pertenece a esta venta', [
            { path: 'items', message: requested.saleItemId },
          ]);
        }
        return { line, qty: requested.qty };
      })
    : productLines.map((line) => ({
        line,
        qty: line.qty - line.returnedQty,
      }));

  const effective = targets.filter((target) => target.qty > 0);
  if (effective.length === 0) {
    throw unprocessable('No queda nada por devolver');
  }

  for (const target of effective) {
    const remaining = target.line.qty - target.line.returnedQty;
    if (target.qty > remaining) {
      throw unprocessable('La cantidad a devolver supera lo pendiente', [
        {
          path: 'items',
          message: `${target.line.name}: quedan ${remaining}`,
        },
      ]);
    }
  }

  await db.transaction(async (tx) => {
    for (const target of effective) {
      await tx
        .update(products)
        .set({
          stock: sql`${products.stock} + ${target.qty}`,
          updatedAt: nowSqliteMs(),
        })
        .where(
          and(
            eq(products.id, target.line.itemId as string),
            eq(products.businessId, businessId),
          ),
        );

      await tx
        .update(saleItems)
        .set({ returnedQty: sql`${saleItems.returnedQty} + ${target.qty}` })
        .where(
          and(
            eq(saleItems.id, target.line.id),
            eq(saleItems.businessId, businessId),
          ),
        );

      await tx.insert(stockMovements).values({
        id: crypto.randomUUID(),
        businessId,
        productId: target.line.itemId as string,
        delta: target.qty,
        reason: body.reason ?? `Devolución venta ${saleId.slice(0, 8)}`,
        refType: 'sale_return',
        refId: saleId,
      });
    }
  });

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'sale.return',
    entity: 'sale',
    entityId: saleId,
    diff: {
      units: {
        from: 0,
        to: effective.reduce((total, target) => total + target.qty, 0),
      },
      lines: {
        from: null,
        to: effective.map((target) => ({
          name: target.line.name,
          qty: target.qty,
        })),
      },
      reason: { from: null, to: body.reason ?? null },
    },
  });

  const detail = await loadSale(db, businessId, saleId);
  return c.json({ data: detail }, 201);
});

/**
 * Anular. Por sí sola NO devuelve stock ni dinero: solo deja la venta fuera
 * de los ingresos. Si se piden explícitamente, se hacen las dos cosas en la
 * misma transacción, y solo una vez.
 */
saleRoutes.delete('/:id', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const saleId = c.req.param('id');

  const [sale] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
    .limit(1);

  if (!sale) throw notFound('Venta no encontrada');

  const items = await db
    .select()
    .from(saleItems)
    .where(
      and(eq(saleItems.saleId, saleId), eq(saleItems.businessId, businessId)),
    );

  await db.transaction(async (tx) => {
    // Los productos que no se habían devuelto vuelven al inventario.
    for (const item of items) {
      if (item.itemType !== 'product' || !item.itemId) continue;
      const qty = item.qty - item.returnedQty;
      if (qty <= 0) continue;

      await tx
        .update(products)
        .set({
          stock: sql`${products.stock} + ${qty}`,
          updatedAt: nowSqliteMs(),
        })
        .where(
          and(
            eq(products.id, item.itemId),
            eq(products.businessId, businessId),
          ),
        );
    }

    await tx
      .delete(stockMovements)
      .where(
        and(
          eq(stockMovements.businessId, businessId),
          eq(stockMovements.refId, saleId),
        ),
      );
    await tx
      .delete(payments)
      .where(
        and(eq(payments.saleId, saleId), eq(payments.businessId, businessId)),
      );
    await tx
      .delete(saleItems)
      .where(
        and(eq(saleItems.saleId, saleId), eq(saleItems.businessId, businessId)),
      );
    await tx
      .delete(sales)
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)));
  });

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'sale.delete',
    entity: 'sale',
    entityId: saleId,
    diff: {
      totalCents: { from: sale.totalCents, to: null },
      status: { from: sale.status, to: null },
      clientId: { from: sale.clientId, to: null },
      items: { from: items.length, to: 0 },
    },
  });

  return c.json({ data: { id: saleId, deleted: true } });
});

saleRoutes.post('/:id/void', idempotent, async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const saleId = c.req.param('id');
  const body = parse(saleVoidSchema, await readJsonOrEmpty(c));

  const [sale] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)))
    .limit(1);

  if (!sale) throw notFound('Venta no encontrada');

  if (sale.status === 'void') {
    const detail = await loadSale(db, businessId, saleId);
    return c.json({ data: detail });
  }

  const items = await db
    .select()
    .from(saleItems)
    .where(
      and(eq(saleItems.saleId, saleId), eq(saleItems.businessId, businessId)),
    );

  const movements = await db
    .select({ amountCents: payments.amountCents, kind: payments.kind })
    .from(payments)
    .where(
      and(eq(payments.saleId, saleId), eq(payments.businessId, businessId)),
    );

  const position = moneyPosition(sale.totalCents, movements);

  if (body.refund && body.refund.amountCents > position.netPaidCents) {
    throw unprocessable('La devolución supera el dinero recibido', [
      {
        path: 'refund.amountCents',
        message: `Disponible: ${position.netPaidCents} centavos`,
      },
    ]);
  }

  const toReturn = body.returnProducts
    ? items
        .filter((item) => item.itemType === 'product' && item.itemId)
        .map((item) => ({ line: item, qty: item.qty - item.returnedQty }))
        .filter((target) => target.qty > 0)
    : [];

  const paidAt = nowSqliteMs();

  await db.transaction(async (tx) => {
    await tx
      .update(sales)
      .set({
        status: 'void',
        notes: body.notes ?? sale.notes,
      })
      .where(and(eq(sales.id, saleId), eq(sales.businessId, businessId)));

    for (const target of toReturn) {
      await tx
        .update(products)
        .set({
          stock: sql`${products.stock} + ${target.qty}`,
          updatedAt: nowSqliteMs(),
        })
        .where(
          and(
            eq(products.id, target.line.itemId as string),
            eq(products.businessId, businessId),
          ),
        );

      await tx
        .update(saleItems)
        .set({ returnedQty: sql`${saleItems.returnedQty} + ${target.qty}` })
        .where(
          and(
            eq(saleItems.id, target.line.id),
            eq(saleItems.businessId, businessId),
          ),
        );

      await tx.insert(stockMovements).values({
        id: crypto.randomUUID(),
        businessId,
        productId: target.line.itemId as string,
        delta: target.qty,
        reason: `Anulación venta ${saleId.slice(0, 8)}`,
        refType: 'sale_return',
        refId: saleId,
      });
    }

    if (body.refund) {
      await tx.insert(payments).values({
        id: crypto.randomUUID(),
        businessId,
        saleId,
        method: body.refund.method,
        amountCents: body.refund.amountCents,
        kind: 'refund',
        reference: body.refund.reference ?? null,
        notes: body.refund.notes ?? null,
        paidAt,
      });
    }
  });

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'sale.void',
    entity: 'sale',
    entityId: saleId,
    diff: {
      status: { from: sale.status, to: 'void' },
      returnedUnits: {
        from: 0,
        to: toReturn.reduce((total, target) => total + target.qty, 0),
      },
      refundCents: { from: 0, to: body.refund?.amountCents ?? 0 },
    },
  });

  const detail = await loadSale(db, businessId, saleId);
  return c.json({ data: detail });
});
