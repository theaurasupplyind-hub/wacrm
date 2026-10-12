/** A quote request is not permission to create a persisted budget. */
const CREATE_VERB_RE = /(?:^|\s)(?:armar|arma|armas|armás|armame|armá|armáme|crear|crea|creas|creás|creame|creá|creáme|hacer|hace|haces|hacés|haceme|hacé|hacéme|preparar|prepara|preparas|preparás|preparame|prepará|preparáme|generar|genera|generas|generás|generame|generá|emitir|emite|emitís|emitime|emití|convertir|convierte|convertime|convertí)(?=\s|$)/i
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
