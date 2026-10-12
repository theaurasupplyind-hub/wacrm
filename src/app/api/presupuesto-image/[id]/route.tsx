import { ImageResponse } from 'next/og'
import { getInvoice } from '@/lib/facbal/client'
import { receiptElement } from '@/lib/pedidos/receipt-image'
import { invoiceToReceipt } from '@/lib/pedidos/receipt-data'

export const dynamic = 'force-dynamic'

const WIDTH = 400

function estimatedHeight(itemCount: number, faltantes: number): number {
  return Math.max(420, 320 + itemCount * 40 + faltantes * 18)
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
    return new ImageResponse(receiptElement(data), {
      width: WIDTH,
      height: estimatedHeight(data.items.length, data.faltantes.length),
    })
  } catch (err) {
    console.error(`[presupuesto-image] error generando imagen ${invoiceId}:`, err)
    return new Response('Failed to generate receipt image', { status: 500 })
  }
}
