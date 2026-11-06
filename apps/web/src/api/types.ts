export type Role = 'owner' | 'admin' | 'groomer' | 'receptionist';

export type Business = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
};

export type User = { id: string; email: string; name: string };

export type AuthResponse = {
  token: string;
  user: User;
  business: Business;
  role: Role;
};

export type MeResponse = {
  user: User;
  business: Business;
  role: Role;
};

export type Client = {
  id: number;
  businessId: string;
  phone: string | null;
  whatsappContactKey: string;
  whatsappName: string | null;
  fullName: string | null;
  email: string | null;
  notes: string | null;
  source: string | null;
  consentMarketing: number;
  extra: unknown;
  profileFlagsJson?: string | null;
  completeness?: Completeness;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type Pet = {
  id: string;
  businessId: string;
  clientId: number;
  name: string;
  species: 'perro' | 'gato';
  breed: string | null;
  sex: 'macho' | 'hembra' | null;
  birthdate: string | null;
  ageYears: number | null;
  weightKg: number | null;
  allergies: string | null;
  temperament: string | null;
  photoUrl: string | null;
  active: number;
  deletedAt: string | null;
};

export type Service = {
  id: string;
  name: string;
  category: string | null;
  durationMin: number;
  priceCents: number;
  active: number;
  deletedAt: string | null;
};

export type Product = {
  id: string;
  sku: string | null;
  name: string;
  priceCents: number;
  costCents: number;
  stock: number;
  minStock: number;
  active: number;
  deletedAt: string | null;
  movements?: StockMovement[];
};

export type StockMovement = {
  id: string;
  productId: string;
  delta: number;
  reason: string;
  refType: string | null;
  refId: string | null;
  createdAt: string;
};

export type AppointmentStatus =
  | 'scheduled'
  | 'confirmed'
  | 'in_progress'
  | 'done'
  | 'no_show'
  | 'cancelled';

export type Conflict = {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  startsAtLocal: string;
  endsAtLocal: string;
  overlapStart: string;
  overlapEnd: string;
  overlapMinutes: number;
  status: AppointmentStatus;
  groomerId: string | null;
  petId: string | null;
  petName: string | null;
  clientName: string | null;
};

export type WarningType = 'overlap' | 'outside_business_hours' | 'closed_day';

export type Warning = {
  type: WarningType;
  severity: 'warning';
  message: string;
  conflict?: Conflict;
};

export type Appointment = {
  id: string;
  businessId: string;
  clientId: number;
  petId: string;
  groomerId: string | null;
  startsAt: string;
  endsAt: string;
  startsAtLocal: string;
  endsAtLocal: string;
  status: AppointmentStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  warnings?: Warning[];
};

export type Paginated<T> = {
  data: T[];
  pagination: { limit: number; offset: number; count: number };
};

export type Availability = {
  date: string;
  timezone: string;
  advisory: boolean;
  open: boolean;
  businessHours: { open: string; close: string; closed: boolean };
  durationMin: number;
  stepMin: number;
  slots: Array<{ start: string; end: string; startLocal: string }>;
};

export type LastMessage = {
  body: string | null;
  direction: string;
  messageType: string | null;
  contactName: string | null;
  sentAt: string | null;
};

export type Conversation = {
  id: string;
  businessId: string;
  clientId: number | null;
  waContact: string;
  status: 'active' | 'inactive' | 'closed';
  lastMessageAt: string | null;
  assignedTo: string | null;
  createdAt: string;
  client: { id: number; name: string | null; phone: string | null } | null;
  contactName: string | null;
  lastMessage: LastMessage | null;
  completeness?: Completeness;
  hasPets?: boolean;
  missing?: string[];
};

export type Message = {
  messageId: string;
  direction: string;
  messageType: string | null;
  body: string | null;
  contactPhone: string | null;
  contactName: string | null;
  sentAt: string | null;
  receivedAt: string;
  transcription: MessageTranscription | null;
};

export type MessageTranscription = {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  text: string | null;
  originalText: string | null;
  error: string | null;
  attempts: number;
  durationSeconds: number | null;
  costUsdMicros: number;
  model: string | null;
  correctedAt: string | null;
};

export type ConversationDetail = Conversation & {
  messages: Message[];
  ai: {
    processedMessages: number;
    suggestions: number;
    lastJobStatus: string | null;
    lastError: string | null;
  };
};

export type AuditEntry = {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  actorId: string | null;
  actorName: string | null;
  diff: Record<string, { from: unknown; to: unknown }> | null;
  createdAt: string;
};

// --- Mascotas como entidad principal ---------------------------------------

export type PetSize = 'small' | 'medium' | 'large';

export type PetWithClient = Pet & {
  size: PetSize | null;
  sizeLabel: string | null;
  clientName: string | null;
  clientPhone: string | null;
  completeness?: Completeness;
};

export type PetHistoryEntry = {
  id: string;
  type: 'service' | 'product' | 'appointment' | 'health' | 'note';
  at: string;
  title: string;
  detail: string | null;
  amountCents: number | null;
  status: string | null;
  refId: string;
  saleId: string | null;
};

export type PetHistory = {
  pet: Pet & { size: PetSize | null; sizeLabel: string | null };
  completeness: Completeness;
  client: { id: number; name: string | null; phone: string | null; email: string | null };
  stats: {
    totalSpentCents: number;
    servicesCount: number;
    productsCount: number;
    salesCount: number;
    visitsCount: number;
    upcomingCount: number;
    lastServiceAt: string | null;
    lastServiceName: string | null;
  };
  appointments: Appointment[];
  timeline: PetHistoryEntry[];
};

// --- Ventas ----------------------------------------------------------------

export type PaymentMethod =
  | 'cash'
  | 'card'
  | 'transfer'
  | 'nequi'
  | 'daviplata'
  | 'other';

export type SaleItem = {
  id: string;
  saleId: string;
  itemType: 'service' | 'product';
  itemId: string | null;
  name: string;
  petId: string | null;
  petName: string | null;
  appointmentId: string | null;
  qty: number;
  unitPriceCents: number;
  discountCents: number;
  totalCents: number;
  returnedQty: number;
  notes: string | null;
  createdAt: string;
};

export type SalePayment = {
  id: string;
  saleId: string;
  method: PaymentMethod;
  amountCents: number;
  kind: 'payment' | 'refund';
  reference: string | null;
  notes: string | null;
  paidAt: string;
  paidAtLocal?: string;
};

export type SaleHistoryEntry = {
  id: string;
  action: string;
  actorName: string | null;
  diff: Record<string, unknown> | null;
  createdAt: string;
  createdAtLocal: string;
};

export type Sale = {
  id: string;
  clientId: number | null;
  appointmentId: string | null;
  status: 'open' | 'paid' | 'void';
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  notes: string | null;
  paidAt: string | null;
  createdAt: string;
  createdAtLocal?: string;
  paidCents: number;
  refundedCents: number;
  netPaidCents: number;
  pendingCents: number;
  overpaidCents: number;
  client: { id: number; name: string | null; phone: string | null } | null;
  items: SaleItem[];
  payments: SalePayment[];
  history: SaleHistoryEntry[];
};

export type SaleListRow = {
  id: string;
  clientId: number | null;
  appointmentId: string | null;
  status: 'open' | 'paid' | 'void';
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  notes: string | null;
  createdAt: string;
  createdAtLocal: string;
  clientName: string | null;
  clientPhone: string | null;
  paidCents: number;
  refundedCents: number;
  netPaidCents: number;
  pendingCents: number;
  overpaidCents: number;
  petNames: string[];
  services: string[];
  itemCount: number;
};

export type SaleSummary = {
  from: string | null;
  to: string | null;
  salesCount: number;
  soldCents: number;
  collectedCents: number;
  refundedCents: number;
  netCollectedCents: number;
  pendingCents: number;
  servicesCents: number;
  servicesCount: number;
  productsCents: number;
  productsCount: number;
  expensesCents: number;
  expenseCount: number;
};

export type Expense = {
  id: string;
  businessId: string;
  category: 'luz' | 'gas' | 'agua' | 'arriendo' | 'personal' | 'otro';
  reason: string;
  amountCents: number;
  incurredAt: string;
  vendor: string | null;
  createdBy: string | null;
  createdAt: string;
  deletedAt: string | null;
};

// --- Solicitudes de cita ---------------------------------------------------

export type AppointmentRequestStatus =
  | 'pending'
  | 'scheduled'
  | 'confirmed'
  | 'cancelled'
  | 'discarded';

export type AppointmentRequest = {
  id: string;
  businessId: string;
  extractionId: string | null;
  clientId: number | null;
  petId: string | null;
  contactKey: string;
  requestedService: string | null;
  requestedDate: string | null;
  requestedTime: string | null;
  startsAtLocal: string | null;
  durationMin: number | null;
  status: AppointmentRequestStatus;
  confidence: number | null;
  notes: string | null;
  appointmentId: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  clientName?: string | null;
  petName?: string | null;
  appointmentStartsAtLocal?: string | null;
  appointmentStatus?: string | null;
};

// --- Sugerencias de IA -----------------------------------------------------

export type AiSuggestionField = {
  field: string;
  label: string;
  value: unknown;
  confidence: number;
  evidence: string[];
  quotes: string[];
  conflict: boolean;
};

export type AiSuggestionPet = {
  fields: AiSuggestionField[];
};

export type AiSuggestionKind =
  | 'client_create'
  | 'client_update'
  | 'pet_create'
  | 'pet_update'
  | 'appointment_request'
  | 'availability_inquiry'
  | 'service_inquiry'
  | 'conversation_note';

export type AiConversationSuggestion = {
  intent?: string | null;
  requestedService: string | null;
  wantsAppointment: boolean;
  requestedDate: string | null;
  requestedTime: string | null;
  resolvedStart?: string | null;
  openQuestions: string[];
  notes: string | null;
};

export type AiSuggestion = {
  id: string;
  status: 'pending' | 'validated' | 'rejected' | 'applied';
  confidence: number | null;
  model: string;
  createdAt: string;
  targetEntity: string | null;
  targetId: string | null;
  kind: AiSuggestionKind;
  title: string;
  clientId: number | null;
  petId: string | null;
  fields: AiSuggestionField[];
  pets: AiSuggestionPet[];
  conversation: AiConversationSuggestion | null;
  contactKey: string | null;
  summary: string;
};

export type AiUsage = {
  enabled: boolean;
  provider: string;
  model: string;
  autoApply: boolean;
  autoCreatePets: boolean;
  verifyPetCandidates: boolean;
  visionEnabled: boolean;
  visionModel: string;
  transcriptionEnabled: boolean;
  transcriptionModel: string;
  transcriptionLanguage: string;
  autoCreateAppointmentRequests: boolean;
  autoConfirmAppointments: boolean;
  autoProcess: boolean;
  testContacts: string[];
  budgetUsdMicros: number;
  daily: { spentUsdMicros: number; budgetUsdMicros: number };
  monthlyBudget: { spentUsdMicros: number; budgetUsdMicros: number };
  monthlyUsage: Array<{
    month: string;
    model: string;
    calls: number;
    errors: number;
    tokensIn: number;
    tokensOut: number;
    costUsdMicros: number;
    latencyMsAvg: number | null;
  }>;
  blocked: 'daily' | 'monthly' | null;
  storeRawResponse: boolean;
  rawRetentionDays: number;
  alerts: Array<{
    id: string;
    kind: string;
    threshold: number;
    spentUsdMicros: number;
    budgetUsdMicros: number;
    period: string;
    createdAt: string;
  }>;
  calls: number;
  errors: number;
  tokensIn: number;
  tokensOut: number;
  audioSeconds: number;
  costUsdMicros: number;
  pendingSuggestions: number;
};

export type AiProcessResult = {
  enqueued: number;
  processed: number;
  failed: number;
  skipped: number;
  suggestions: number;
  applied: number;
  reason: string | null;
  enabled: boolean;
  provider: string;
  model: string;
  autoApply: boolean;
};

// --- Completitud de perfil ------------------------------------------------

export type CompletenessStatus =
  | 'complete'
  | 'missing'
  | 'pending'
  | 'unknown'
  | 'not_applicable';

export type CompletenessField = {
  key: string;
  label: string;
  weight: number;
  priority: 'high' | 'medium' | 'low';
  action: string;
  status: CompletenessStatus;
};

export type Completeness = {
  percent: number;
  earned: number;
  applicable: number;
  fields: CompletenessField[];
  complete: string[];
  missing: string[];
  pending: string[];
  unknown: string[];
  notApplicable: string[];
  priorities: CompletenessField[];
};

export type DataQualityContact = {
  conversationId: string;
  contactKey: string;
  contactName: string | null;
  phone: string | null;
};

export type DataQualityClient = {
  id: number;
  fullName: string | null;
  phone: string | null;
};

export type DataQualityPet = {
  id: string;
  name: string;
  clientId: number;
  clientName: string | null;
  percent: number;
};

export type DataQualitySummary = {
  contactsWithoutClient: number;
  clientsWithoutName: number;
  contactsWithoutPets: number;
  petsWithoutPhoto: number;
  petsIncomplete: number;
  averagePetCompleteness: number;
  totalClients: number;
  totalPets: number;
  details: {
    contactsWithoutClient: DataQualityContact[];
    clientsWithoutName: DataQualityClient[];
    contactsWithoutPets: DataQualityClient[];
    petsWithoutPhoto: DataQualityPet[];
    petsIncomplete: DataQualityPet[];
    allPets: DataQualityPet[];
  };
};
