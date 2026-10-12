import { ImageResponse } from 'next/og'
import { getInvoice } from '@/lib/facbal/client'
import { RECEIPT_BASE_WIDTH, RECEIPT_DEFAULT_SCALE, receiptElement } from '@/lib/pedidos/receipt-image'
import { getReceiptFonts } from '@/lib/pedidos/receipt-fonts'
import { invoiceToReceipt } from '@/lib/pedidos/receipt-data'

export const dynamic = 'force-dynamic'

// 2x sobre el layout de 400px: el PNG sale de 800px de ancho y WhatsApp no
// tiene que reescalarlo (que era lo que lo dejaba borroso).
const SCALE = RECEIPT_DEFAULT_SCALE
const WIDTH = RECEIPT_BASE_WIDTH * SCALE

// satori no auto-sizea el canvas: estimamos sobre el layout lógico y escalamos.
function estimatedHeight(itemCount: number, faltantes: number): number {
  return Math.max(520, 380 + itemCount * 44 + faltantes * 18) * SCALE
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const invoiceId = parseInt(id, 10)
  if (Number.isNaN(invoiceId)) {
    return new Response('Invalid invoice id', { status: 400 })
  }

  try {
    const invoice = await getInvoice(invoiceId)
    if (!invoice) {
      return new Response('Invoice not found', { status: 404 })
    }

    const data = invoiceToReceipt(invoice)
    return new ImageResponse(receiptElement(data, { scale: SCALE }), {
      width: WIDTH,
      height: estimatedHeight(data.items.length, data.faltantes.length),
      fonts: await getReceiptFonts(),
    })
  } catch (err) {
    console.error(`[presupuesto-image] error generando imagen ${invoiceId}:`, err)
    return new Response('Failed to generate receipt image', { status: 500 })
  }
}
