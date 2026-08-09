/**
 * Detecta el comando de texto "corregir categoría" (con o sin acentos) que el
 * bot promete tras registrar un gasto con categoría nueva:
 * "Si querés corregir la categoría, escribí 'corregir categoría'."
 */
export function isCategoryCorrectionCommand(text: string): boolean {
  const t = (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
  return /(corregir|corregi|cambiar|cambio|cambie|cambia)\s+(la\s+)?categoria/.test(t)
}
