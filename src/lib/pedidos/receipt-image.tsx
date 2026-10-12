// Tarjeta de presupuesto para WhatsApp como imagen (satori/JSX).
// Replica la tarjeta de galv2-tauri/src/lib/utils/receipt.ts en flexbox
// (satori no soporta <table>). La usa la ruta de imagen (Fase 4) vía ImageResponse.

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
}

const money = (n: number) => `$${n.toLocaleString('es-AR')}`

export function receiptElement(data: ReceiptData) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '400px',
        backgroundColor: '#ffffff',
        padding: '20px',
        fontFamily: 'sans-serif',
        color: '#111111',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          fontSize: '22px',
          fontWeight: 700,
          letterSpacing: '2px',
        }}
      >
        BASTIDORES GAL
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginTop: '6px', color: '#555555' }}>
        <span>Presupuesto</span>
        <span>{data.numeroPresupuesto}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: '#555555' }}>
        <span>Fecha</span>
        <span>{data.fecha}</span>
      </div>

      <div style={{ display: 'flex', height: '1px', backgroundColor: '#dddddd', margin: '12px 0' }} />

      <div style={{ display: 'flex', flexDirection: 'column', fontSize: '14px' }}>
        <span style={{ fontWeight: 600 }}>{data.clienteNombre}</span>
        {data.clienteTelefono ? <span style={{ color: '#555555' }}>{data.clienteTelefono}</span> : null}
      </div>

      <div style={{ display: 'flex', height: '1px', backgroundColor: '#dddddd', margin: '12px 0' }} />

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {data.items.map((it, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', marginBottom: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span>
                {it.cantidad > 1 ? `${it.cantidad} x ` : ''}
                {it.descripcion}
              </span>
              <span>{money(it.total)}</span>
            </div>
            {it.cantidad > 1 ? (
              <span style={{ fontSize: '11px', color: '#777777' }}>{money(it.precio_unitario)} c/u</span>
            ) : null}
          </div>
        ))}
      </div>

      {data.faltantes.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: '4px' }}>
          {data.faltantes.map((f, i) => (
            <span key={i} style={{ fontSize: '11px', color: '#b45309' }}>
              A cotizar: {f}
            </span>
          ))}
        </div>
      ) : null}

      <div style={{ display: 'flex', height: '1px', backgroundColor: '#dddddd', margin: '12px 0' }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: '#555555' }}>
        <span>Entrega</span>
        <span>Retira</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '18px', fontWeight: 700, marginTop: '6px' }}>
        <span>TOTAL</span>
        <span>{money(data.total)}</span>
      </div>
      {data.faltantes.length > 0 ? (
        <span style={{ fontSize: '11px', color: '#b45309' }}>(no incluye los ítems a cotizar)</span>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'center', fontSize: '11px', color: '#999999', marginTop: '14px' }}>
        Presupuesto
      </div>
    </div>
  )
}
