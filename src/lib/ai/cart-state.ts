export type CartStatus = 'cotizando' | 'productos_confirmados' | 'presupuesto_enviado' | 'confirmado'

export interface CartItem {
  cantidad: number
  categoria: string
  medida: string
  variante: string
  precio_unitario: number | null
  subtotal: number | null
}

export interface CartState {
  status: CartStatus
  items: CartItem[]
  total: number
  fecha: string
  items_faltantes: string[]
}

export function createCart(
  items: {
    cantidad: number
    categoria: string
    medida: string
    variante: string
    precio: number | null
    faltante: boolean
  }[],
): CartState {
  const cartItems: CartItem[] = items.map((item) => ({
    cantidad: item.cantidad,
    categoria: item.categoria,
    medida: item.medida,
    variante: item.variante || '',
    precio_unitario: item.precio,
    subtotal: item.precio != null ? item.cantidad * item.precio : null,
  }))

  const total = cartItems.reduce((sum, i) => sum + (i.subtotal || 0), 0)
  const itemsFaltantes = cartItems
    .filter((i) => i.precio_unitario == null)
    .map((i) => `${i.categoria} ${i.medida}${i.variante ? ` (${i.variante})` : ''}`)

  return {
    status: 'cotizando',
    items: cartItems,
    total,
    fecha: new Date().toLocaleDateString('es-AR'),
    items_faltantes: itemsFaltantes,
  }
}

export function formatCartForLLM(cart: CartState): string {
  const lines: string[] = [`ESTADO: ${cart.status}`]

  if (cart.items.length > 0) {
    lines.push('PRODUCTOS EN EL CARRITO:')
    for (const item of cart.items) {
      const desc = `${item.categoria} ${item.medida}${item.variante ? ` (${item.variante})` : ''}`
      if (item.precio_unitario != null) {
        lines.push(
          `  ${item.cantidad}x ${desc} = $${item.subtotal!.toLocaleString('es-AR')} (unit. $${item.precio_unitario.toLocaleString('es-AR')})`,
        )
      } else {
        lines.push(`  ${item.cantidad}x ${desc} = FALTANTE (sin precio en tabla)`)
      }
    }
    if (cart.total > 0) {
      lines.push(`TOTAL (productos con precio): $${cart.total.toLocaleString('es-AR')}`)
    }
  }

  if (cart.items_faltantes.length > 0) {
    lines.push(
      `ATENCION: ${cart.items_faltantes.length} producto(s) sin precio de referencia — un agente debe cotizarlos.`,
    )
  }

  return lines.join('\n')
}

export function formatCartBudget(
  cart: CartState,
  clienteNombre: string,
  clienteTelefono: string,
): string {
  const itemsConPrecio = cart.items.filter((i) => i.subtotal != null)
  const itemLines = itemsConPrecio
    .map((i) => {
      return `  ${i.cantidad}x ${i.categoria} ${i.medida}${i.variante ? ` (${i.variante})` : ''}  -  $${i.subtotal!.toLocaleString('es-AR')}`
    })
    .join('\n')

  let text = `*PRESUPUESTO*\n${cart.fecha}\n\n*Cliente:* ${clienteNombre}\n*Tel:* ${clienteTelefono}\n\n*Productos:*\n${itemLines}\n`

  if (cart.items_faltantes.length > 0) {
    text += `\n*Pendientes de cotizar por un agente:*\n`
    text += cart.items_faltantes.map((f) => `  - ${f}`).join('\n') + '\n'
  }

  text += `─────────────────────────\n*TOTAL: $${cart.total.toLocaleString('es-AR')}*\n\n`

  if (cart.items_faltantes.length > 0) {
    text += `Los productos sin precio te los cotiza un agente aparte.\n`
  }

  text += `Escribi *"confirmar pedido"* para aceptar.`

  return text
}
