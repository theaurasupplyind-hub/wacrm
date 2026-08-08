# Documentación del ecosistema de bots — wacrm

> Documentación custom del fork (Bastidores GAL), escrita en español.
> Los docs del template upstream (inglés) viven en la raíz y en `docs/`.

Este directorio documenta los sistemas de mensajería/bots que se conectan al
webhook de WhatsApp y al backend `backend_gal` (FacBal API).

## Índice

| Documento | Contenido | Estado |
|-----------|-----------|--------|
| [`architecture.md`](./architecture.md) | Arquitectura general: todos los sistemas, orden de dispatch, conexión con FacBal API y galv2-tauri | Activo |
| [`vouchers.md`](./vouchers.md) | Spec de matching de comprobantes de pago + pipeline actual | Activo |
| [`voice-orders.md`](./voice-orders.md) | Bot de pedidos por voz/texto: estado actual + mejoras pendientes | Activo |
| [`plan-mejora-gastos-asistencia.md`](./plan-mejora-gastos-asistencia.md) | Plan de mejora de los bots de gastos y asistencia (llegada/salida) — implementado | Implementado |
| [`plan-bot-llm-unificado.md`](./plan-bot-llm-unificado.md) | Plan del extractor unificado LLM (intents + parseo de asistencia/gastos, fallback regex) — implementado | Implementado |
| [`archive/README.md`](./archive/README.md) | Índice de planes e integraciones históricas | Archivo |

## Visión de un vistazo

```
WhatsApp Webhook (POST /api/whatsapp/webhook)
   │
   ├── Flows Engine      (bot builder visual — nativo wacrm)
   ├── Automations       (nativo wacrm)
   ├── AI Auto-Reply     (nativo wacrm, bring-your-own-key)
   ├── Voucher           (pagos → backend_gal)
   ├── Expense Bot       (gastos → backend_gal)
   ├── Attendance Bot    (llegada/salida → backend_gal)
   └── Voice Orders      (pedidos → backend_gal)
            │
            ▼
   src/lib/facbal/client.ts  ← API key auth
            │
            ▼
   backend_gal (FastAPI — https://api-bastidores.onrender.com)
            │
            ▼
   galv2-tauri (app de escritorio, comparte backend_gal)
```

## Relación con los docs upstream

- La **API pública** (`/api/v1`) es feature del template: [`docs/public-api.md`](../public-api.md).
- El **pipeline de vouchers** tiene además una descripción en inglés
  ([`docs/voucher-flow.md`](../voucher-flow.md)) que documenta la implementación;
  `vouchers.md` es la fuente en español (spec + mejoras).
