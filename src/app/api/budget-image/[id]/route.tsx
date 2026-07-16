import { ImageResponse } from '@vercel/og'

export const runtime = 'edge'

const ACCENT = '#00C853'
const W = 400
const FONT = 'Noto Sans'

async function loadGFont(font: string, w: number) {
  const css = await (await fetch(
    `https://fonts.googleapis.com/css2?family=${font}:wght@${w}&display=swap`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } },
  )).text()
  const m = css.match(/src:\s*url\(([^)]+)\)/)
  if (!m) throw new Error('font not found')
  const data = await fetch(m[1]).then(r => r.arrayBuffer())
  return { name: font, data, weight: w as 400 | 600 | 800, style: 'normal' as const }
}

function $n(n: number): string {
  return '$' + Math.round(n).toLocaleString('es-AR')
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const invoiceId = parseInt((await params).id, 10)
  if (isNaN(invoiceId)) return new Response('bad id', { status: 400 })

  const base = process.env.FACBAL_API_URL?.replace(/\/+$/, '')
  const key = process.env.FACBAL_API_KEY
  if (!base || !key) return new Response('no config', { status: 500 })

  let inv: any
  try {
    const r = await fetch(`${base}/invoices/${invoiceId}`, {
      headers: { 'X-API-Key': key },
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) return new Response('not found', { status: 404 })
    inv = await r.json()
  } catch {
    return new Response('fetch fail', { status: 502 })
  }

  const items = (inv.items || []).filter((i: any) => i.descripcion?.trim())
  const t = (inv.total || 0) + (inv.envio || 0)
  const num = inv.numero_presupuesto || inv.numero_factura
  const contacto = [inv.cliente_telefono, inv.cliente_domicilio].filter(Boolean).join(' ')

  const fonts = await Promise.all([400, 700, 800].map(w => loadGFont(FONT, w)))

  const h = 340 + items.length * 48

  return new ImageResponse(
    <div style={{
      width: W, height: h,
      display: 'flex', flexDirection: 'column',
      fontFamily: FONT, background: '#f5f5f5', padding: 16,
    }}>
      <div style={{
        background: '#fff', borderRadius: 16,
        padding: '24px 20px',
        display: 'flex', flexDirection: 'column', flex: 1,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#1a1a1a' }}>BASTIDORES GAL</div>
          <div style={{ width: 40, height: 3, background: ACCENT, margin: '8px auto' }} />
          <div style={{ fontSize: 14, color: '#888' }}>#{num} | {inv.fecha}</div>
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#1a1a1a', marginBottom: 4 }}>{inv.cliente_nombre}</div>
        <div style={{ fontSize: 14, color: '#666', marginBottom: 16 }}>{contacto}</div>
        {items.map((item: any, i: number) => (
          <div key={i} style={{ display: 'flex', padding: '4px 0', borderBottom: '1px solid #eee' }}>
            <div style={{ width: 40, fontSize: 13 }}>{item.cantidad}x</div>
            <div style={{ flex: 1, fontSize: 13, display: 'flex', flexDirection: 'column' }}>
              <div>{item.descripcion}</div>
              <div style={{ fontSize: 11, color: '#999' }}>{$n(item.precio_unitario)} c/u</div>
            </div>
            <div style={{ width: 80, textAlign: 'right', fontSize: 13 }}>{item.total ? $n(item.total) : ''}</div>
          </div>
        ))}
        <div style={{ borderBottom: '1px solid #ccc', margin: '12px 0' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700, color: '#1a1a1a' }}>
          <span>TOTAL</span>
          <span>{$n(t)}</span>
        </div>
        <div style={{ textAlign: 'center', marginTop: 20, fontSize: 11, color: '#bbb' }}>Presupuesto</div>
      </div>
    </div>,
    { width: W, height: h, fonts },
  )
}
