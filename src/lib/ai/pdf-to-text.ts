export async function pdfToText(base64: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

  const binary = new Uint8Array(Buffer.from(base64, 'base64'))
  const doc = await pdfjs.getDocument({ data: binary }).promise

  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
    pages.push(text)
  }

  return pages.join('\n---\n').replace(/\s+/g, ' ').trim()
}
