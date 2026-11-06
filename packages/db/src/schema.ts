import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Espejo exacto de migrations/0000-0002.
 * Las migraciones SQL son la fuente de verdad; esto solo tipa las consultas.
 *
 * Claves primarias existentes (no cambiar):
 *  - clients.id              INTEGER AUTOINCREMENT
 *  - whatsapp_events.event_id TEXT
 *  - whatsapp_messages.message_id TEXT
 */

const timestamps = {
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
};

// --- Tenancy ---------------------------------------------------------------

export const businesses = sqliteTable('businesses', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  timezone: text('timezone').notNull().default('America/Bogota'),
  currency: text('currency').notNull().default('COP'),
  status: text('status', { enum: ['active', 'suspended', 'closed'] })
    .notNull()
    .default('active'),
  ...timestamps,
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  lastLoginAt: text('last_login_at'),
  ...timestamps,
});

export const memberships = sqliteTable(
  'memberships',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', {
      enum: ['owner', 'admin', 'groomer', 'receptionist'],
    }).notNull(),
    active: integer('active').notNull().default(1),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [uniqueIndex('uq_memberships_business_user').on(t.businessId, t.userId)],
);

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  businessId: text('business_id')
    .notNull()
    .references(() => businesses.id),
  expiresAt: text('expires_at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    diffJson: text('diff_json'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index('idx_audit_business_created').on(t.businessId, t.createdAt)],
);

/**
 * Solo fallos de login. Los logins exitosos se registran en audit_log.
 * Un solo administrador por negocio: no hay roles que gestionar.
 */
export const loginFailures = sqliteTable(
  'login_failures',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    ip: text('ip'),
    attemptedAt: text('attempted_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index('idx_login_failures_email_time').on(t.email, t.attemptedAt),
    index('idx_login_failures_ip_time').on(t.ip, t.attemptedAt),
  ],
);

/**
 * Claves de idempotencia: evitan que un doble clic o un reintento de red
 * cree dos citas. La respuesta se guarda para poder repetirla tal cual.
 */
export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    idemKey: text('idem_key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex('uq_idempotency_business_key').on(t.businessId, t.idemKey),
    index('idx_idempotency_created').on(t.createdAt),
  ],
);

// --- Clientes (tabla existente) -------------------------------------------

export const clients = sqliteTable(
  'clients',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    businessId: text('business_id').notNull().default('keyko'),
    whatsappContactKey: text('whatsapp_contact_key').notNull(),
    whatsappBsuid: text('whatsapp_bsuid'),
    whatsappUsername: text('whatsapp_username'),
    phone: text('phone'),
    whatsappName: text('whatsapp_name'),
    fullName: text('full_name'),
    notes: text('notes'),
    ...timestamps,
    email: text('email'),
    extraJson: text('extra_json'),
    source: text('source').default('manual'),
    consentMarketing: integer('consent_marketing').notNull().default(0),
    /** { unknown: string[], na: string[] } para la completitud de perfil. */
    profileFlagsJson: text('profile_flags_json'),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    uniqueIndex('clients_business_id_whatsapp_contact_key_unique').on(
      t.businessId,
      t.whatsappContactKey,
    ),
    index('idx_clients_business').on(t.businessId),
    index('idx_clients_phone').on(t.businessId, t.phone),
    index('idx_clients_deleted').on(t.businessId, t.deletedAt),
  ],
);

// --- Mascotas --------------------------------------------------------------

export const pets = sqliteTable(
  'pets',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    name: text('name').notNull(),
    species: text('species', { enum: ['perro', 'gato', 'otro'] })
      .notNull()
      .default('perro'),
    breed: text('breed'),
    sex: text('sex', { enum: ['macho', 'hembra'] }),
    birthdate: text('birthdate'),
    /** Edad declarada, sin inferir una fecha de nacimiento. */
    ageYears: integer('age_years'),
    weightKg: real('weight_kg'),
    allergies: text('allergies'),
    temperament: text('temperament'),
    photoUrl: text('photo_url'),
    /** Clave del objeto en R2; null si la foto es una URL externa. */
    photoKey: text('photo_key'),
    photoMetaJson: text('photo_meta_json'),
    active: integer('active').notNull().default(1),
    ...timestamps,
    profileFlagsJson: text('profile_flags_json'),
    deletedAt: text('deleted_at'),
  },
  (t) => [index('idx_pets_business_client').on(t.businessId, t.clientId)],
);

export const petHealthRecords = sqliteTable(
  'pet_health_records',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    petId: text('pet_id')
      .notNull()
      .references(() => pets.id),
    type: text('type', {
      enum: ['vaccine', 'allergy', 'condition', 'note'],
    }).notNull(),
    description: text('description').notNull(),
    occurredAt: text('occurred_at').notNull(),
    vetName: text('vet_name'),
    nextDueAt: text('next_due_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index('idx_health_business_pet').on(t.businessId, t.petId, t.occurredAt)],
);

export const petNotes = sqliteTable('pet_notes', {
  id: text('id').primaryKey(),
  businessId: text('business_id')
    .notNull()
    .references(() => businesses.id),
  petId: text('pet_id')
    .notNull()
    .references(() => pets.id),
  appointmentId: text('appointment_id'),
  authorId: text('author_id').references(() => users.id),
  body: text('body').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// --- Catálogo --------------------------------------------------------------

export const services = sqliteTable(
  'services',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    name: text('name').notNull(),
    category: text('category'),
    durationMin: integer('duration_min').notNull().default(30),
    priceCents: integer('price_cents').notNull(),
    active: integer('active').notNull().default(1),
    ...timestamps,
    deletedAt: text('deleted_at'),
  },
  (t) => [index('idx_services_business').on(t.businessId, t.active)],
);

export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    sku: text('sku'),
    name: text('name').notNull(),
    priceCents: integer('price_cents').notNull(),
    costCents: integer('cost_cents').notNull().default(0),
    stock: integer('stock').notNull().default(0),
    minStock: integer('min_stock').notNull().default(0),
    active: integer('active').notNull().default(1),
    ...timestamps,
    deletedAt: text('deleted_at'),
  },
  (t) => [uniqueIndex('products_business_id_sku_unique').on(t.businessId, t.sku)],
);

export const stockMovements = sqliteTable(
  'stock_movements',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    productId: text('product_id')
      .notNull()
      .references(() => products.id),
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index('idx_stock_business_product').on(t.businessId, t.productId, t.createdAt)],
);

// --- Agenda ----------------------------------------------------------------

export const appointments = sqliteTable(
  'appointments',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    petId: text('pet_id')
      .notNull()
      .references(() => pets.id),
    groomerId: text('groomer_id').references(() => users.id),
    startsAt: text('starts_at').notNull(),
    endsAt: text('ends_at').notNull(),
    status: text('status', {
      enum: ['scheduled', 'confirmed', 'in_progress', 'done', 'no_show', 'cancelled'],
    })
      .notNull()
      .default('scheduled'),
    notes: text('notes'),
    createdBy: text('created_by').references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index('idx_appointments_business_start').on(t.businessId, t.startsAt),
    index('idx_appointments_business_pet').on(t.businessId, t.petId),
    index('idx_appointments_active_range')
      .on(t.businessId, t.startsAt, t.endsAt)
      .where(sql`status <> 'cancelled'`),
  ],
);

export const appointmentItems = sqliteTable('appointment_items', {
  id: text('id').primaryKey(),
  businessId: text('business_id')
    .notNull()
    .references(() => businesses.id),
  appointmentId: text('appointment_id')
    .notNull()
    .references(() => appointments.id),
  itemType: text('item_type', { enum: ['service', 'product'] }).notNull(),
  itemId: text('item_id').notNull(),
  qty: integer('qty').notNull().default(1),
  unitPriceCents: integer('unit_price_cents').notNull(),
  totalCents: integer('total_cents').notNull(),
});

// --- Ventas y pagos --------------------------------------------------------

export const sales = sqliteTable(
  'sales',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    clientId: integer('client_id').references(() => clients.id),
    appointmentId: text('appointment_id').references(() => appointments.id),
    status: text('status', { enum: ['open', 'paid', 'void'] })
      .notNull()
      .default('open'),
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    discountCents: integer('discount_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    notes: text('notes'),
    paidAt: text('paid_at'),
    createdBy: text('created_by').references(() => users.id),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index('idx_sales_business_created').on(t.businessId, t.createdAt),
    index('idx_sales_business_client').on(
      t.businessId,
      t.clientId,
      t.createdAt,
    ),
    index('idx_sales_business_status').on(t.businessId, t.status, t.createdAt),
  ],
);

export const saleItems = sqliteTable(
  'sale_items',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    saleId: text('sale_id')
      .notNull()
      .references(() => sales.id),
    itemType: text('item_type', { enum: ['service', 'product'] }).notNull(),
    /** Producto del catálogo; NULL en servicios escritos a mano. */
    itemId: text('item_id').references(() => products.id),
    /** Descripción congelada en el momento de la venta. */
    name: text('name').notNull(),
    petId: text('pet_id').references(() => pets.id),
    appointmentId: text('appointment_id').references(() => appointments.id),
    qty: integer('qty').notNull().default(1),
    unitPriceCents: integer('unit_price_cents').notNull(),
    discountCents: integer('discount_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),
    returnedQty: integer('returned_qty').notNull().default(0),
    notes: text('notes'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index('idx_sale_items_sale').on(t.saleId),
    index('idx_sale_items_business_pet').on(t.businessId, t.petId, t.createdAt),
    index('idx_sale_items_business_sale').on(t.businessId, t.saleId),
  ],
);

export const payments = sqliteTable(
  'payments',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    saleId: text('sale_id')
      .notNull()
      .references(() => sales.id),
    method: text('method', {
      enum: ['cash', 'card', 'transfer', 'nequi', 'daviplata', 'other'],
    }).notNull(),
    amountCents: integer('amount_cents').notNull(),
    /** 'payment' entra dinero; 'refund' lo devuelve. */
    kind: text('kind', { enum: ['payment', 'refund'] })
      .notNull()
      .default('payment'),
    reference: text('reference'),
    notes: text('notes'),
    paidAt: text('paid_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index('idx_payments_business_paid').on(t.businessId, t.paidAt),
    index('idx_payments_sale').on(t.saleId),
    index('idx_payments_business_kind').on(t.businessId, t.kind, t.paidAt),
  ],
);

// --- Finanzas --------------------------------------------------------------

export const expenses = sqliteTable(
  'expenses',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    category: text('category').notNull(),
    reason: text('reason').notNull(),
    amountCents: integer('amount_cents').notNull(),
    incurredAt: text('incurred_at').notNull(),
    vendor: text('vendor'),
    receiptUrl: text('receipt_url'),
    createdBy: text('created_by').references(() => users.id),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text('deleted_at'),
  },
  (t) => [index('idx_expenses_business_incurred').on(t.businessId, t.incurredAt)],
);

export const cashSessions = sqliteTable('cash_sessions', {
  id: text('id').primaryKey(),
  businessId: text('business_id')
    .notNull()
    .references(() => businesses.id),
  openedBy: text('opened_by').references(() => users.id),
  openedAt: text('opened_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  closedAt: text('closed_at'),
  openingCents: integer('opening_cents').notNull().default(0),
  closingCents: integer('closing_cents'),
});

export const cashMovements = sqliteTable('cash_movements', {
  id: text('id').primaryKey(),
  businessId: text('business_id')
    .notNull()
    .references(() => businesses.id),
  cashSessionId: text('cash_session_id')
    .notNull()
    .references(() => cashSessions.id),
  type: text('type', { enum: ['in', 'out'] }).notNull(),
  amountCents: integer('amount_cents').notNull(),
  reason: text('reason').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// --- WhatsApp --------------------------------------------------------------

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    clientId: integer('client_id').references(() => clients.id),
    waContact: text('wa_contact').notNull(),
    status: text('status', { enum: ['active', 'inactive', 'closed'] })
      .notNull()
      .default('active'),
    lastMessageAt: text('last_message_at'),
    assignedTo: text('assigned_to').references(() => users.id),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex('conversations_business_id_wa_contact_unique').on(
      t.businessId,
      t.waContact,
    ),
    index('idx_conversations_business_last').on(t.businessId, t.lastMessageAt),
  ],
);

export const whatsappEvents = sqliteTable(
  'whatsapp_events',
  {
    eventId: text('event_id').primaryKey(),
    eventType: text('event_type').notNull(),
    receivedAt: text('received_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    payloadJson: text('payload_json').notNull(),
    businessId: text('business_id').notNull().default('keyko'),
  },
  (t) => [
    index('idx_events_business_received').on(t.businessId, t.receivedAt),
    uniqueIndex('uq_events_business_event').on(t.businessId, t.eventId),
  ],
);

export const whatsappMessages = sqliteTable(
  'whatsapp_messages',
  {
    messageId: text('message_id').primaryKey(),
    conversationId: text('conversation_id'),
    direction: text('direction').notNull(),
    contactKey: text('contact_key'),
    contactPhone: text('contact_phone'),
    contactName: text('contact_name'),
    messageType: text('message_type'),
    body: text('body'),
    messageTimestamp: text('message_timestamp'),
    receivedAt: text('received_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    rawMessageJson: text('raw_message_json').notNull(),
    whatsappBsuid: text('whatsapp_bsuid'),
    whatsappUsername: text('whatsapp_username'),
    businessId: text('business_id').notNull().default('keyko'),
  },
  (t) => [
    index('idx_messages_contact').on(t.contactKey),
    index('idx_messages_conversation').on(t.conversationId),
    index('idx_messages_business_timestamp').on(t.businessId, t.messageTimestamp),
    index('idx_messages_business_contact').on(t.businessId, t.contactKey),
  ],
);

export const messageTranscriptions = sqliteTable(
  'message_transcriptions',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    messageId: text('message_id')
      .notNull()
      .references(() => whatsappMessages.messageId),
    status: text('status', {
      enum: ['pending', 'processing', 'completed', 'failed'],
    })
      .notNull()
      .default('pending'),
    provider: text('provider').notNull().default('openrouter'),
    model: text('model'),
    transcript: text('transcript'),
    /** Corrección humana; tiene prioridad sobre la transcripción automática. */
    manualTranscript: text('manual_transcript'),
    language: text('language'),
    durationSeconds: real('duration_seconds'),
    audioFormat: text('audio_format'),
    audioBytes: integer('audio_bytes'),
    attempts: integer('attempts').notNull().default(0),
    costUsdMicros: integer('cost_usd_micros').notNull().default(0),
    latencyMs: integer('latency_ms'),
    lastError: text('last_error'),
    transcribedAt: text('transcribed_at'),
    correctedAt: text('corrected_at'),
    correctedBy: text('corrected_by').references(() => users.id),
    purgedAt: text('purged_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex('uq_message_transcriptions_message').on(
      t.businessId,
      t.messageId,
    ),
    index('idx_message_transcriptions_status').on(t.businessId, t.status),
    index('idx_message_transcriptions_created').on(t.businessId, t.createdAt),
  ],
);

// --- IA --------------------------------------------------------------------

export const aiExtractions = sqliteTable(
  'ai_extractions',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    sourceType: text('source_type', {
      enum: ['message', 'appointment', 'manual'],
    }).notNull(),
    sourceId: text('source_id').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    rawResponse: text('raw_response').notNull(),
    parsedJson: text('parsed_json'),
    confidence: real('confidence'),
    status: text('status', {
      enum: ['pending', 'validated', 'rejected', 'applied'],
    })
      .notNull()
      .default('pending'),
    targetEntity: text('target_entity'),
    targetId: text('target_id'),
    reviewedBy: text('reviewed_by').references(() => users.id),
    reviewedAt: text('reviewed_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index('idx_ai_business_status').on(t.businessId, t.status, t.createdAt)],
);

export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    extractionId: text('extraction_id').references(() => aiExtractions.id),
    model: text('model').notNull(),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    /** Segundos de audio cuando la llamada fue una transcripción. */
    audioSeconds: real('audio_seconds'),
    costUsdMicros: integer('cost_usd_micros').notNull().default(0),
    latencyMs: integer('latency_ms'),
    /** Mensaje de error cuando la llamada falló. */
    error: text('error'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index('idx_ai_usage_business_created').on(t.businessId, t.createdAt)],
);

export const aiUsageMonthly = sqliteTable(
  'ai_usage_monthly',
  {
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    month: text('month').notNull(),
    model: text('model').notNull(),
    calls: integer('calls').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costUsdMicros: integer('cost_usd_micros').notNull().default(0),
    latencyMsAvg: integer('latency_ms_avg'),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [primaryKey({ columns: [t.businessId, t.month, t.model] })],
);

// --- Procesamiento de IA ---------------------------------------------------

export const aiJobs = sqliteTable(
  'ai_jobs',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    waContact: text('wa_contact').notNull(),
    messageIds: text('message_ids').notNull(),
    status: text('status', {
      enum: ['pending', 'processing', 'done', 'failed', 'skipped'],
    })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index('idx_ai_jobs_business_status').on(t.businessId, t.status, t.createdAt)],
);

export const aiProcessedMessages = sqliteTable(
  'ai_processed_messages',
  {
    messageId: text('message_id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    jobId: text('job_id'),
    processedAt: text('processed_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index('idx_ai_processed_business').on(t.businessId, t.processedAt)],
);

export const aiAlerts = sqliteTable(
  'ai_alerts',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    kind: text('kind', { enum: ['daily_budget', 'monthly_budget'] }).notNull(),
    threshold: integer('threshold').notNull(),
    spentUsdMicros: integer('spent_usd_micros').notNull(),
    budgetUsdMicros: integer('budget_usd_micros').notNull(),
    period: text('period').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex('uq_ai_alerts_business_kind_threshold_period').on(
      t.businessId,
      t.kind,
      t.threshold,
      t.period,
    ),
    index('idx_ai_alerts_business_created').on(t.businessId, t.createdAt),
  ],
);

export const fieldOverrides = sqliteTable(
  'field_overrides',
  {
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    entity: text('entity', { enum: ['client', 'pet'] }).notNull(),
    entityId: text('entity_id').notNull(),
    field: text('field').notNull(),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    primaryKey({ columns: [t.businessId, t.entity, t.entityId, t.field] }),
  ],
);


export const appointmentRequests = sqliteTable(
  'appointment_requests',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id),
    extractionId: text('extraction_id').references(() => aiExtractions.id),
    clientId: integer('client_id').references(() => clients.id),
    petId: text('pet_id').references(() => pets.id),
    contactKey: text('contact_key').notNull(),
    requestedService: text('requested_service'),
    requestedDate: text('requested_date'),
    requestedTime: text('requested_time'),
    startsAtLocal: text('starts_at_local'),
    durationMin: integer('duration_min'),
    status: text('status', {
      enum: ['pending', 'scheduled', 'confirmed', 'cancelled', 'discarded'],
    })
      .notNull()
      .default('pending'),
    confidence: real('confidence'),
    notes: text('notes'),
    appointmentId: text('appointment_id').references(() => appointments.id),
    confirmedAt: text('confirmed_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex('uq_appointment_requests_extraction').on(
      t.businessId,
      t.extractionId,
    ),
    index('idx_appointment_requests_business_status').on(
      t.businessId,
      t.status,
      t.createdAt,
    ),
    index('idx_appointment_requests_contact').on(
      t.businessId,
      t.contactKey,
      t.status,
    ),
  ],
);
