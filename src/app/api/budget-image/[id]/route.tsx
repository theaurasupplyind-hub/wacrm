import { ImageResponse } from '@vercel/og'

export const runtime = 'edge'

export async function GET() {
  return new ImageResponse(
    <div style={{ width: 400, height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'white', fontSize: 32 }}>
      HOLA
    </div>,
    { width: 400, height: 200 },
  )
}
