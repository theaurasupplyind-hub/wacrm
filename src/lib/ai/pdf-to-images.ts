import { createCanvas, DOMMatrix, Path2D } from '@napi-rs/canvas'

if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = DOMMatrix as typeof globalThis.DOMMatrix
}
if (!globalThis.Path2D) {
  globalThis.Path2D = Path2D as typeof globalThis.Path2D
}

export type PdfContent =
  | { kind: 'text'; content: string }
  | { kind: 'image'; base64: string; mimeType: string }

async function extractText(page: import('pdfjs-dist/types/src/display/api').PDFPageProxy): Promise<string> {
  const content = await page.getTextContent()
  return content.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ').trim()
}

async function renderPage(page: import('pdfjs-dist/types/src/display/api').PDFPageProxy): Promise<{ base64: string; mimeType: string }> {
  const viewport = page.getViewport({ scale: 6.0 })

  const canvas = createCanvas(viewport.width, viewport.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, viewport.width, viewport.height)

  await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise

  const pngBuffer = canvas.toBuffer('image/png')
  return { base64: pngBuffer.toString('base64'), mimeType: 'image/png' }
}

export async function pdfToImages(base64: string): Promise<PdfContent[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdfjsWorker = await import(
    // @ts-expect-error -- pdf.worker.mjs has no types
    'pdfjs-dist/legacy/build/pdf.worker.mjs'
  )
  ;(globalThis as Record<string, unknown>).pdfjsWorker = pdfjsWorker

  const binary = new Uint8Array(Buffer.from(base64, 'base64'))
  const doc = await pdfjs.getDocument({ data: binary }).promise

  const maxPages = Math.min(doc.numPages, 3)
  const result: PdfContent[] = []

  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i)
    const text = await extractText(page)

    if (text.length >= 30) {
      result.push({ kind: 'text', content: text })
    } else {
      const rendered = await renderPage(page)
      result.push({ kind: 'image', ...rendered })
    }
  }

  return result
}
