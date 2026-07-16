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

function h(items: number): number {
  return 340 + items * 52
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
  const total = (inv.total || 0) + (inv.envio || 0)
  const subtotal = inv.total || 0
  const envio = inv.envio || 0
  const num = inv.numero_presupuesto || inv.numero_factura
  const contacto = [inv.cliente_telefono, inv.cliente_domicilio].filter(Boolean).join(' ')

  const fonts = await Promise.all([400, 700, 800].map(w => loadGFont(FONT, w)))
  const height = h(items.length)

  return new ImageResponse(
    <div style={{
      width: W, height,
      display: 'flex', flexDirection: 'column',
      fontFamily: FONT, background: '#f5f5f5', padding: 16,
    }}>
      <div style={{
        background: '#fff', borderRadius: 16,
        padding: '24px 20px', flex: 1,
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#1a1a1a', display: 'flex' }}>
            BASTIDORES GAL
          </div>
          <div style={{
            width: 40, height: 3, background: ACCENT, margin: '8px auto',
          }} />
          <div style={{ fontSize: 14, color: '#888', display: 'flex' }}>
            {`#${num} | ${inv.fecha}`}
          </div>
        </div>

        <div style={{
          background: '#f8faf8', borderRadius: 12, padding: '12px 14px',
          marginBottom: 16, border: '1px solid #eef3ee',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a1a', marginBottom: 2, display: 'flex' }}>
            {inv.cliente_nombre}
          </div>
          <div style={{ fontSize: 13, color: '#666', display: 'flex' }}>
            {contacto}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', marginBottom: 12 }}>
          <div style={{
            display: 'flex', fontSize: 11, fontWeight: 600, color: '#999',
            paddingBottom: 6, borderBottom: '1px solid #eee',
          }}>
            <div style={{ width: 48, display: 'flex' }}>Cant</div>
            <div style={{ flex: 1, display: 'flex' }}>Detalle</div>
            <div style={{ width: 80, display: 'flex', justifyContent: 'flex-end' }}>Total</div>
          </div>

          {items.map((item: any, i: number) => (
            <div key={i} style={{
              display: 'flex', padding: '6px 0',
              borderBottom: '1px solid #f5f5f5',
            }}>
              <div style={{ width: 48, display: 'flex', fontSize: 13 }}>
                {item.cantidad === 0 ? '' : `${item.cantidad}`}
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', fontSize: 13 }}>
                <div style={{ display: 'flex' }}>{item.descripcion}</div>
                <div style={{ display: 'flex', fontSize: 11, color: '#999' }}>
                  {`${$n(item.precio_unitario)} c/u`}
                </div>
              </div>
              <div style={{
                width: 80, display: 'flex', justifyContent: 'flex-end',
                fontSize: 13, fontWeight: 600,
              }}>
                {$n(item.total)}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', borderBottom: '1px solid #ddd', margin: '8px 0' }} />

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', fontWeight: 700, color: '#1a1a1a' }}>
          <span>Subtotal</span>
          <span>{$n(subtotal)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', color: '#555' }}>
          <span>Envio</span>
          <span>{envio === 0 ? 'Sin cargo' : $n(envio)}</span>
        </div>

        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginTop: 12, paddingTop: 12,
          borderTop: `2px solid ${ACCENT}`,
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#333' }}>TOTAL A PAGAR</span>
          <span style={{ fontSize: 28, fontWeight: 800, color: ACCENT }}>{$n(total)}</span>
        </div>

        <div style={{
          display: 'flex', justifyContent: 'center',
          marginTop: 16, paddingTop: 12,
          borderTop: '1px solid #f0f0f0',
          fontSize: 11, color: '#bbb',
        }}>
          Presupuesto
        </div>
      </div>
    </div>,
    { width: W, height, fonts },
  )
}
