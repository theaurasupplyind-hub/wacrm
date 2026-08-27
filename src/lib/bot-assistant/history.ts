export interface TurnInput {
  role: string
  content: string
}

export function buildHistoryText(turns: TurnInput[]): string {
  return turns.slice(-10).map((t) => `${t.role}: ${t.content}`).join('\n')
}
