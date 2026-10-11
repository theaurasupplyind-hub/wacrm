import { describe, it, expect } from 'vitest'
import { classifyPaymentIntent, normalizeForMatch } from './payment-intent'

describe('normalizeForMatch', () => {
  it('quita tildes, baja a minúsculas y colapsa espacios', () => {
    expect(normalizeForMatch('  Pagué   A   JOSÉ ')).toBe('pague a jose')
    expect(normalizeForMatch('TRANSFERÍ')).toBe('transferi')
  })
})

describe('classifyPaymentIntent', () => {
  it('marcadores explícitos de cobro → voucher', () => {
    expect(classifyPaymentIntent('Me pagó Jo')).toBe('voucher')
    expect(classifyPaymentIntent('me pago jo en efectivo')).toBe('voucher')
    expect(classifyPaymentIntent('Nos transfirió Marlon')).toBe('voucher')
    expect(classifyPaymentIntent('Pago recibido de Ana')).toBe('voucher')
  })

  it('marcadores explícitos de pago propio / sueldo → expense', () => {
    expect(classifyPaymentIntent('Le pagué a Jo 2000000')).toBe('expense')
    expect(classifyPaymentIntent('les pague a los proveedores')).toBe('expense')
    expect(classifyPaymentIntent('transferí a Jorge')).toBe('expense')
    expect(classifyPaymentIntent('pagué la luz')).toBe('expense')
    expect(classifyPaymentIntent('Le pagué a Marlon por sueldo')).toBe('expense')
    expect(classifyPaymentIntent('adelanto para Juan')).toBe('expense')
  })

  it('forma pelada → ambiguous (siempre aclarar)', () => {
    expect(classifyPaymentIntent('Jo pago en efectivo')).toBe('ambiguous')
    expect(classifyPaymentIntent('Marlon Pago 2000000')).toBe('ambiguous')
    expect(classifyPaymentIntent('Test pago 65 000 en efectivo')).toBe('ambiguous')
    expect(classifyPaymentIntent('Jo pago en transferencia a Jorge')).toBe('ambiguous')
  })

  it('minúsculas no cuentan como sujeto que paga', () => {
    expect(classifyPaymentIntent('tambien pago la otra factura')).toBeNull()
  })

  it('sin señal de pago → null', () => {
    expect(classifyPaymentIntent('hola')).toBeNull()
    expect(classifyPaymentIntent('llegó juan 8:30')).toBeNull()
    expect(classifyPaymentIntent('')).toBeNull()
  })

  it('las tildes no cambian el resultado', () => {
    expect(classifyPaymentIntent('Me pagó Jo')).toBe(classifyPaymentIntent('Me pago Jo'))
    expect(classifyPaymentIntent('Le pagué a Jo')).toBe(classifyPaymentIntent('Le pague a Jo'))
  })
})
