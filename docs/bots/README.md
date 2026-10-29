# Documentación del ecosistema de bots — wacrm

> Documentación custom del fork (Bastidores GAL), escrita en español.
> Los docs del template upstream (inglés) viven en la raíz y en `docs/`.

Este directorio documenta los sistemas de mensajería/bots que se conectan al
webhook de WhatsApp y al backend `backend_gal` (FacBal API).

## Cómo está organizado

| Carpeta | Qué contiene |
|---------|--------------|
| `docs/bots/` | **Referencia vigente** — fuente de verdad del sistema actual |
| [`plans/`](./plans) | **Planes activos** — trabajo pendiente o en rollout |
| [`archive/`](./archive) | **Archivo** — planes implementados o superados e históricos |
| [`decisiones-y-gotchas.md`](./decisiones-y-gotchas.md) | Decisiones, incidentes y trampas rescatadas de los planes archivados |

## Referencia vigente

| Documento | Contenido |
|-----------|-----------|
| [`architecture.md`](./architecture.md) | Arquitectura del ecosistema: webhook, motor de turno, voucher, gastos, asistencia, agente y conexión con FacBal API |
| [`assistant-agent.md`](./assistant-agent.md) | Estado del agente: contexto, herramientas, modelos y evolución segura |
| [`vouchers.md`](./vouchers.md) | Spec de matching de comprobantes de pago + pipeline actual, incluido el **voucher por texto** (monto/nombre, fuzzy y confirmación) |
| [`definicion-ambiguedad.md`](./definicion-ambiguedad.md) | Qué cuenta como "ambiguo" y umbrales del gate de auto-guardado |
| [`catalogo-acciones.md`](./catalogo-acciones.md) | Inventario/roadmap de acciones que el bot podría operar por chat |
| [`gaps-bot-gastos.md`](./gaps-bot-gastos.md) | Análisis de gaps (G1–G8) del bot de gastos |
| [`decisiones-y-gotchas.md`](./decisiones-y-gotchas.md) | Decisiones de diseño, incidentes y trampas vigentes |

> Las **herramientas** del agente tienen una única fuente de verdad en el código:
> `src/lib/bot-assistant/tool-registry.ts`. `catalogo-acciones.md` es un inventario
> de roadmap, no el listado de lo implementado.

## Planes activos

| Documento | Estado |
|-----------|--------|
| [`plans/plan-orquestador-llm-bots-rigidos.md`](./plans/plan-orquestador-llm-bots-rigidos.md) | Implementado (Fases 1–7); Fase 8 (planner `on` por dominio) es rollout |
| [`plans/plan-automatizacion-chat-y-asistente-desktop.md`](./plans/plan-automatizacion-chat-y-asistente-desktop.md) | No iniciado — incluye Anexo A (auditoría de `backend_gal`) |

> Los planes cerrados se **eliminaron**: sus pendientes vivos están en
> [`decisiones-y-gotchas.md`](./decisiones-y-gotchas.md) §9 y §10. Los planes en curso
> de vocabulario/glosario viven en el directorio de plan del agente
> (`plan-00-indice.md`, `plan-01-vocabulario-datos.md`, `plan-02-glosario-knowledge.md`).

## Archivo histórico

El índice de planes implementados, superados e históricos está en
[`archive/README.md`](./archive/README.md).

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

Voice Orders figura como retirado en el código actual; ver `architecture.md` §2.
```

## Relación con los docs upstream

- La **API pública** (`/api/v1`) es feature del template: [`docs/public-api.md`](../public-api.md).
- El **pipeline de vouchers** tiene además una descripción en inglés
  ([`docs/voucher-flow.md`](../voucher-flow.md)) que documenta la implementación;
  `vouchers.md` es la fuente en español (spec + mejoras).
