// Envío del presupuesto por WhatsApp: tarjeta como imagen (Fase 4) con fallback
// a texto si falla el render o el envío del media.

import { engineSendMedia, engineSendText } from '@/lib/flows/meta-send'

export interface SendPedidoReceiptArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  /** URL pública de `/api/presupuesto-image/[id]`. Si falta, va directo a texto. */
  imageUrl?: string
  /** Texto que acompaña la imagen (o se usa tal cual en el fallback). */
  caption: string
}

/** Devuelve true si logró enviar algo (imagen o texto). */
export async function sendPedidoReceipt(args: SendPedidoReceiptArgs): Promise<boolean> {
  if (args.imageUrl) {
    try {
      await engineSendMedia({
        accountId: args.accountId,
        userId: args.userId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        kind: 'image',
        link: args.imageUrl,
        caption: args.caption,
      })
      return true
    } catch (err) {
      console.error('[pedido] fallo el envío de la imagen, fallback a texto:', err)
    }
  }

  try {
    await engineSendText({
      accountId: args.accountId,
      userId: args.userId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text: args.caption,
    })
    return true
  } catch (err) {
    console.error('[pedido] fallo el envío de texto del presupuesto:', err)
    return false
  }
}
