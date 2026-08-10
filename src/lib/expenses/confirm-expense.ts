import type { ExpenseExecutionResult, ExpenseFuzzyMatch } from './types'

export function buildExpenseConfirmation(result: ExpenseExecutionResult): string {
  if (result.error) {
    return `❌ No pude registrar el gasto: ${result.error}`
  }

  const lines: string[] = ['✅ Gasto registrado:']
  lines.push(`💰 $${result.amount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`)
  lines.push(`📁 ${result.categoryName}${result.isNewCategory ? ' (categoría creada automáticamente)' : ''}`)
  if (result.providerName) {
    lines.push(`🏭 Proveedor: ${result.providerName}`)
  }
  if (result.employeeName) {
    lines.push(`👷 Empleado: ${result.employeeName}`)
  }
  if (result.payments && result.payments.length > 1) {
    for (const p of result.payments) {
      const label = p.payment_method === 'efectivo' ? 'Efectivo' : 'Transferencia'
      lines.push(`   ${label}: $${p.amount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`)
    }
  } else {
    const methodLabel = result.payments?.[0]?.payment_method
    if (methodLabel && methodLabel !== 'efectivo') {
      lines.push(`💳 ${methodLabel === 'transferencia' ? 'Transferencia' : methodLabel}`)
    }
  }
  lines.push(`📝 ${result.description}`)

  // Saldo/deuda restante
  if (result.saldoResult && result.saldoResult.expenseId) {
    lines.push('')
    lines.push('📋 Deuda registrada (saldo pendiente):')
    lines.push(`💰 $${result.saldoResult.amount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`)
    if (result.saldoResult.payments && result.saldoResult.payments.length > 1) {
      for (const p of result.saldoResult.payments) {
        const label = p.payment_method === 'efectivo' ? 'Efectivo' : 'Transferencia'
        lines.push(`   ${label}: $${p.amount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`)
      }
    }
  }

  if (result.isNewCategory) {
    lines.push('Si querés corregir la categoría, escribí "corregir categoría".')
  }

  return lines.join('\n')
}

export function buildExpensePreview(
  parsed: {
    amount: number | null
    description: string | null
    category: string | null
    provider: string | null
    employee: string | null
  },
  match?: ExpenseFuzzyMatch,
): string {
  if (!parsed.amount || parsed.amount <= 0) {
    return 'No detecté un monto. ¿Podés repetir con el monto del gasto?'
  }

  const lines: string[] = ['Voy a registrar este gasto:']
  lines.push(`💰 $${parsed.amount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`)
  lines.push(`📁 ${match?.categoryName || parsed.category || 'Sin categoría'}`)
  // Mostrar la entidad RESUELTA por el match, no el texto crudo del extractor.
  if (match?.employeeId && match.employeeName) {
    lines.push(`👷 Empleado: ${match.employeeName}`)
  } else if (match?.providerId && match.providerName) {
    lines.push(`🏭 Proveedor: ${match.providerName}`)
  } else if (parsed.provider || parsed.employee) {
    lines.push('⚠️ Entidad sin confirmar (se guardará sin vínculo)')
  }
  lines.push(`📝 ${parsed.description || 'Gasto'}`)
  lines.push('')
  lines.push('¿Confirmás?')
  return lines.join('\n')
}
