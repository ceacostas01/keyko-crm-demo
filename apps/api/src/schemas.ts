import { EXPENSE_CATEGORIES } from '@keyko/domain';
import { z } from 'zod';

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Marcas de "desconocido" / "no aplica" para la completitud de perfil. */
export const profileFlagsSchema = z
  .object({
    unknown: z.array(z.string().max(40)).max(20).optional(),
    na: z.array(z.string().max(40)).max(20).optional(),
  })
  .nullable();

const dateTime = z
  .string()
  .min(10)
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)) || /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value), {
    message: 'Fecha u hora inválida',
  });

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato esperado YYYY-MM-DD');

// --- Auth ------------------------------------------------------------------

export const loginSchema = z.object({
  email: z.email('Email inválido'),
  password: z.string().min(8).max(200),
  businessSlug: z.string().min(1).max(60).optional(),
});

// --- Clientes --------------------------------------------------------------

export const clientCreateSchema = z.object({
  fullName: z.string().min(2).max(120),
  phone: z.string().min(7).max(25),
  email: z.email('Email inválido').optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  extra: z.record(z.string(), z.unknown()).optional().nullable(),
  source: z.enum(['manual', 'whatsapp', 'referido']).optional(),
  consentMarketing: z.boolean().optional(),
});

export const clientUpdateSchema = clientCreateSchema.partial().extend({
  profileFlags: profileFlagsSchema.optional(),
});

export const clientQuerySchema = paginationSchema.extend({
  search: z.string().max(80).optional(),
});

// --- Mascotas --------------------------------------------------------------

export const petCreateSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  name: z.string().min(1).max(80),
  species: z.enum(['perro', 'gato']).optional(),
  breed: z.string().max(80).optional().nullable(),
  sex: z.enum(['macho', 'hembra']).optional().nullable(),
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato esperado YYYY-MM-DD')
    .optional()
    .nullable(),
  ageYears: z.coerce.number().min(0).max(40).optional().nullable(),
  weightKg: z.number().positive().max(200).optional().nullable(),
  allergies: z.string().max(1000).optional().nullable(),
  temperament: z.string().max(200).optional().nullable(),
  photoUrl: z.string().max(500).optional().nullable(),
});

export const petUpdateSchema = petCreateSchema
  .partial()
  .omit({ clientId: true })
  .extend({ profileFlags: profileFlagsSchema.optional() });

/**
 * `missing` acepta una lista separada por comas: photo,breed,age,weight,sex,name.
 * `completeness` filtra por tramos del porcentaje.
 */
export const petQuerySchema = paginationSchema.extend({
  search: z.string().max(80).optional(),
  species: z.enum(['perro', 'gato']).optional(),
  size: z.enum(['small', 'medium', 'large']).optional(),
  breed: z.string().max(80).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  missing: z.string().max(120).optional(),
  completeness: z.enum(['under50', 'mid', 'over80']).optional(),
});

// --- Servicios -------------------------------------------------------------

export const serviceCreateSchema = z.object({
  name: z.string().min(2).max(120),
  category: z.string().max(60).optional().nullable(),
  durationMin: z.coerce.number().int().min(5).max(480).optional(),
  priceCents: z.coerce.number().int().min(0).max(100_000_000),
  active: z.boolean().optional(),
});

export const serviceUpdateSchema = serviceCreateSchema.partial();

// --- Artículos -------------------------------------------------------------

export const productCreateSchema = z.object({
  sku: z.string().min(1).max(40).optional().nullable(),
  name: z.string().min(2).max(120),
  priceCents: z.coerce.number().int().min(0).max(100_000_000),
  costCents: z.coerce.number().int().min(0).max(100_000_000).optional(),
  stock: z.coerce.number().int().min(0).max(1_000_000).optional(),
  minStock: z.coerce.number().int().min(0).max(1_000_000).optional(),
  active: z.boolean().optional(),
});

export const productUpdateSchema = productCreateSchema
  .partial()
  .omit({ stock: true });

export const stockAdjustSchema = z.object({
  delta: z.coerce.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0, {
    message: 'El ajuste no puede ser cero',
  }),
  reason: z.string().min(2).max(200),
  refType: z.enum(['sale', 'appointment', 'manual', 'purchase']).optional().nullable(),
  refId: z.string().max(64).optional().nullable(),
});

// --- Citas -----------------------------------------------------------------

export const appointmentCreateSchema = z.object({
  clientId: z.coerce.number().int().positive().optional(),
  petId: z.string().min(1).max(64),
  groomerId: z.string().min(1).max(64).optional().nullable(),
  startsAt: dateTime,
  endsAt: dateTime.optional(),
  durationMin: z.coerce.number().int().min(5).max(480).optional(),
  notes: z.string().max(2000).optional().nullable(),
});

export const appointmentUpdateSchema = z.object({
  groomerId: z.string().min(1).max(64).optional().nullable(),
  startsAt: dateTime.optional(),
  endsAt: dateTime.optional(),
  durationMin: z.coerce.number().int().min(5).max(480).optional(),
  status: z
    .enum(['scheduled', 'confirmed', 'in_progress', 'done', 'no_show', 'cancelled'])
    .optional(),
  notes: z.string().max(2000).optional().nullable(),
});

export const appointmentQuerySchema = paginationSchema.extend({
  from: day.optional(),
  to: day.optional(),
  groomerId: z.string().max(64).optional(),
  status: z
    .enum(['scheduled', 'confirmed', 'in_progress', 'done', 'no_show', 'cancelled'])
    .optional(),
  /** Calcula cruces y advertencias para cada cita listada. */
  withConflicts: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export const reactivateSchema = z.object({
  status: z.enum(['scheduled', 'confirmed']).default('scheduled'),
});

export const availabilityQuerySchema = z.object({
  date: day,
  durationMin: z.coerce.number().int().min(5).max(480).default(60),
  groomerId: z.string().max(64).optional(),
  stepMin: z.coerce.number().int().min(15).max(120).default(30),
});

// --- Ventas ----------------------------------------------------------------

export const paymentMethodSchema = z.enum([
  'cash',
  'card',
  'transfer',
  'nequi',
  'daviplata',
  'other',
]);

export const salePaymentSchema = z.object({
  method: paymentMethodSchema,
  amountCents: z.coerce.number().int().positive().max(100_000_000),
  reference: z.string().max(120).optional().nullable(),
});

export const saleItemSchema = z.object({
  type: z.enum(['service', 'product']),
  /** Obligatorio en servicios; en productos se toma del catálogo si falta. */
  name: z.string().min(1).max(120).optional(),
  productId: z.string().max(64).optional().nullable(),
  petId: z.string().max(64).optional().nullable(),
  qty: z.coerce.number().int().min(1).max(999).default(1),
  unitPriceCents: z.coerce.number().int().min(0).max(100_000_000).optional(),
  discountCents: z.coerce.number().int().min(0).max(100_000_000).default(0),
  notes: z.string().max(500).optional().nullable(),
});

export const saleCreateSchema = z.object({
  clientId: z.coerce.number().int().positive().optional(),
  /** Día de la venta (YYYY-MM-DD). Por defecto, hoy. */
  soldOn: day.optional(),
  appointmentId: z.string().max(64).optional().nullable(),
  items: z.array(saleItemSchema).min(1).max(50),
  discountCents: z.coerce.number().int().min(0).max(100_000_000).default(0),
  notes: z.string().max(1000).optional().nullable(),
  payments: z.array(salePaymentSchema).max(10).default([]),
});

export const salePaymentCreateSchema = z.object({
  method: paymentMethodSchema,
  amountCents: z.coerce.number().int().positive().max(100_000_000),
  reference: z.string().max(120).optional().nullable(),
});

export const saleUpdateSchema = z.object({
  clientId: z.coerce.number().int().positive().optional(),
  soldOn: day.optional(),
  appointmentId: z.string().max(64).optional().nullable(),
  items: z
    .array(
      saleItemSchema.extend({
        /** Conserva la línea existente para auditar y controlar devoluciones. */
        id: z.string().max(64).optional(),
      }),
    )
    .min(1)
    .max(50),
  discountCents: z.coerce.number().int().min(0).max(100_000_000).default(0),
  notes: z.string().max(1000).optional().nullable(),
});

export const saleRefundSchema = z.object({
  method: paymentMethodSchema,
  amountCents: z.coerce.number().int().positive().max(100_000_000),
  reference: z.string().max(120).optional().nullable(),
  notes: z.string().max(300).optional().nullable(),
});

export const saleReturnSchema = z.object({
  items: z
    .array(
      z.object({
        saleItemId: z.string().min(1).max(64),
        qty: z.coerce.number().int().min(1).max(999),
      }),
    )
    .max(50)
    .optional(),
  reason: z.string().max(300).optional().nullable(),
});

export const saleVoidSchema = z.object({
  /** Sin esto, anular no toca el inventario. */
  returnProducts: z.boolean().default(false),
  /** Devolución de dinero explícita, en la misma operación. */
  refund: saleRefundSchema.optional(),
  notes: z.string().max(300).optional().nullable(),
});

export const saleQuerySchema = paginationSchema.extend({
  from: day.optional(),
  to: day.optional(),
  status: z.enum(['open', 'paid', 'void']).optional(),
  petId: z.string().max(64).optional(),
  clientId: z.coerce.number().int().positive().optional(),
});

export const salesSummaryQuerySchema = z.object({
  from: day.optional(),
  to: day.optional(),
});

// --- Egresos ---------------------------------------------------------------

const expenseCategory = z.enum(EXPENSE_CATEGORIES);

export const expenseCreateSchema = z.object({
  category: expenseCategory,
  reason: z.string().trim().min(2, 'Escribe un detalle').max(200),
  amountCents: z.coerce
    .number()
    .int()
    .positive('El monto debe ser mayor que cero')
    .max(1_000_000_000_000),
  incurredAt: day,
  vendor: z.string().trim().max(120).optional().nullable(),
});

export const expenseUpdateSchema = expenseCreateSchema.partial();

export const expenseQuerySchema = paginationSchema.extend({
  from: day.optional(),
  to: day.optional(),
  category: expenseCategory.optional(),
});

// --- Solicitudes de cita ---------------------------------------------------

export const appointmentRequestQuerySchema = paginationSchema.extend({
  status: z
    .enum(['pending', 'scheduled', 'confirmed', 'cancelled', 'discarded'])
    .default('pending'),
  contactKey: z.string().max(80).optional(),
});

export const appointmentRequestUpdateSchema = z.object({
  status: z.enum(['scheduled', 'confirmed', 'cancelled', 'discarded']),
  appointmentId: z.string().max(64).optional().nullable(),
  clientId: z.coerce.number().int().positive().optional().nullable(),
  petId: z.string().max(64).optional().nullable(),
});

// --- IA --------------------------------------------------------------------

export const aiSuggestionQuerySchema = paginationSchema.extend({
  status: z
    .enum(['pending', 'validated', 'rejected', 'applied'])
    .default('pending'),
});

export const aiProcessSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  /** Procesar solo esta conversación (reprocesamiento manual controlado). */
  contactKey: z.string().max(80).optional(),
});

export const aiAcceptSchema = z.object({
  fields: z.record(z.string(), z.unknown()).optional(),
  pets: z.array(z.record(z.string(), z.unknown())).max(5).optional(),
});

export const aiUsageQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// --- Conversaciones --------------------------------------------------------

export const conversationQuerySchema = paginationSchema.extend({
  status: z.enum(['active', 'inactive', 'closed']).optional(),
});

export const transcriptionCorrectionSchema = z.object({
  text: z.string().trim().min(1, 'Escribe la transcripción').max(4000),
});

// --- Auditoría -------------------------------------------------------------

export const auditQuerySchema = paginationSchema.extend({
  entity: z
    .enum(['user', 'client', 'pet', 'service', 'product', 'sale', 'appointment', 'message'])
    .optional(),
  action: z
    .enum([
      'auth.login',
      'client.create',
      'client.update',
      'client.delete',
      'pet.create',
      'pet.update',
      'pet.delete',
      'pet.purge',
      'service.create',
      'service.update',
      'service.delete',
      'product.create',
      'product.update',
      'product.delete',
      'product.stock',
      'sale.create',
      'sale.update',
      'sale.payment',
      'sale.refund',
      'sale.return',
      'sale.void',
      'sale.delete',
      'expense.create',
      'expense.update',
      'expense.delete',
      'appointment_request.create',
      'appointment_request.update',
      'ai.apply',
      'transcription.correct',
      'appointment.create',
      'appointment.update',
      'appointment.cancel',
      'appointment.reactivate',
    ])
    .optional(),
});
