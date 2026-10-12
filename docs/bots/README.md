# Documentación del ecosistema de bots — wacrm

> Documentación custom del fork (Bastidores GAL), escrita en español.
> Los docs del template upstream (inglés) viven en la raíz y en `docs/`.

Este directorio documenta los sistemas de mensajería/bots que se conectan al
webhook de WhatsApp y al backend `backend_gal` (FacBal API).

## Índice

| Documento | Contenido | Estado |
|-----------|-----------|--------|
| [`architecture.md`](./architecture.md) | Arquitectura vigente: webhook, router, agente, modelos y conexión con FacBal API | Fuente actual |
| [`assistant-agent.md`](./assistant-agent.md) | Estado vigente del agente, contexto, herramientas, modelos y evolución segura | Actual |
| [`../../resumen-bot-beta.md`](../../resumen-bot-beta.md) | Resumen histórico de la etapa Bot Beta | Histórico |
| [`vouchers.md`](./vouchers.md) | Spec de matching de comprobantes de pago + pipeline actual | Activo |
| [`voice-orders.md`](./voice-orders.md) | Documentación histórica del pipeline Voice Orders retirado | Histórico |
| [`plan-mejora-gastos-asistencia.md`](./plan-mejora-gastos-asistencia.md) | Plan de mejora de los bots de gastos y asistencia (llegada/salida) — implementado | Implementado |
| [`plan-bot-llm-unificado.md`](./plan-bot-llm-unificado.md) | Plan del extractor unificado LLM (intents + parseo de asistencia/gastos, fallback regex) — implementado | Implementado |
| [`plan-mejora-asistente-whatsapp.md`](./plan-mejora-asistente-whatsapp.md) | Estado de mejoras: whitelist/UX/herramientas implementadas; piloto DeepSeek y tareas pendientes | Mixto |
| [`plan-unificacion-motor-bot.md`](./plan-unificacion-motor-bot.md) | Motor de turno puro en producción (`engine.ts`) + planner LLM opt-in (Fases 1-5); migración de Bot Beta fuera de alcance | Parcial |
| [`plan-asistente-conversacional-bot-beta.md`](./plan-asistente-conversacional-bot-beta.md) | Especificación histórica del asistente en Beta; superada por el asistente productivo | Superado |
| [`plan-bot-beta-a-produccion-asistente.md`](./plan-bot-beta-a-produccion-asistente.md) | Plan histórico de promoción a producción; no ejecutar literalmente contra los módulos actuales | Superado |
| [`archive/README.md`](./archive/README.md) | Índice de planes e integraciones históricas | Archivo |

## Visión de un vistazo

```
WhatsApp Webhook
   ├── Números autorizados → extractor + router
   │      ├── Gastos / asistencia / vouchers / pedidos → handlers determinísticos
   │      └── Consultas/conversación → agente con tools (OpenRouter)
   ├── Flows fallback + Automations
   ├── AI Auto-Reply (cuentas/clientes, sistema separado)
   └── backend_gal (FacBal API) ← src/lib/facbal/client.ts
            └── galv2-tauri comparte backend_gal

Voice Orders figura como retirado en el código actual; ver `architecture.md`.
```

## Relación con los docs upstream

- La **API pública** (`/api/v1`) es feature del template: [`docs/public-api.md`](../public-api.md).
- El **pipeline de vouchers** tiene además una descripción en inglés
  ([`docs/voucher-flow.md`](../voucher-flow.md)) que documenta la implementación;
  `vouchers.md` es la fuente en español (spec + mejoras).
