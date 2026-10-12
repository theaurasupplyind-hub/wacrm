import { describe, it, expect } from 'vitest'
import { ImageResponse } from '@vercel/og'
import { RECEIPT_BASE_WIDTH, RECEIPT_DEFAULT_SCALE, receiptElement } from './receipt-image'
import { getReceiptFonts } from './receipt-fonts'

const WIDTH = RECEIPT_BASE_WIDTH * RECEIPT_DEFAULT_SCALE
const HEIGHT = 700 * RECEIPT_DEFAULT_SCALE

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
  envio: 0,
  retira: true,
  tipoEntrega: 'Retira',
  mode: 'PRESUPUESTO' as const,
}

async function render(
  element: ReturnType<typeof receiptElement>,
  size: { width: number; height: number } = { width: WIDTH, height: HEIGHT },
) {
  const res = new ImageResponse(element, {
    ...size,
    fonts: await getReceiptFonts(),
  })
  expect(res.headers.get('content-type')).toBe('image/png')
  const buf = Buffer.from(await res.arrayBuffer())
  expect(buf.byteLength).toBeGreaterThan(1000)
  // IHDR del PNG: ancho en bytes 16-19, alto en 20-23 (big-endian). Confirma
  // que el render sale a 2x y no a 400px.
  expect(buf.readUInt32BE(16)).toBe(size.width)
  expect(buf.readUInt32BE(20)).toBe(size.height)
}

describe('receiptElement', () => {
  it('renderiza un PNG válido con la tarjeta (presupuesto)', async () => {
    await render(receiptElement(data))
  })

  it('renderiza con saldo "Pagado" y modo borrador', async () => {
    await render(receiptElement({ ...data, mode: 'BORRADOR', saldo: 0 }))
  })

  it('respeta una escala custom', async () => {
    await render(receiptElement(data, { scale: 1 }), { width: RECEIPT_BASE_WIDTH, height: 700 })
  })
})
