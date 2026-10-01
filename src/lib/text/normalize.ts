/**
 * Normalización de texto compartida (búsqueda de nombres/entidades).
 *
 * Centraliza lo que antes estaba triplicado: quitar tildes + lowercase +
 * colapsar separadores. Es clave para que "julian" matchee a "Julián":
 * el backend de FacBal filtra con tildes, así que el matching de entidades
 * (empleados/proveedores) debe normalizar de este lado.
 */

/** Quita diacríticos (tildes/acentos) preservando el resto del texto. */
export function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * Normaliza para comparar: sin tildes, minúsculas, sin puntuación y con
 * espacios colapsados. Mantiene dígitos (nombres con números, DNI, etc.).
 */
export function normalizeText(text: string): string {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
