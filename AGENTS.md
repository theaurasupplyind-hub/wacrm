<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:docs-per-commit -->
# Documentación obligatoria en cada commit

Todo commit que cambie comportamiento (código, prompts, reglas de clasificación,
variables de entorno o migraciones) debe actualizar la documentación afectada
**en el mismo commit**, no en uno posterior.

| Si tocás… | Actualizá… |
|---|---|
| bots de WhatsApp (router, engine, voucher, gastos, asistencia) | `docs/bots/architecture.md` y, si hay una decisión/trampa nueva, `docs/bots/decisiones-y-gotchas.md` (con fecha y origen) |
| pedidos, precios, glosario, vocabulario | `docs/bots/decisiones-y-gotchas.md` §2/§4/§11/§12 + `docs/bots/catalogo-acciones.md` si cambia una acción |
| pipeline de vouchers | `docs/bots/vouchers.md` **y** `docs/voucher-flow.md` (ambos deben decir lo mismo que el código) |
| variables de entorno | `.env.local.example` (comentario de uso + doc de referencia) |
| migraciones SQL | tabla de migraciones en `docs/bots/architecture.md` |
| docs movidos/eliminados | actualizar también los links de `docs/`, `.env.local.example` y comentarios de código |

- Si el cambio es interno y de verdad no afecta ninguna doc, decilo en el cuerpo
  del commit: `Docs: sin cambios — <motivo>`.
- Cuando el código y la doc se contradicen, **manda el código**: corregí la doc
  en el mismo commit (no al revés).
- Antes de commitear: `rg "plan-[a-z-]+\.md" docs .env.local.example src` para
  detectar referencias a documentos que ya no existen.
<!-- END:docs-per-commit -->

