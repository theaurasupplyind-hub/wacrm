// Tarjeta de presupuesto para WhatsApp como imagen (satori/JSX).
// Port del template de galv2-tauri/src/lib/utils/receipt.ts (renderReceiptHtml)
// a flexbox — satori no soporta <table> ni selectores CSS, así que el diseño se
// reproduce con estilos inline equivalentes (card, acento, caja de cliente,
// header de columnas, subtotal, total en color y footer).
//
// Todo el layout está en píxeles lógicos sobre una tarjeta de 400px y se
// multiplica por `scale` (default 2x → PNG de 800px). Satori no expone
// `deviceScaleFactor`, así que la única forma de subir la resolución es escalar
// los valores y pedir un canvas más grande.

import { RECEIPT_FONT_FAMILY } from './receipt-fonts'

export interface ReceiptItem {
  cantidad: number
  descripcion: string
  precio_unitario: number
  total: number
}

export interface ReceiptData {
  numeroPresupuesto: string
  fecha: string
  clienteNombre: string
  clienteTelefono: string | null
  clienteDomicilio?: string | null
  items: ReceiptItem[]
  total: number
  faltantes: string[]
  envio?: number
  retira?: boolean
  tipoEntrega?: string
  mode?: 'PRESUPUESTO' | 'BORRADOR'
  saldo?: number
}

export interface ReceiptRenderOptions {
  /** Multiplicador de resolución. 1 = 400px lógicos; 2 = PNG de 800px. */
  scale?: number
}

/** Ancho del layout (incluye el padding exterior) en píxeles lógicos. */
export const RECEIPT_BASE_WIDTH = 400

/** Escala por defecto: 2x para que WhatsApp no reescale la imagen. */
export const RECEIPT_DEFAULT_SCALE = 2

const money = (n: number) => `$${n.toLocaleString('es-AR')}`

// Ancho de la columna de cantidad, en píxeles lógicos: tiene que entrar "CANT"
// en mayúsculas con el letterSpacing del header. La columna del total no es
// fija: se ajusta al ancho del número (flexShrink 0 + nowrap) para que no se
// corte con importes largos ($1.234.567) y deja el resto para el detalle.
const QTY_COL_WIDTH = 44

export function receiptElement(data: ReceiptData, options: ReceiptRenderOptions = {}) {
  const scale = options.scale ?? RECEIPT_DEFAULT_SCALE
  const px = (n: number) => `${n * scale}px`

  const mode = data.mode ?? 'PRESUPUESTO'
  const accent = mode === 'BORRADOR' ? '#0d6efd' : '#00C853'
  const envVal = data.envio ?? 0
  const subtotal = data.total - envVal
  const envDisplay = envVal === 0 ? 'Sin cargo' : money(envVal)
  const retira = data.retira ?? true
  const mostrarSaldo = mode === 'PRESUPUESTO' && data.saldo !== undefined

  return (
    <div
      style={{
        display: 'flex',
        width: px(RECEIPT_BASE_WIDTH),
        backgroundColor: '#f5f5f5',
        padding: px(16),
        fontFamily: RECEIPT_FONT_FAMILY,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          backgroundColor: '#ffffff',
          borderRadius: px(16),
          padding: `${px(24)} ${px(20)}`,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: px(20) }}>
          <span style={{ fontSize: px(20), fontWeight: 800, letterSpacing: px(1), color: '#1a1a1a' }}>
            BASTIDORES GAL
          </span>
          <div
            style={{
              width: px(40),
              height: px(3),
              backgroundColor: accent,
              borderRadius: px(2),
              margin: `${px(8)} 0`,
            }}
          />
          <span style={{ fontSize: px(13), color: '#888888' }}>
            #{data.numeroPresupuesto} | {data.fecha}
          </span>
        </div>

        {/* Caja de cliente */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: '#f8faf8',
            borderRadius: px(12),
            border: `${px(1)} solid #eef3ee`,
            padding: `${px(12)} ${px(14)}`,
            marginBottom: px(16),
          }}
        >
          <span style={{ fontSize: px(15), fontWeight: 700, color: '#1a1a1a', marginBottom: px(2) }}>
            {data.clienteNombre}
          </span>
          {data.clienteTelefono ? (
            <span style={{ fontSize: px(13), color: '#666666' }}>{data.clienteTelefono}</span>
          ) : null}
          {data.clienteDomicilio ? (
            <span style={{ fontSize: px(13), color: '#666666', marginTop: px(2) }}>
              {data.clienteDomicilio}
            </span>
          ) : null}
        </div>

        {/* Encabezado de columnas */}
        <div style={{ display: 'flex', borderBottom: `${px(1)} solid #eeeeee`, paddingBottom: px(6) }}>
          <span
            style={{
              width: px(QTY_COL_WIDTH),
              fontSize: px(11),
              fontWeight: 600,
              color: '#999999',
              letterSpacing: px(0.5),
              textTransform: 'uppercase',
            }}
          >
            Cant
          </span>
          <span
            style={{
              flex: '1',
              fontSize: px(11),
              fontWeight: 600,
              color: '#999999',
              letterSpacing: px(0.5),
              textTransform: 'uppercase',
            }}
          >
            Detalle
          </span>
          <span
            style={{
              flexShrink: 0,
              fontSize: px(11),
              fontWeight: 600,
              color: '#999999',
              letterSpacing: px(0.5),
              textTransform: 'uppercase',
              textAlign: 'right',
            }}
          >
            Total
          </span>
        </div>

        {/* Ítems */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {data.items.map((it, i) => {
            const isDiscount = it.descripcion.trim().toUpperCase() === 'DESCUENTO'
            const amount = it.total < 0 ? `-${money(Math.abs(it.total))}` : money(it.total)
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  borderBottom: `${px(1)} solid #f5f5f5`,
                  padding: `${px(6)} 0`,
                }}
              >
                <span style={{ width: px(QTY_COL_WIDTH), fontSize: px(13), color: '#1a1a1a' }}>
                  {it.cantidad === 0 || isDiscount ? '' : it.cantidad}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', flex: '1' }}>
                  <span style={{ fontSize: px(13), color: isDiscount ? accent : '#1a1a1a' }}>
                    {it.descripcion}
                  </span>
                  {it.cantidad !== 0 && !isDiscount ? (
                    <span style={{ fontSize: px(11), color: '#999999' }}>{money(it.precio_unitario)} c/u</span>
                  ) : null}
                </div>
                <span
                  style={{
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                    fontSize: px(13),
                    color: isDiscount ? accent : '#1a1a1a',
                    textAlign: 'right',
                  }}
                >
                  {it.cantidad === 0 ? '' : amount}
                </span>
              </div>
            )
          })}
        </div>

        {/* Faltantes (extra nuestro: no están en el template) */}
        {data.faltantes.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: px(8) }}>
            {data.faltantes.map((f, i) => (
              <span key={i} style={{ fontSize: px(11), color: '#b45309' }}>
                A cotizar: {f}
              </span>
            ))}
          </div>
        ) : null}

        {/* Divider punteado */}
        <div style={{ display: 'flex', borderTop: `${px(1)} dashed #dddddd`, margin: `${px(8)} 0` }} />

        {/* Subtotal + entrega */}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: `${px(3)} 0` }}>
          <span style={{ fontSize: px(13), fontWeight: 700, color: '#1a1a1a' }}>Subtotal</span>
          <span style={{ fontSize: px(13), fontWeight: 700, color: '#1a1a1a' }}>{money(subtotal)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: `${px(3)} 0` }}>
          <span style={{ fontSize: px(13), color: '#555555' }}>
            {retira ? 'Entrega' : data.tipoEntrega === 'Retiro y Envio' ? 'Retiro y Envio' : 'Envio'}
          </span>
          <span style={{ fontSize: px(13), color: '#555555' }}>{retira ? 'Retira' : envDisplay}</span>
        </div>

        {/* Total */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: px(12),
            paddingTop: px(12),
            borderTop: `${px(2)} solid ${accent}`,
          }}
        >
          <span style={{ fontSize: px(14), fontWeight: 600, color: '#333333' }}>TOTAL A PAGAR</span>
          {mostrarSaldo ? (
            (data.saldo ?? 0) <= 0.01 ? (
              // El subset latin de Inter no trae U+2713, así que el check va en SVG.
              <span style={{ display: 'flex', alignItems: 'center', gap: px(6) }}>
                <svg
                  width={px(20)}
                  height={px(20)}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#16a34a"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span style={{ fontSize: px(20), fontWeight: 800, color: '#16a34a' }}>Pagado</span>
              </span>
            ) : (
              <span style={{ fontSize: px(28), fontWeight: 800, color: accent }}>{money(data.saldo ?? 0)}</span>
            )
          ) : (
            <span style={{ fontSize: px(28), fontWeight: 800, color: accent }}>{money(data.total)}</span>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            marginTop: px(16),
            paddingTop: px(12),
            borderTop: `${px(1)} solid #f0f0f0`,
            fontSize: px(11),
            color: '#bbbbbb',
          }}
        >
          {mode === 'BORRADOR' ? 'Borrador' : 'Presupuesto'}
        </div>
      </div>
    </div>
  )
}
