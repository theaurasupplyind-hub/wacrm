import { describe, it, expect } from 'vitest'
import { ImageResponse } from '@vercel/og'
import { receiptElement } from './receipt-image'

const data = {
  numeroPresupuesto: 'P-10001',
  fecha: '11/10/2026',
  clienteNombre: 'Juan Pérez',
  clienteTelefono: '5491122334455',
  items: [
    { cantidad: 2, descripcion: 'Bastidor 60 x 40 Sin Tela', precio_unitario: 18000, total: 36000 },
    { cantidad: 1, descripcion: 'Tapacanto 60 x 40', precio_unitario: 24000, total: 24000 },
  ],
  total: 60000,
  faltantes: ['acrilico 94x81'],
}

describe('receiptElement', () => {
  it('renderiza un PNG válido con la tarjeta', async () => {
    const res = new ImageResponse(receiptElement(data), { width: 400, height: 620 })
    expect(res.headers.get('content-type')).toBe('image/png')
    const buf = await res.arrayBuffer()
    expect(buf.byteLength).toBeGreaterThan(1000)
  })
})
