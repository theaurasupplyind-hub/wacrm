import { createCanvas, DOMMatrix, Path2D } from '@napi-rs/canvas'

if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = DOMMatrix as typeof globalThis.DOMMatrix
}
if (!globalThis.Path2D) {
  globalThis.Path2D = Path2D as typeof globalThis.Path2D
}

export async function pdfToImages(
  base64: string,
): Promise<{ base64: string; mimeType: string }[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = ''

  const binary = new Uint8Array(Buffer.from(base64, 'base64'))
  const doc = await pdfjs.getDocument({ data: binary }).promise

  const maxPages = Math.min(doc.numPages, 3)
  const pages: { base64: string; mimeType: string }[] = []

  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: 2.0 })

    const canvas = createCanvas(viewport.width, viewport.height)
    const ctx = canvas.getContext('2d')!

    await page.render({ canvas: null, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise

    const pngBuffer = canvas.toBuffer('image/png')
    pages.push({
      base64: pngBuffer.toString('base64'),
      mimeType: 'image/png',
    })
  }

  return pages
}
