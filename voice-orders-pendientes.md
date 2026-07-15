# Voice Orders — Mejoras pendientes

## 1. Ambigüedad del LLM ("dos más")
El prompt de `parse-order.ts` no maneja bien el caso "sumarte dos más, 58x29, 184x95" (interpreta como 2x 58x29 en vez de 1x 58x29 + 1x 184x95).

**Posible fix**: agregar regla al prompt:
```
- "X más" al final de una frase indica ITEMS ADICIONALES, no cantidad del próximo item.
  Ej: "sumarte dos más, 58x29, 184x95" → dos items separados: 1x 58x29, 1x 184x95. NO 2x 58x29.
- Si el cliente dice "N de X" o "N X", entonces sí son N del mismo producto.
```

## 2. Confirmación por WhatsApp
Idea: antes de crear el presupuesto definitivo, el bot muestra un resumen con botones interactivos y el cliente confirma o corrige antes de ejecutar.

**Tecnología disponible**: Meta WhatsApp Flows (formularios incrustados) o botones interactivos simples (ya existe Flows engine en el proyecto).

Flujo propuesto:
1. Bot procesa audio → muestra resumen: "Detecté: 2x bastidor 120x130 LP, 1x pintura 40x50. Total: $XX.XXX"
2. Botón: [✅ Sí, crear presupuesto] [✏️ Corregir] [❌ Cancelar]
3. Si confirma → POST /invoices y responde con el número
4. Si corrige → pide escribir el cambio por texto

## 3. Panel FacGal (editar orden parseada)
Agregar en galv2-tauri una pantalla de confirmación antes de enviar la orden a WhatsApp, donde el operador pueda:
- Ver items parseados por el LLM
- Editar cantidades, descripciones
- Fusionar/dividir items
- Confirmar o re-chatgear si está mal
