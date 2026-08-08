# Voice Orders / Bot de pedidos

> **Estado:** ✅ Activo — con UI en `/bot-beta`
> Arquitectura general: [`architecture.md`](./architecture.md) §2
> Este documento es la fuente viva del módulo (estado actual + mejoras pendientes).

**Propósito:** Toma pedidos por voz (audio) o texto vía WhatsApp, transcribe,
parsea, resuelve precios a través de FacBal API y crea presupuestos/facturas.

---

## Estado actual

### Archivos clave

| Archivo | Rol |
|---------|-----|
| `src/lib/voice-orders/index.ts` | Entry point: `processVoiceOrder()`, `processTextOrder()` |
| `src/lib/voice-orders/types.ts` | Tipos: `ParsedOrder`, `VoiceOrderResult`, etc. |
| `src/lib/voice-orders/transcribe.ts` | Transcripción de audio vía OpenRouter Whisper |
| `src/lib/voice-orders/parse-order.ts` | Parseo LLM de texto a pedido estructurado |
| `src/lib/voice-orders/execute-order.ts` | Pipeline de resolución: cliente → items → precios → factura |
| `src/app/api/bot-beta/run/route.ts` | REST endpoint para texto |
| `src/app/api/bot-beta/voice-run/route.ts` | REST endpoint para audio (FormData) |
| `src/app/(dashboard)/bot-beta/page.tsx` | UI beta con chat + audio + debug panel |

### Flujo (audio WhatsApp)

```
Mensaje de Audio WhatsApp
  ↓
processMessage() webhook
  ↓
handleVoiceAudio()
  ↓
processVoiceOrder()
  ├── 1. transcribeAudio() → OpenRouter Whisper (openai/whisper-1)
  ├── 2. parseOrder() → OpenRouter LLM (gemini-2.5-flash-lite)
  │       → {tipo, cliente_nombre, items, variante_respuesta}
  ├── 3. runPipeline()
  │       ├── searchOrCreateClient() → FacBal API
  │       ├── resolveItems() → FacBal suggestPrice (por item)
  │       ├── priceItems() → FacBal bulkPrice
  │       └── createPresupuesto() → FacBal createInvoice (si commit=true)
  └── 4. sendVoiceResponse() → WhatsApp reply
```

### Flujo (texto WhatsApp)

```
Mensaje de Texto WhatsApp (no consumido por Flows Engine)
  ↓
processMessage() webhook
  ↓
handleVoiceText()
  ↓
processTextOrder() → mismo pipeline (salta transcripción)
```

### Soporte multi-turno

- Si un item tiene múltiples variantes → pregunta al usuario, guarda estado en `voice_context`
- Si falta nombre de cliente → pregunta, guarda en `voice_context`
- `commit=false` (default) → devuelve preview sin crear factura

### Base de datos

| Migration | Tabla/Columna | Propósito |
|-----------|---------------|-----------|
| `035_voice_context.sql` | `conversations.voice_context` (JSONB) | Estado entre mensajes (variantes pendientes, client name, invoice) |

---

## Mejoras pendientes

### 1. Ambigüedad del LLM ("dos más")

El prompt de `parse-order.ts` no maneja bien el caso "sumarte dos más, 58x29, 184x95" (interpreta como 2x 58x29 en vez de 1x 58x29 + 1x 184x95).

**Posible fix:** agregar regla al prompt:

```
- "X más" al final de una frase indica ITEMS ADICIONALES, no cantidad del próximo item.
  Ej: "sumarte dos más, 58x29, 184x95" → dos items separados: 1x 58x29, 1x 184x95. NO 2x 58x29.
- Si el cliente dice "N de X" o "N X", entonces sí son N del mismo producto.
```

### 2. Confirmación por WhatsApp

Idea: antes de crear el presupuesto definitivo, el bot muestra un resumen con botones interactivos y el cliente confirma o corrige antes de ejecutar.

**Tecnología disponible:** Meta WhatsApp Flows (formularios incrustados) o botones interactivos simples (ya existe Flows engine en el proyecto).

Flujo propuesto:

1. Bot procesa audio → muestra resumen: "Detecté: 2x bastidor 120x130 LP, 1x pintura 40x50. Total: $XX.XXX"
2. Botón: [✅ Sí, crear presupuesto] [✏️ Corregir] [❌ Cancelar]
3. Si confirma → `POST /invoices` y responde con el número
4. Si corrige → pide escribir el cambio por texto

### 3. Panel FacGal (editar orden parseada)

Agregar en `galv2-tauri` una pantalla de confirmación antes de enviar la orden a WhatsApp, donde el operador pueda:

- Ver items parseados por el LLM
- Editar cantidades, descripciones
- Fusionar/dividir items
- Confirmar o re-chatear si está mal

---

## Roadmap

La unificación de este módulo con el resto de los intents del bot (gastos,
asistencia, vouchers, facturas) está planificada en el router unificado con
umbral de confianza de 3 niveles — ver [`archive/bot-personal.md`](./archive/bot-personal.md).
