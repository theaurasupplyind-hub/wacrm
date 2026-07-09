import { NextResponse } from 'next/server'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const start = Date.now()
  const { id } = await params
  const imageId = parseInt(id, 10)
  if (isNaN(imageId)) {
    return NextResponse.json({ error: 'Invalid image ID' }, { status: 400 })
  }

  const facbalUrl = process.env.FACBAL_API_URL
  if (!facbalUrl) {
    return NextResponse.json({ error: 'FACBAL_API_URL not set' }, { status: 500 })
  }

  const url = `${facbalUrl.replace(/\/$/, '')}/price-list-images/${imageId}/download`
  const ua = request.headers.get('user-agent') || 'unknown'

  try {
    const res = await fetch(url)

    if (!res.ok) {
      const elapsed = Date.now() - start
      console.log('[proxy] GET /%s | ua=%s | status=%d | time=%dms | ERROR', id, ua, res.status, elapsed)
      return NextResponse.json(
        { error: `FacBal returned ${res.status}` },
        { status: 502 },
      )
    }

    const buffer = await res.arrayBuffer()
    const contentType = res.headers.get('content-type') || 'image/png'
    const elapsed = Date.now() - start
    console.log('[proxy] GET /%s | ua=%s | status=200 | size=%d bytes | time=%dms | type=%s', id, ua, buffer.byteLength, elapsed, contentType)

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
        'CDN-Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (err) {
    const elapsed = Date.now() - start
    console.error('[proxy] GET /%s | ua=%s | time=%dms | ERROR:', id, ua, elapsed, err)
    return NextResponse.json(
      { error: 'Failed to fetch image from FacBal' },
      { status: 502 },
    )
  }
}
