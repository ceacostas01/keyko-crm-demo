#!/usr/bin/env bash
# Verifica que las migraciones se apliquen en orden sobre una base vacía
# y sobre una copia con datos "de producción".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$(mktemp -t keyko-mig-XXXXXX).db"
trap 'rm -f "$DB"' EXIT

say() { printf '%s\n' "$*"; }
fail() { printf 'FALLO: %s\n' "$*" >&2; exit 1; }
q() { sqlite3 -bail "$DB" "$1"; }

say "1. Aplicando baseline (0000)"
sqlite3 -bail "$DB" < "$ROOT/migrations/0000_baseline_prod.sql"

# El baseline debe reproducir exactamente las columnas de producción.
[ "$(q "SELECT COUNT(*) FROM pragma_table_info('clients');")" = "11" ] || fail "columnas clients (baseline)"
[ "$(q "SELECT COUNT(*) FROM pragma_table_info('whatsapp_events');")" = "4" ] || fail "columnas whatsapp_events (baseline)"
[ "$(q "SELECT COUNT(*) FROM pragma_table_info('whatsapp_messages');")" = "13" ] || fail "columnas whatsapp_messages (baseline)"

say "2. Sembrando datos tipo producción"
q "INSERT INTO clients (whatsapp_contact_key, phone, full_name) VALUES ('573001112233','573001112233','Ana Pérez'), ('573004445566','573004445566','Luis Gómez');"
q "INSERT INTO whatsapp_events (event_id, event_type, payload_json) VALUES ('evt_1','whatsapp.message.received','{}'), ('evt_2','whatsapp.message.sent','{}');"
q "INSERT INTO whatsapp_messages (message_id, conversation_id, direction, contact_key, body, raw_message_json) VALUES ('msg_1','conv_1','in','573001112233','hola','{}'), ('msg_2','conv_1','out','573001112233','buenas','{}');"

say "3. Aplicando 0001_tenancy"
sqlite3 -bail "$DB" < "$ROOT/migrations/0001_tenancy.sql"

[ "$(q "SELECT COUNT(*) FROM whatsapp_events WHERE business_id = 'keyko';")" = "2" ] || fail "backfill events"
[ "$(q "SELECT COUNT(*) FROM whatsapp_messages WHERE business_id = 'keyko';")" = "2" ] || fail "backfill messages"
[ "$(q "SELECT COUNT(*) FROM businesses WHERE id = 'keyko';")" = "1" ] || fail "negocio keyko"

say "4. Aplicando 0002_crm_core"
sqlite3 -bail "$DB" < "$ROOT/migrations/0002_crm_core.sql"

say "5. Aplicando 0003_security"
sqlite3 -bail "$DB" < "$ROOT/migrations/0003_security.sql"

[ "$(q "SELECT COUNT(*) FROM pragma_table_info('login_failures');")" = "4" ] || fail "columnas login_failures"
[ "$(q "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_appointments_active_range';")" = "1" ] || fail "índice parcial de citas"

say "6. Aplicando 0004_idempotency"
sqlite3 -bail "$DB" < "$ROOT/migrations/0004_idempotency.sql"

[ "$(q "SELECT COUNT(*) FROM pragma_table_info('idempotency_keys');")" = "9" ] || fail "columnas idempotency_keys"

say "7. Insertando datos ficticios del CRM (antes de 0005, para probar la copia)"
q "INSERT INTO users (id,email,name,password_hash) VALUES ('u1','cesar@keyko.test','Cesar','x');"
q "INSERT INTO memberships (id,business_id,user_id,role) VALUES ('m1','keyko','u1','owner');"
q "INSERT INTO pets (id,business_id,client_id,name,species,breed) VALUES ('p1','keyko',1,'Luna','perro','Poodle');"
q "INSERT INTO pet_health_records (id,business_id,pet_id,type,description,occurred_at) VALUES ('h1','keyko','p1','vaccine','Rabia','2026-09-01T10:00:00Z');"
q "INSERT INTO services (id,business_id,name,price_cents) VALUES ('s1','keyko','Baño y corte',4500000);"
q "INSERT INTO products (id,business_id,sku,name,price_cents,cost_cents,stock) VALUES ('pr1','keyko','SH-01','Shampoo',2500000,1500000,10);"
q "INSERT INTO appointments (id,business_id,client_id,pet_id,groomer_id,starts_at,ends_at) VALUES ('a1','keyko',1,'p1','u1','2026-11-02T15:00:00Z','2026-11-02T16:00:00Z');"
q "INSERT INTO appointment_items (id,business_id,appointment_id,item_type,item_id,qty,unit_price_cents,total_cents) VALUES ('ai1','keyko','a1','service','s1',1,4500000,4500000);"
q "INSERT INTO sales (id,business_id,client_id,appointment_id,status,total_cents,paid_at) VALUES ('sa1','keyko',1,'a1','paid',9500000,'2026-11-02T16:05:00Z');"
q "INSERT INTO sale_items (id,business_id,sale_id,item_type,item_id,qty,unit_price_cents,total_cents) VALUES ('si1','keyko','sa1','service','s1',1,4500000,4500000),('si2','keyko','sa1','product','pr1',2,2500000,5000000);"
q "INSERT INTO payments (id,business_id,sale_id,method,amount_cents,paid_at) VALUES ('pay1','keyko','sa1','nequi',9500000,'2026-11-02T16:06:00Z');"
q "INSERT INTO expenses (id,business_id,category,reason,amount_cents,incurred_at) VALUES ('e1','keyko','insumos','Compra de shampoo y toallas',1200000,'2026-11-02T18:00:00Z');"
q "INSERT INTO conversations (id,business_id,client_id,wa_contact) VALUES ('c1','keyko',1,'573001112233');"
q "INSERT INTO ai_extractions (id,business_id,source_type,source_id,model,prompt_version,raw_response,status) VALUES ('x1','keyko','message','msg_1','test','v1','{}','pending');"
q "INSERT INTO ai_usage (id,business_id,extraction_id,model,tokens_in,tokens_out,cost_usd_micros) VALUES ('au1','keyko','x1','test',120,40,350);"
q "INSERT INTO audit_log (id,business_id,actor_id,action,entity,entity_id,diff_json) VALUES ('al1','keyko','u1','client.create','client','1','{\"fullName\":{\"from\":null,\"to\":\"Ana Pérez\"}}');"

say "8. Aplicando 0005_sales (reconstruye sale_items y payments con datos)"
sqlite3 -bail "$DB" < "$ROOT/migrations/0005_sales.sql"

[ "$(q "SELECT COUNT(*) FROM sale_items;")" = "2" ] || fail "sale_items conserva sus filas"
[ "$(q "SELECT COUNT(*) FROM payments;")" = "1" ] || fail "payments conserva sus filas"
[ "$(q "SELECT COUNT(*) FROM sale_items WHERE item_type='service' AND item_id IS NULL AND name='Servicio';")" = "1" ] || fail "servicio migrado a texto libre"
[ "$(q "SELECT name FROM sale_items WHERE item_type='product';")" = "Shampoo" ] || fail "producto conserva nombre del catálogo"
[ "$(q "SELECT subtotal_cents FROM sales;")" = "9500000" ] || fail "subtotal backfill"

say "9. Aplicando 0006_sale_edits"
sqlite3 -bail "$DB" < "$ROOT/migrations/0006_sale_edits.sql"

[ "$(q "SELECT COUNT(*) FROM pragma_table_info('payments');")" = "9" ] || fail "columnas payments (0006)"
[ "$(q "SELECT COUNT(*) FROM pragma_table_info('sale_items');")" = "15" ] || fail "columnas sale_items (0006)"
[ "$(q "SELECT COUNT(*) FROM payments WHERE kind='payment';")" = "1" ] || fail "pagos existentes conservan kind"

say "10. Aplicando 0007_ai"
sqlite3 -bail "$DB" < "$ROOT/migrations/0007_ai.sql"

[ "$(q "SELECT COUNT(*) FROM pragma_table_info('ai_jobs');")" = "9" ] || fail "columnas ai_jobs"
[ "$(q "SELECT COUNT(*) FROM pragma_table_info('ai_processed_messages');")" = "4" ] || fail "columnas ai_processed_messages"
[ "$(q "SELECT COUNT(*) FROM pragma_table_info('field_overrides');")" = "5" ] || fail "columnas field_overrides"

say "11. Aplicando 0008_ai_alerts"
sqlite3 -bail "$DB" < "$ROOT/migrations/0008_ai_alerts.sql"

[ "$(q "SELECT COUNT(*) FROM pragma_table_info('ai_alerts');")" = "8" ] || fail "columnas ai_alerts"

say "12. Aplicando 0009_profile_completeness"
sqlite3 -bail "$DB" < "$ROOT/migrations/0009_profile_completeness.sql"

[ "$(sqlite3 -bail "$DB" "SELECT COUNT(*) FROM pragma_table_info('clients') WHERE name='profile_flags_json';")" = "1" ] || fail "clients.profile_flags_json"
[ "$(sqlite3 -bail "$DB" "SELECT COUNT(*) FROM pragma_table_info('pets') WHERE name='profile_flags_json';")" = "1" ] || fail "pets.profile_flags_json"

say "13. Aplicando 0010_photos_usage"
sqlite3 -bail "$DB" < "$ROOT/migrations/0010_photos_usage.sql"

[ "$(sqlite3 -bail "$DB" "SELECT COUNT(*) FROM pragma_table_info('pets') WHERE name IN ('photo_key','photo_meta_json');")" = "2" ] || fail "pets.photo_key/photo_meta_json"
[ "$(sqlite3 -bail "$DB" "SELECT COUNT(*) FROM pragma_table_info('ai_usage') WHERE name='error';")" = "1" ] || fail "ai_usage.error"
[ "$(sqlite3 -bail "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ai_usage_monthly';")" = "1" ] || fail "ai_usage_monthly"

say "14. Aplicando 0011_ai_appointments"
sqlite3 -bail "$DB" < "$ROOT/migrations/0011_ai_appointments.sql"

[ "$(sqlite3 -bail "$DB" "SELECT COUNT(*) FROM pragma_table_info('pets') WHERE name='age_years';")" = "1" ] || fail "pets.age_years"
[ "$(sqlite3 -bail "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='appointment_requests';")" = "1" ] || fail "appointment_requests"
[ "$(sqlite3 -bail "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='uq_appointment_requests_extraction';")" = "1" ] || fail "unique extraction"

say "15. Aplicando 0012_audio_transcriptions"
sqlite3 -bail "$DB" < "$ROOT/migrations/0012_audio_transcriptions.sql"

[ "$(sqlite3 -bail "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='message_transcriptions';")" = "1" ] || fail "message_transcriptions"
[ "$(sqlite3 -bail "$DB" "SELECT COUNT(*) FROM pragma_table_info('ai_usage') WHERE name='audio_seconds';")" = "1" ] || fail "ai_usage.audio_seconds"
[ "$(sqlite3 -bail "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='uq_message_transcriptions_message';")" = "1" ] || fail "unique transcription"

say "16. Verificaciones"
[ "$(q "SELECT COUNT(*) FROM pets;")" = "1" ] || fail "pets"
[ "$(q "SELECT SUM(total_cents) FROM sales WHERE status='paid';")" = "9500000" ] || fail "ventas"
[ "$(q "SELECT SUM(amount_cents) FROM expenses;")" = "1200000" ] || fail "egresos"
[ "$(q "PRAGMA foreign_key_check;")" = "" ] || fail "foreign_key_check"
[ "$(q "PRAGMA integrity_check;")" = "ok" ] || fail "integrity_check"

# El baseline debe reproducir exactamente las columnas de producción.
[ "$(q "SELECT COUNT(*) FROM pragma_table_info('clients');")" = "17" ] || fail "columnas clients (post 0009)"
[ "$(q "SELECT COUNT(*) FROM pragma_table_info('whatsapp_events');")" = "5" ] || fail "columnas whatsapp_events (post 0001)"
[ "$(q "SELECT COUNT(*) FROM pragma_table_info('whatsapp_messages');")" = "14" ] || fail "columnas whatsapp_messages (post 0001)"

say "17. Consulta de dashboard (ingresos - egresos del mes)"
q "SELECT printf('ingresos=%d egresos=%d neto=%d',
      (SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE business_id='keyko' AND paid_at LIKE '2026-11%'),
      (SELECT COALESCE(SUM(amount_cents),0) FROM expenses WHERE business_id='keyko' AND incurred_at LIKE '2026-11%'),
      (SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE business_id='keyko' AND paid_at LIKE '2026-11%')
      - (SELECT COALESCE(SUM(amount_cents),0) FROM expenses WHERE business_id='keyko' AND incurred_at LIKE '2026-11%'));"

say "OK — migraciones aplicadas y datos ficticios consistentes."
