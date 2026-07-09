import { NextResponse } from 'next/server'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const imageId = parseInt(id, 10)
  if (isNaN(imageId)) {
    return NextResponse.json({ error: 'Invalid image ID' }, { status: 400 })
  }

  const facbalUrl = process.env.FACBAL_API_URL
  if (!facbalUrl) {
    return NextResponse.json({ error: 'FACBAL_API_URL not set' }, { status: 500 })
  }

  const url = `${facbalUrl.replace(/\/$/, '')}/price-list-images/${imageId}/view`

  try {
    const res = await fetch(url)

    if (!res.ok) {
      return NextResponse.json(
        { error: `FacBal returned ${res.status}` },
        { status: 502 },
      )
    }

    const buffer = await res.arrayBuffer()
    const contentType = res.headers.get('content-type') || 'image/webp'

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
        'CDN-Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (err) {
    console.error('[proxy] FacBal image fetch failed:', err)
    return NextResponse.json(
      { error: 'Failed to fetch image from FacBal' },
      { status: 502 },
    )
  }
}
