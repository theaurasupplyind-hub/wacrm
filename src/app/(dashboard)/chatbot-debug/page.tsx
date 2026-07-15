'use client'

import { Bug } from 'lucide-react'

export default function ChatbotDebugPage() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Bug className="h-12 w-12 text-muted-foreground/40 mb-4" />
      <h1 className="text-2xl font-bold tracking-tight text-foreground">
        Chatbot Debug
      </h1>
      <p className="mt-2 text-sm text-muted-foreground max-w-md">
        El sistema de chatbot anterior fue deshabilitado.
        Los nuevos logs de órdenes por voz estarán disponibles próximamente.
      </p>
    </div>
  )
}
