// Tarjeta de presupuesto para WhatsApp como imagen (satori/JSX).
// Port del template de galv2-tauri/src/lib/utils/receipt.ts (renderReceiptHtml)
// a flexbox — satori no soporta <table> ni selectores CSS, así que el diseño se
// reproduce con estilos inline equivalentes (card, acento, caja de cliente,
// header de columnas, subtotal, total en color y footer).

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
  items: ReceiptItem[]
  total: number
  faltantes: string[]
  envio?: number
  retira?: boolean
  tipoEntrega?: string
  mode?: 'PRESUPUESTO' | 'BORRADOR'
  saldo?: number
}

const money = (n: number) => `$${n.toLocaleString('es-AR')}`

export function receiptElement(data: ReceiptData) {
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
        width: '400px',
        backgroundColor: '#f5f5f5',
        padding: '16px',
        fontFamily: 'sans-serif',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          padding: '24px 20px',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '20px' }}>
          <span style={{ fontSize: '20px', fontWeight: 800, letterSpacing: '1px', color: '#1a1a1a' }}>
            BASTIDORES GAL
          </span>
          <div style={{ width: '40px', height: '3px', backgroundColor: accent, borderRadius: '2px', margin: '8px 0' }} />
          <span style={{ fontSize: '13px', color: '#888888' }}>
            #{data.numeroPresupuesto} | {data.fecha}
          </span>
        </div>

        {/* Caja de cliente */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: '#f8faf8',
            borderRadius: '12px',
            border: '1px solid #eef3ee',
            padding: '12px 14px',
            marginBottom: '16px',
          }}
        >
          <span style={{ fontSize: '15px', fontWeight: 700, color: '#1a1a1a', marginBottom: '2px' }}>
            {data.clienteNombre}
          </span>
          {data.clienteTelefono ? (
            <span style={{ fontSize: '13px', color: '#666666' }}>{data.clienteTelefono}</span>
          ) : null}
        </div>

        {/* Encabezado de columnas */}
        <div style={{ display: 'flex', borderBottom: '1px solid #eeeeee', paddingBottom: '6px' }}>
          <span style={{ width: '34px', fontSize: '11px', fontWeight: 600, color: '#999999', letterSpacing: '0.5px' }}>
            Cant
          </span>
          <span style={{ flex: '1', fontSize: '11px', fontWeight: 600, color: '#999999', letterSpacing: '0.5px' }}>
            Detalle
          </span>
          <span
            style={{
              width: '90px',
              fontSize: '11px',
              fontWeight: 600,
              color: '#999999',
              letterSpacing: '0.5px',
              textAlign: 'right',
            }}
          >
            Total
          </span>
        </div>

        {/* Ítems */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {data.items.map((it, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                borderBottom: '1px solid #f5f5f5',
                padding: '6px 0',
              }}
            >
              <span style={{ width: '34px', fontSize: '13px', color: '#333333' }}>
                {it.cantidad === 0 ? '' : it.cantidad}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', flex: '1' }}>
                <span style={{ fontSize: '13px', color: '#1a1a1a' }}>{it.descripcion}</span>
                {it.cantidad !== 0 ? (
                  <span style={{ fontSize: '11px', color: '#999999' }}>{money(it.precio_unitario)} c/u</span>
                ) : null}
              </div>
              <span style={{ width: '90px', fontSize: '13px', color: '#1a1a1a', textAlign: 'right' }}>
                {it.cantidad === 0 ? '' : money(it.total)}
              </span>
            </div>
          ))}
        </div>

        {/* Faltantes (extra nuestro: no están en el template) */}
        {data.faltantes.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: '8px' }}>
            {data.faltantes.map((f, i) => (
              <span key={i} style={{ fontSize: '11px', color: '#b45309' }}>
                A cotizar: {f}
              </span>
            ))}
          </div>
        ) : null}

        {/* Divider punteado */}
        <div style={{ display: 'flex', borderTop: '1px dashed #dddddd', margin: '8px 0' }} />

        {/* Subtotal + entrega */}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: '#1a1a1a' }}>Subtotal</span>
          <span style={{ fontSize: '13px', fontWeight: 700, color: '#1a1a1a' }}>{money(subtotal)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
          <span style={{ fontSize: '13px', color: '#555555' }}>
            {retira ? 'Entrega' : data.tipoEntrega === 'Retiro y Envio' ? 'Retiro y Envio' : 'Envio'}
          </span>
          <span style={{ fontSize: '13px', color: '#555555' }}>{retira ? 'Retira' : envDisplay}</span>
        </div>

        {/* Total */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: '12px',
            paddingTop: '12px',
            borderTop: `2px solid ${accent}`,
          }}
        >
          <span style={{ fontSize: '14px', fontWeight: 600, color: '#333333' }}>TOTAL A PAGAR</span>
          {mostrarSaldo ? (
            (data.saldo ?? 0) <= 0.01 ? (
              <span style={{ fontSize: '20px', fontWeight: 800, color: '#16a34a' }}>✓ Pagado</span>
            ) : (
              <span style={{ fontSize: '28px', fontWeight: 800, color: accent }}>{money(data.saldo ?? 0)}</span>
            )
          ) : (
            <span style={{ fontSize: '28px', fontWeight: 800, color: accent }}>{money(data.total)}</span>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            marginTop: '16px',
            paddingTop: '12px',
            borderTop: '1px solid #f0f0f0',
            fontSize: '11px',
            color: '#bbbbbb',
          }}
        >
          {mode === 'BORRADOR' ? 'Borrador' : 'Presupuesto'}
        </div>
      </div>
    </div>
  )
}
