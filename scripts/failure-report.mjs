#!/usr/bin/env node
/**
 * Reporte semanal del failure trace (Fase 3 del plan agente-conversacional).
 *
 * Lee `bot_failure_traces` (señales de "te equivocaste" capturadas en sombra
 * por el webhook) y resume: volumen, clases, resoluciones y pendientes.
 * Sirve para la revisión semanal: cada fallo pendiente debería convertirse en
 * fixture de regresión, ajuste de prompt, entrada de vocabulario o recalibración
 * de umbral.
 *
 * SÓLO LEE (SELECT). No ejecuta acciones ni modifica nada.
 *
 * Uso:
 *   node scripts/failure-report.mjs [dias=7]
 *
 * Env (o se leen de .env.local / .env):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
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
  `${URL}/rest/v1/bot_failure_traces?select=created_at,signal_text,reporter,failure_class,resolution,resolution_detail,intent,confianza` +
    `&created_at=gte.${since}&order=created_at.desc&limit=5000`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
)
if (!res.ok) {
  const body = await res.text()
  if (res.status === 404 || body.includes('does not exist')) {
    console.error('Tabla bot_failure_traces inexistente — correr migración 053_bot_failure_traces.sql en Supabase')
  } else {
    console.error('Supabase error', res.status, body)
  }
  process.exit(1)
}

const rows = await res.json()
const n = rows.length
const count = (arr, p) => arr.filter(p).length
const pct = (x, d) => (d ? `${((x / d) * 100).toFixed(1)}%` : '-')

console.log(`\n=== Failure trace — últimos ${days} días ===`)
console.log(`Señales: ${n}`)
if (!n) {
  console.log('(sin datos: ¿hubo correcciones de usuarios en el período?)')
  process.exit(0)
}

console.log(`\n--- Por reportero ---`)
console.log(`bot_error (fallo del bot):      ${count(rows, (r) => r.reporter === 'bot_error')}`)
console.log(`user_error (se equivocó el usuario): ${count(rows, (r) => r.reporter === 'user_error')}`)

const byClass = new Map()
for (const r of rows) byClass.set(r.failure_class ?? 'sin_clasificar', (byClass.get(r.failure_class ?? 'sin_clasificar') ?? 0) + 1)
console.log('\n--- Por clase ---')
for (const [c, k] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${c.padEnd(20)} ${k} (${pct(k, n)})`)
}

const byRes = new Map()
for (const r of rows) byRes.set(r.resolution ?? 'pending', (byRes.get(r.resolution ?? 'pending') ?? 0) + 1)
console.log('\n--- Por resolución ---')
for (const [c, k] of [...byRes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${c.padEnd(20)} ${k} (${pct(k, n)})`)
}

const pend = rows.filter((r) => (r.resolution ?? 'pending') === 'pending').slice(0, 25)
console.log(`\n--- Pendientes (top ${pend.length}) → convertir en fixture/acción ---`)
for (const r of pend) {
  console.log(
    `• "${String(r.signal_text || '').slice(0, 70)}"  rep=${r.reporter} clase=${r.failure_class ?? '-'} intent=${r.intent ?? '-'} conf=${r.confianza ?? '-'}`,
  )
}

const botErr = rows.filter((r) => r.reporter === 'bot_error').slice(0, 15)
if (botErr.length) {
  console.log(`\n--- Últimos fallos del bot (${botErr.length}) ---`)
  for (const r of botErr) {
    console.log(
      `• "${String(r.signal_text || '').slice(0, 70)}"  res=${r.resolution ?? 'pending'}${r.resolution_detail ? ` (${String(r.resolution_detail).slice(0, 40)})` : ''}`,
    )
  }
}
