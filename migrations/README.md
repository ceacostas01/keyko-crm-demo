# Migraciones

SQL versionado, **solo aditivo**. Nunca `DROP TABLE`, `DROP COLUMN` ni `DELETE` de datos de producción.

## Convención

```
0000_baseline_prod.sql   ← introspección del esquema actual (sin cambios)
0001_tenancy.sql         ← business_id + tablas nuevas
0002_...
```

Cada archivo:
1. Debe poder aplicarse sobre una base vacía y producir el mismo esquema.
2. Lleva al inicio un comentario con fecha, autor y motivo.
3. Se prueba primero en base local y luego en staging.

## Estado

`0000_baseline_prod.sql` **no se ha creado**: requiere el volcado real de Turso (fase 0).
