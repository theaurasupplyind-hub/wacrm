# Archivo — planes e integraciones históricas

> Documentos que documentan planes **implementados, superados o sin implementar**.
> Se conservan como registro histórico. La fuente de verdad actual está en los
> documentos de referencia de [`..`](../README.md) y en las decisiones vigentes de
> [`../decisiones-y-gotchas.md`](../decisiones-y-gotchas.md).

## Planes y documentos archivados

| Documento | Estado | Qué lo supera / por qué está acá |
|-----------|--------|----------------------------------|
| [`integracion-vouchers-original.md`](./integracion-vouchers-original.md) | ✅ Implementado | [`vouchers.md`](../vouchers.md) — spec de matching + pipeline actual |
| [`plan-mejora-gastos-asistencia.md`](./plan-mejora-gastos-asistencia.md) | ✅ Implementado | [`architecture.md`](../architecture.md) §7/§10/§11; semántica en [`decisiones-y-gotchas.md`](../decisiones-y-gotchas.md) §1 |
| [`plan-bot-llm-unificado.md`](./plan-bot-llm-unificado.md) | ✅ Implementado | [`architecture.md`](../architecture.md) §6; grietas del fallback en [`decisiones-y-gotchas.md`](../decisiones-y-gotchas.md) §3 |
| [`plan-items-libres-y-creacion-corta.md`](./plan-items-libres-y-creacion-corta.md) | ✅ Implementado (Fases A/B) | [`decisiones-y-gotchas.md`](../decisiones-y-gotchas.md) §4 |
| [`plan-presupuestos-por-bot.md`](./plan-presupuestos-por-bot.md) | ✅ Implementado | `src/lib/precios/` + `src/lib/pedidos/`; gotchas en [`decisiones-y-gotchas.md`](../decisiones-y-gotchas.md) §2 |
| [`plan-implementacion-urgente.md`](./plan-implementacion-urgente.md) | ✅ Consumido (checklist 14/10) | Pendientes rescatados en [`decisiones-y-gotchas.md`](../decisiones-y-gotchas.md) §10 |
| [`plan-asistente-conversacional-bot-beta.md`](./plan-asistente-conversacional-bot-beta.md) | 🕓 Superado | Asistente productivo ([`assistant-agent.md`](../assistant-agent.md)) |
| [`plan-bot-beta-a-produccion-asistente.md`](./plan-bot-beta-a-produccion-asistente.md) | 🕓 Superado | No ejecutar literalmente; decisiones rescatadas en [`decisiones-y-gotchas.md`](../decisiones-y-gotchas.md) §7 |
| [`notas-fallos-reales.md`](./notas-fallos-reales.md) | 🕓 Snapshot pre-fix (14/10) | Fixes aplicados; regla sí/no en [`decisiones-y-gotchas.md`](../decisiones-y-gotchas.md) §5 |
| [`voice-orders.md`](./voice-orders.md) | 🕓 Histórico (retirado) | Sucesor real: `src/lib/pedidos/` ([`architecture.md`](../architecture.md) §2) |
| [`resumen-bot-beta.md`](./resumen-bot-beta.md) | 🕓 Histórico | Etapa Bot Beta; ver [`assistant-agent.md`](../assistant-agent.md) |
| [`refactor-chatbot.md`](./refactor-chatbot.md) | ❌ Sin implementar (bot deshabilitado) | Sucesor real: `src/lib/pedidos/` + asistente ([`assistant-agent.md`](../assistant-agent.md), [`architecture.md`](../architecture.md) §6) |
| [`bot-personal.md`](./bot-personal.md) | ⏳ Planificado (no iniciado) | Roadmap en [`architecture.md`](../architecture.md) §12 |

## ¿Cómo leer estos archivos?

Cada documento conserva su contenido original con un header de estado en la
parte superior que indica:
- **Qué era** — el plan/propuesta original
- **Estado actual** — implementado / superado / sin implementar / planificado
- **Qué lo reemplaza** — enlace al doc activo correspondiente

Las decisiones, incidentes y trampas que siguen vigentes NO se leen acá: están
consolidadas en [`../decisiones-y-gotchas.md`](../decisiones-y-gotchas.md).
