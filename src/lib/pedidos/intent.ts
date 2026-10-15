/** A quote request is not permission to create a persisted budget. */
const CREATE_VERB_RE = /(?:^|\s)(?:armar|arma|armas|armás|armame|armá|armáme|armalo|armala|crear|crea|creas|creás|creame|creá|creáme|crealo|creala|hacer|hace|haces|hacés|haceme|hacé|hacéme|hagas|hagás|hacelo|hacela|hagalo|hagala|preparar|prepara|preparas|preparás|preparame|prepará|preparáme|preparalo|preparala|generar|genera|generas|generás|generame|generá|generalo|generala|emitir|emite|emitís|emitime|emití|emitilo|emitila|convertir|convierte|convertime|convertí|convertilo|convertila|conviertelo|conviertela)(?=\s|$)/i
const BUDGET_NOUN_RE = /\b(?:presupuesto|pedido)\b/i
const BUDGET_AS_VERB_RE = /\bpresupuest(?:ame|á|a)\b/i
const DIRECT_BUDGET_REQUEST_RE = /\b(?:quiero|necesito|preciso)\s+(?:un\s+)?presupuesto\b/i
const ORDER_ITEM_RE = /\d{1,4}\s*[x×*]\s*\d{1,4}|\b(?:bastidor(?:es)?|lienzo|lona|tapacanto(?:s)?|acrilico|marco|moldura(?:s)?|circular(?:es)?|rollo|embastar)\b/i

export function isExplicitBudgetCreationRequest(text: string): boolean {
  const value = (text || '').trim()
  if (/^no\b/i.test(value)) return false
  return (
    BUDGET_AS_VERB_RE.test(value) ||
    DIRECT_BUDGET_REQUEST_RE.test(value) ||
    (CREATE_VERB_RE.test(value) && BUDGET_NOUN_RE.test(value))
  )
}

export function mentionsOrderItems(text: string): boolean {
  const normalized = (text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return ORDER_ITEM_RE.test(normalized.trim())
}

/**
 * El mensaje parece responder a un slot del pedido (cliente, entrega, fecha o
 * descuento). Se usa para no perder la continuidad de una cotización
 * abierta/descartada-reanudable ("armalo a nombre de Federico", "el cliente es
 * X, es envío") frente al asistente genérico.
 */
const ORDER_SLOT_RE =
  /\b(?:a nombre de|el cliente es|cliente:)\b|\b(?:envio|retira|retiro|domicilio|direccion|entregar?)\b|\bdescuento\b|\b\d+\s*%|\b(?:fecha de entrega|para (?:el|manana|hoy|pasado))\b/i

export function looksLikeOrderSlotReply(text: string): boolean {
  const normalized = (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
  if (!normalized) return false
  return ORDER_SLOT_RE.test(normalized)
}
