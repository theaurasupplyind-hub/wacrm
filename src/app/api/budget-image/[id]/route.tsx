import { ImageResponse } from '@vercel/og'

export const runtime = 'edge'

const ACCENT = '#00C853'
const CARD_WIDTH = 400
const FONT = 'Noto Sans'

async function loadGoogleFont(
  font: string,
  weight: number,
): Promise<{ name: string; data: ArrayBuffer; weight: 400 | 600 | 800; style: 'normal' }> {
  const css = await (
    await fetch(
      `https://fonts.googleapis.com/css2?family=${font}:wght@${weight}&display=swap`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36' } },
    )
  ).text()
  const match = css.match(/src:\s*url\(([^)]+)\)/)
  if (!match) throw new Error(`Font ${font} ${weight} not found`)
  const data = await fetch(match[1]).then((r) => r.arrayBuffer())
  return { name: font, data, weight: weight as 400 | 600 | 800, style: 'normal' as const }
}

function formatPrice(n: number): string {
  const f = new Intl.NumberFormat('es-AR', { style: 'decimal', maximumFractionDigits: 0 })
  return '$' + f.format(Math.round(n))
}

function receiptHeight(itemCount: number): number {
  return 440 + itemCount * 52
}

interface InvoiceData {
  id: number
  numero_presupuesto: string | null
  numero_factura: string
  fecha: string
  cliente_nombre: string
  cliente_telefono: string | null
  cliente_domicilio: string | null
  total: number
  envio: number
  tipo: string
  items: {
    cantidad: number
    descripcion: string
    precio_unitario: number
    total: number
  }[]
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const invoiceId = parseInt(id, 10)
  if (isNaN(invoiceId)) {
    return new Response('Invalid invoice ID', { status: 400 })
  }

  const facbalUrl = process.env.FACBAL_API_URL?.replace(/\/+$/, '')
  const apiKey = process.env.FACBAL_API_KEY
  if (!facbalUrl || !apiKey) {
    return new Response('FacBal not configured', { status: 500 })
  }

  let inv: InvoiceData
  try {
    const res = await fetch(`${facbalUrl}/invoices/${invoiceId}`, {
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return new Response('Invoice not found', { status: 404 })
    inv = await res.json()
  } catch {
    return new Response('Failed to fetch invoice', { status: 502 })
  }

  const items = (inv.items || []).filter((i) => i.descripcion?.trim())
  const envio = inv.envio || 0
  const totalConEnvio = (inv.total || 0) + envio
  const subtotal = inv.total || 0
  const num = inv.numero_presupuesto || inv.numero_factura
  const contacto = [inv.cliente_telefono, inv.cliente_domicilio].filter(Boolean).join(' ')

  const fonts = await Promise.all(
    [400, 600, 800].map((w) => loadGoogleFont(FONT, w)),
  )

  return new ImageResponse(
    (
      <div
        style={{
          width: CARD_WIDTH,
          height: receiptHeight(items.length),
          display: 'flex',
          flexDirection: 'column',
          fontFamily: FONT,
          background: '#f5f5f5',
          padding: 16,
        }}
      >
        <div
          style={{
            background: '#fff',
            borderRadius: 16,
            padding: '24px 20px',
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
          }}
        >
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#1a1a1a' }}>
              BASTIDORES GAL
            </div>
            <div
              style={{
                width: 40,
                height: 3,
                background: ACCENT,
                margin: '8px auto',
              }}
            />
            <div style={{ fontSize: 13, color: '#888' }}>
              #{num} | {inv.fecha}
            </div>
          </div>

          <div
            style={{
              background: '#f8faf8',
              borderRadius: 12,
              padding: '12px 14px',
              marginBottom: 16,
              border: '1px solid #eef3ee',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a1a', marginBottom: 2 }}>
              {inv.cliente_nombre}
            </div>
            <div style={{ fontSize: 13, color: '#666' }}>{contacto}</div>
          </div>

          <div style={{ width: '100%', marginBottom: 12, fontSize: 13 }}>
            <div
              style={{
                display: 'flex',
                fontSize: 11,
                fontWeight: 600,
                color: '#999',
                paddingBottom: 6,
                borderBottom: '1px solid #eee',
              }}
            >
              <div style={{ width: '15%' }}>Cant</div>
              <div style={{ flex: 1 }}>Detalle</div>
              <div style={{ textAlign: 'right', width: '25%' }}>Total</div>
            </div>

            {items.map((item, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  padding: '6px 0',
                  borderBottom: '1px solid #f5f5f5',
                }}
              >
                <div style={{ width: '15%' }}>
                  {item.cantidad === 0 ? '' : Number.isInteger(item.cantidad) ? item.cantidad.toString() : item.cantidad.toString()}
                </div>
                <div style={{ flex: 1 }}>
                  <div>{item.descripcion}</div>
                  <div style={{ fontSize: 11, color: '#999' }}>
                    {formatPrice(item.precio_unitario)} c/u
                  </div>
                </div>
                <div style={{ textAlign: 'right', width: '25%' }}>
                  {formatPrice(item.total)}
                </div>
              </div>
            ))}
          </div>

          <div style={{ borderBottom: '1px dashed #ddd', margin: '8px 0' }} />

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 13,
              padding: '3px 0',
              fontWeight: 700,
              color: '#1a1a1a',
            }}
          >
            <span>Subtotal</span>
            <span>{formatPrice(subtotal)}</span>
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 13,
              padding: '3px 0',
              color: '#555',
            }}
          >
            <span>Envio</span>
            <span>{envio === 0 ? 'Sin cargo' : formatPrice(envio)}</span>
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 12,
              paddingTop: 12,
              borderTop: `2px solid ${ACCENT}`,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600, color: '#333' }}>
              TOTAL A PAGAR
            </span>
            <span
              style={{
                fontSize: 28,
                fontWeight: 800,
                color: ACCENT,
              }}
            >
              {formatPrice(totalConEnvio)}
            </span>
          </div>

          <div
            style={{
              textAlign: 'center',
              marginTop: 16,
              paddingTop: 12,
              borderTop: '1px solid #f0f0f0',
              fontSize: 11,
              color: '#bbb',
            }}
          >
            Presupuesto
          </div>
        </div>
      </div>
    ),
    { width: CARD_WIDTH, height: receiptHeight(items.length), fonts },
  )
}
