# Implementación urgente (pendiente, 14/10/2026)

> Estado: Fases 0–5 + fixes #1–#4 + Caso 3 están commiteados en `main` SIN
> deployar. Esto es lo que falta, en orden.

## 1. Deployar (bloquea todo lo demás)

- Commit: ✅ (dos commits en `main`, solo local — NO pusheado).
- Falta: push → CI (`lint+typecheck+test+build`) → deploy por la vía habitual.
- Migraciones 052/053/054: ✅ aplicadas en Supabase.
- Sin envs nuevos todo se comporta como antes (ver §2).
- Batería de humo post-deploy: gasto claro, asistencia, voucher, pedido,
  `/bot-beta`, fila en `bot_write_log`, señal en `bot_failure_traces`,
  `failure-report.mjs`.
- Nota: CI marca 2 fallos preexistentes de timezone en `date-utils` (no del
  bot). No bloquean, pero hay que fixearlos para tener CI verde de verdad.

## 2. Prender el agente (rollout medido)

- `ASSISTANT_PRIMARY_DOMAINS=expense` en Preview → 1 semana →
  `failure-report.mjs` + sombras del planner → luego `+attendance`.
- Pedido y voucher quedan determinísticos (decisión vigente).
- Métrica madre: % turnos resueltos sin reformular.

## 3. `classifyYesNo` (cuarto detector sí/no, `pedidos/summary.ts:119)

- El de "¿Es ese?" (cliente candidato) sigue por regex. Unificarlo a
  `reply-intent.ts` como se hizo con los otros tres.
- Riesgo bajo, toque chico.

## 4. Fase 6 — Glosario y memoria

- En espera de 1–2 semanas de datos del failure trace (acordado).
- Plan: columna `domain` en `order_glossary` + tipos proveedor/empleado/
  categoría/cliente → expansión pre-fuzzy → vocabulario en contexto del
  agente → candidatos desde el trace (inline + revisión semanal).

## 5. Higiene

- Fixear los 2 tests de `date-utils` (CI verde).
- Instalar el loop semanal: `failure-report.mjs` → fixtures de regresión /
  prompt / vocabulario / umbrales.
- Re-evaluar DeepSeek si cambian precios o sale versión más rápida
  (harness listo: `agente-eval.live` + `respuesta-eval.live`).
