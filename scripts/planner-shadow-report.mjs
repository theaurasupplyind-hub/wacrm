#!/usr/bin/env node
/**
 * Reporte del planner en SOMBRA (Fase 3).
 *
 * Lee `router_logs.debug_info.planner_shadow` (que escribe
 * `src/lib/bot/planner.ts` cuando `ASSISTANT_AGENT_PLANNER=shadow|on`) y resume
 * el desempeño del planner contra el ruteo determinístico.
 *
 * SÓLO LEE (SELECT). No ejecuta acciones ni modifica nada.
 *
 * Uso:
 *   node scripts/planner-shadow-report.mjs [dias=7]
 *
 * Env (o se leen de .env.local / .env):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Las métricas se RECALCULAN desde los campos crudos (deterministic.domain +
 * planner.domains + planner.writes), no desde los valores guardados: así los
 * turnos viejos (con la métrica anterior) también se analizan bien.
 *
 * Métricas clave:
 *   - unnecessaryWrite  → el planner propone ESCRIBIR cuando el determinístico
 *     no lo hacía. Es el gate que más importa: debería ser ~0.
 *   - agrees            → el planner elige el mismo dominio que el determinístico.
 *   - missedWrite       → el determinístico escribía (gasto/asistencia) y el
 *     planner no lo propuso.
 *   - latencyMs         → costo de la llamada extra por turno.
 */
import { readFileSync, existsSync } from 'node:fs'

for (const file of ['.env.local', '.env']) {
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

// Mismos dominios que `compareShadow` (src/lib/bot/planner.ts).
const COMPARABLE = new Set(['expense', 'attendance', 'pedido', 'assistant'])
const WRITE_DOMAINS = new Set(['expense', 'attendance'])

const days = Number(process.argv[2] ?? 7)
const since = new Date(Date.now() - days * 86400_000).toISOString()

const res = await fetch(
  `${URL}/rest/v1/router_logs?select=created_at,raw_text,dispatched_to,dispatch_reason,debug_info` +
    `&debug_info=not.is.null&created_at=gte.${since}&order=created_at.desc&limit=5000`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
)
if (!res.ok) {
  console.error('Supabase error', res.status, await res.text())
  process.exit(1)
}

const S = (await res.json())
  .filter((r) => r.debug_info && r.debug_info.planner_shadow)
  .map((r) => {
    const ps = r.debug_info.planner_shadow
    const det = ps.deterministic?.domain ?? 'unknown'
    const domains = ps.planner?.domains || []
    const writes = ps.planner?.writes || []
    const applicable = COMPARABLE.has(det)
    const detIsWrite = WRITE_DOMAINS.has(det)
    return {
      createdAt: r.created_at,
      raw: String(r.raw_text || ''),
      det,
      detReason: ps.deterministic?.reason ?? '',
      domains,
      writes,
      applicable,
      agrees: applicable && domains.includes(det),
      unnecessaryWrite: writes.length > 0 && !detIsWrite,
      missedWrite: detIsWrite && writes.length === 0,
      error: ps.error ?? null,
      latencyMs: Number(ps.latencyMs) || 0,
    }
  })

const n = S.length
const A = S.filter((x) => x.applicable)
const na = A.length
const count = (arr, p) => arr.filter(p).length
const pct = (x, d) => (d ? `${((x / d) * 100).toFixed(1)}%` : '-')

console.log(`\n=== Planner shadow — últimos ${days} días ===`)
console.log(`Turnos con propuesta: ${n}  (aplicables: ${na}; fuera de alcance: ${n - na})`)
if (!n) {
  console.log('(sin datos: ¿está `ASSISTANT_AGENT_PLANNER=shadow` y hubo tráfico de números autorizados?)')
  process.exit(0)
}

const lat = S.map((x) => x.latencyMs).sort((a, b) => a - b)
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] || 0

console.log(`\n--- Sobre turnos aplicables (${na}) ---`)
console.log(`agrees:            ${count(A, (x) => x.agrees)} (${pct(count(A, (x) => x.agrees), na)})`)
console.log(`unnecessaryWrite:  ${count(S, (x) => x.unnecessaryWrite)} (${pct(count(S, (x) => x.unnecessaryWrite), n)})  <- gate (sobre todos)`)
console.log(`missedWrite:       ${count(A, (x) => x.missedWrite)} (${pct(count(A, (x) => x.missedWrite), na)})`)
console.log(`errores:           ${count(S, (x) => x.error)} (${pct(count(S, (x) => x.error), n)})`)
console.log(`latencia ms — p50 ${p(0.5)} · p95 ${p(0.95)} · max ${lat.at(-1) || 0}`)

const byDomain = new Map()
for (const x of A) {
  const o = byDomain.get(x.det) ?? { turns: 0, agrees: 0, unnec: 0, missed: 0 }
  o.turns++
  if (x.agrees) o.agrees++
  if (x.unnecessaryWrite) o.unnec++
  if (x.missedWrite) o.missed++
  byDomain.set(x.det, o)
}
console.log('\n(aplicables) dominio | turnos | agrees | unnecWrite | missedWrite')
for (const [d, o] of [...byDomain.entries()].sort((a, b) => b[1].turns - a[1].turns)) {
  console.log(
    `${d.padEnd(20)} | ${String(o.turns).padStart(6)} | ${String(o.agrees).padStart(6)} | ${String(o.unnec).padStart(10)} | ${String(o.missed).padStart(11)}`,
  )
}

const skipped = new Map()
for (const x of S.filter((y) => !y.applicable)) skipped.set(x.det, (skipped.get(x.det) ?? 0) + 1)
if (skipped.size) console.log('fuera de alcance:', [...skipped.entries()].map(([d, c]) => `${d}=${c}`).join(' | '))

const dis = A.filter((x) => !x.agrees).slice(0, 25)
console.log(`\n--- Desacuerdos aplicables (${dis.length}) ---`)
for (const x of dis) {
  console.log(
    `• "${x.raw.slice(0, 60)}"  det=${x.det}/${x.detReason}  planner=${x.domains.join('|') || '-'}  writes=${x.writes.join('|') || '-'}${x.unnecessaryWrite ? '  ⚠WRITE' : ''}`,
  )
}

const unnec = S.filter((x) => x.unnecessaryWrite).slice(0, 15)
if (unnec.length) {
  console.log(`\n--- Falsos positivos de ESCRITURA (${unnec.length}) ---`)
  for (const x of unnec) console.log(`• "${x.raw.slice(0, 70)}"  det=${x.det}  writes=${x.writes.join('|')}`)
}
