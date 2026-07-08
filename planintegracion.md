# Tarea: Integrar lectura automática de comprobantes de pago (WhatsApp → CRM → FacBal API)

## Contexto del sistema

Tenemos dos sistemas que hay que conectar:

1. **CRM (wacrm)**: fork de un WhatsApp CRM open source (Next.js App Router + Supabase),
   desplegado en Vercel en `https://wacrm-three-blond.vercel.app`. Recibe mensajes de
   WhatsApp Business API vía webhook en `POST /api/whatsapp/webhook`.

   Nota: el CRM trae de fábrica un "AI Assistant" que solo soporta OpenAI o Anthropic
   como proveedor (dropdown fijo en Settings). **No vamos a usar esa feature nativa**
   para esto — vamos a escribir código custom que llama directo a **OpenRouter**
   (`https://openrouter.ai/api/v1/chat/completions`, formato compatible con OpenAI),
   completamente aparte de esa UI. Esto nos da libertad total de elegir modelo.

2. **FacBal API** (`main.py`): backend FastAPI + SQLAlchemy + Postgres (base en NeonDB,
   web service en Render), sistema de gestión de un taller de molduras/marcos. Modelos
   relevantes:
   - `Client` (tabla `clientes`): id, nombre, telefono, etc.
   - `Invoice` (tabla `facturas`): id, numero_factura, cliente_nombre, **cliente_telefono**,
     total, envio, fecha (string DD/MM/YYYY), deleted_at
   - `Payment` (tabla `pagos`): id, invoice_id, amount, date, method
   - Ya expone endpoints REST: `GET /invoices`, `POST /payments`, `GET /clients`, etc.
   - **IMPORTANTE: hoy no tiene ningún tipo de autenticación en los endpoints.**

## Objetivo funcional

Cuando un cliente manda por WhatsApp una foto o PDF de un comprobante de pago (transferencia,
Mercado Pago, etc.):

1. El sistema debe **leer el comprobante con IA vía OpenRouter** y extraer: monto, fecha,
   número de referencia/operación, banco/emisor.
2. Buscar en FacBal API si ese cliente (identificado por su número de WhatsApp) tiene
   **facturas con saldo pendiente**.
3. Si el monto coincide con una factura pendiente (con tolerancia de ±$50 por redondeos):
   registrar el pago automáticamente vía `POST /payments` y responder al cliente confirmando.
4. Si hay **varias facturas candidatas**: responder pidiendo que aclare a cuál corresponde,
   listando número de factura y saldo de cada una.
5. Si **no hay ninguna factura pendiente** a su nombre: responder que no se encontró nada
   pendiente y marcar la conversación para revisión humana (tag `revision-manual` en el CRM).

Además, debe poder responder preguntas simples del tipo "¿cuánto tengo pendiente?" o
"¿cuál es el estado de mi pedido?" consultando los mismos datos en tiempo real.

## Fase 0 — Seguridad en FacBal API (hacer PRIMERO, es bloqueante)

Agregar autenticación por API key a `main.py` antes de exponer cualquier endpoint nuevo
hacia afuera:

```python
from fastapi import Header, HTTPException
import os

API_KEY = os.getenv("FACBAL_API_KEY")

def verify_api_key(x_api_key: str = Header(None)):
    if not API_KEY or x_api_key != API_KEY:
        raise HTTPException(401, "API key inválida")
```

Generar una key random (`openssl rand -hex 32`), cargarla como env var `FACBAL_API_KEY`
en Render, y la misma key como env var en Vercel (wacrm) para mandarla en el header
`X-API-Key` en cada request desde el CRM.

## Fase 1 — Endpoint nuevo en FacBal API: facturas pendientes por teléfono

Agregar a `main.py`:

- Función `normalizar_telefono(tel: str) -> str` que deja solo dígitos y saca prefijos
  de país (`54`), celular (`9`) y formato viejo (`15`), quedándose con los últimos 10
  dígitos como clave de comparación. **Esto es crítico**: el número que manda WhatsApp
  (`wa_id`, formato tipo `5491157356901`) NO va a coincidir como string exacto con lo
  que está guardado en `cliente_telefono` (formato argentino local, con guiones, sin
  código de país, etc.) — hay que normalizar ambos lados antes de comparar.

- Endpoint `GET /invoices/pending-by-phone?telefono=...` (protegido con `verify_api_key`):
  recorre `Invoice` con `deleted_at IS NULL`, compara teléfono normalizado, calcula saldo
  = `total + envio - suma(Payment.amount para ese invoice_id)`, devuelve solo las que
  tienen saldo > 0.01, con `invoice_id`, `numero_factura`, `cliente_nombre`, `total`,
  `saldo_pendiente`, `fecha`.

`POST /payments` ya existe — solo agregarle `Depends(verify_api_key)`.

## Fase 2 — En wacrm: extracción con IA vía OpenRouter

Nuevo archivo `src/lib/ai/voucher-extraction.ts`:

- Recibe la media (base64 + mime type) descargada desde la Media API de Meta
- Llama a `https://openrouter.ai/api/v1/chat/completions` con:
  - Header `Authorization: Bearer ${process.env.OPENROUTER_API_KEY}`
  - `model`: configurable vía env var `VOUCHER_AI_MODEL` (default: `google/gemini-2.5-flash`)
  - Para imágenes: content type `image_url` con data URI base64
    (`data:image/jpeg;base64,...`)
  - Para PDFs: content type `file` con `file_data` en base64 — OpenRouter procesa el PDF
    automáticamente (OCR si el modelo no lo soporta nativamente), no hace falta convertir
    a imagen antes
  - Prompt: pedir SOLO un JSON con `monto`, `fecha`, `referencia`, `banco` (null en
    cualquier campo que no se vea claro)
- Parsear la respuesta como JSON (validar que sea JSON válido antes de usarlo, con
  try/catch — si el modelo devuelve texto extra alrededor, extraer el bloque JSON)

Nueva env var en Vercel: `OPENROUTER_API_KEY` (empieza con `sk-or-...`, se consigue en
openrouter.ai/keys). Opcional: `VOUCHER_AI_MODEL` para poder cambiar de modelo sin
tocar código.

## Fase 3 — En wacrm: cliente HTTP hacia FacBal API

Nuevo archivo `src/lib/facbal/client.ts`:
- `getFacturasPendientes(telefono: string)` → GET a `/invoices/pending-by-phone`
- `registrarPago(invoiceId: number, monto: number, fecha: string)` → POST a `/payments`
- Ambas mandan header `X-API-Key` con el valor de `process.env.FACBAL_API_KEY`
- Nuevas env vars en Vercel: `FACBAL_API_URL`, `FACBAL_API_KEY`

## Fase 4 — Lógica de matching y respuesta

Nuevo archivo `src/lib/ai/voucher-matching.ts` con la lógica del punto "Objetivo funcional"
(pasos 2-5 de arriba). Reutilizar la función existente de envío de mensajes de WhatsApp
del CRM para responder.

## Fase 5 — Wiring en el webhook

Modificar el handler de `POST /api/whatsapp/webhook`: cuando el mensaje entrante sea de
tipo `image` o `document`, después de guardarlo como ya hace hoy, disparar de forma
asíncrona (fire-and-forget, sin bloquear la respuesta 200 a Meta) el pipeline completo:
descargar media → extraer vía OpenRouter → buscar facturas pendientes → matchear →
registrar pago o pedir aclaración → responder por WhatsApp.

Guardar cada intento en una tabla nueva de Supabase `voucher_extractions` (migración nueva
en `supabase/migrations/`) con: message_id, contact_id, extracted_amount, extracted_date,
extracted_reference, match_status (`matched`/`ambiguous`/`no_match`), matched_invoice_id,
created_at — para poder auditar qué leyó la IA.

## Fase 6 — Preguntas generales tipo "¿cuánto tengo pendiente?"

Cuando el mensaje entrante sea texto (no imagen/PDF) y parezca una pregunta sobre estado
de cuenta: usar el mismo cliente de OpenRouter para detectar la intención, identificar al
contacto por su wa_id, llamar `getFacturasPendientes`, y pedirle al modelo que redacte la
respuesta en lenguaje natural con los datos reales devueltos por la API (no inventar datos).

## Testing

1. Probar `normalizar_telefono` con varios formatos reales de números argentinos
2. Probar `GET /invoices/pending-by-phone` con clientes de prueba en la base
3. Mandar comprobantes de prueba por WhatsApp (buena calidad, borrosos, PDF) y revisar
   la tabla `voucher_extractions`
4. Confirmar que `POST /payments` efectivamente descuenta el saldo pendiente
5. Deploy: variables nuevas en Render (`FACBAL_API_KEY`) y en Vercel
   (`FACBAL_API_URL`, `FACBAL_API_KEY`, `OPENROUTER_API_KEY`, `VOUCHER_AI_MODEL`)