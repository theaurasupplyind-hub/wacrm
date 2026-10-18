/**
 * Defaults de negocio del catálogo (Plan A3).
 *
 * `DEFAULT_CATEGORIA` es la categoría que se asume cuando el texto del ítem no
 * nombra ninguna. Fuente ÚNICA: antes estaba duplicada en `classify-item.ts`,
 * `understand.ts` y `resolve-items.ts`.
 *
 * Pendiente (A3b): resolverla desde datos — el backend no expone hoy un default
 * por cuenta, así que por ahora es una constante.
 */
export const DEFAULT_CATEGORIA = 'BASTIDOR'
