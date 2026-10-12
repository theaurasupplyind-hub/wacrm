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
 * Métricas clave:
 *   - unnecessaryWrite  → el planner propone ESCRIBIR cuando el determinístico
 *     no lo hacía. Es el gate que más importa: debería ser ~0.
 *   - agrees            → el planner coincide con el ruteo determinístico.
 *   - missedWrite       → el determinístico escribía y el planner no lo propuso.
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
  .map((r) => ({ ...r, ps: r.debug_info.planner_shadow }))
const n = S.length
const count = (p) => S.filter(p).length
const pct = (x) => (n ? `${((x / n) * 100).toFixed(1)}%` : '-')

console.log(`\n=== Planner shadow — últimos ${days} días ===`)
console.log(`Turnos con propuesta: ${n}`)
if (!n) {
  console.log('(sin datos: ¿está `ASSISTANT_AGENT_PLANNER=shadow` y hubo tráfico de números autorizados?)')
  process.exit(0)
}

const lat = S.map((r) => Number(r.ps.latencyMs) || 0).sort((a, b) => a - b)
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] || 0

console.log(`agrees:            ${count((r) => r.ps.agrees)} (${pct(count((r) => r.ps.agrees))})`)
console.log(`unnecessaryWrite:  ${count((r) => r.ps.unnecessaryWrite)} (${pct(count((r) => r.ps.unnecessaryWrite))})  <- gate`)
console.log(`missedWrite:       ${count((r) => r.ps.missedWrite)} (${pct(count((r) => r.ps.missedWrite))})`)
console.log(`errores:           ${count((r) => r.ps.error)} (${pct(count((r) => r.ps.error))})`)
console.log(`latencia ms — p50 ${p(0.5)} · p95 ${p(0.95)} · max ${lat.at(-1) || 0}`)

const byDomain = new Map()
for (const r of S) {
  const d = r.ps.deterministic?.domain ?? 'unknown'
  const o = byDomain.get(d) ?? { turns: 0, agrees: 0, unnec: 0, missed: 0 }
  o.turns++
  if (r.ps.agrees) o.agrees++
  if (r.ps.unnecessaryWrite) o.unnec++
  if (r.ps.missedWrite) o.missed++
  byDomain.set(d, o)
}
console.log('\ndominio      | turnos | agrees | unnecWrite | missedWrite')
for (const [d, o] of [...byDomain.entries()].sort((a, b) => b[1].turns - a[1].turns)) {
  console.log(
    `${d.padEnd(12)} | ${String(o.turns).padStart(6)} | ${String(o.agrees).padStart(6)} | ${String(o.unnec).padStart(10)} | ${String(o.missed).padStart(11)}`,
  )
}

const dis = S.filter((r) => r.ps.agrees === false).slice(0, 25)
console.log(`\n--- Desacuerdos (últimos ${dis.length}) ---`)
for (const r of dis) {
  const det = `${r.ps.deterministic?.domain}/${r.ps.deterministic?.reason}`
  const pl = (r.ps.planner?.domains || []).join('|') || '-'
  const wr = (r.ps.planner?.writes || []).join('|') || '-'
  console.log(
    `• "${String(r.raw_text || '').slice(0, 60)}"  det=${det}  planner=${pl}  writes=${wr}${r.ps.unnecessaryWrite ? '  ⚠WRITE' : ''}`,
  )
}

const unnec = S.filter((r) => r.ps.unnecessaryWrite).slice(0, 15)
if (unnec.length) {
  console.log(`\n--- Falsos positivos de ESCRITURA (${unnec.length}) ---`)
  for (const r of unnec) {
    console.log(`• "${String(r.raw_text || '').slice(0, 70)}"  det=${r.ps.deterministic?.domain}  writes=${(r.ps.planner?.writes || []).join('|')}`)
  }
}
