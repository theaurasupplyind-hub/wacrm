import { NextRequest, NextResponse } from 'next/server'

export async function GET(_request: NextRequest) {
  return NextResponse.json(
    { error: 'Chatbot deshabilitado. Este endpoint ya no está activo.' },
    { status: 410 },
  )
}
