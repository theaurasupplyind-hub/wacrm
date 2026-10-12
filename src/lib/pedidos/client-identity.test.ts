import { describe, expect, it } from 'vitest'
import {
  isPhoneLikeClientName,
  isSenderPhoneCandidate,
  normalizeClientNameReply,
} from './client-identity'

const senderPhone = '5491125491605'

describe('customer identity safety', () => {
  it('rejects the sender number and phone-as-name imports', () => {
    expect(isPhoneLikeClientName(senderPhone, senderPhone)).toBe(true)
    expect(isPhoneLikeClientName('+54 9 11 2549-1605', senderPhone)).toBe(true)
    expect(isPhoneLikeClientName('11 2549-1605', senderPhone)).toBe(true)
    expect(isPhoneLikeClientName(`Cliente ${senderPhone}`, senderPhone)).toBe(true)
  })

  it('does not reject a real customer name just because its phone matches the sender', () => {
    expect(isPhoneLikeClientName('Fede', senderPhone)).toBe(false)
    expect(
      isSenderPhoneCandidate({ nombre: 'Fede', telefono: senderPhone }, senderPhone),
    ).toBe(false)
  })

  it('filters phone-only candidate labels but keeps named customers', () => {
    expect(
      isSenderPhoneCandidate(
        { nombre: `Cliente ${senderPhone}`, telefono: senderPhone },
        senderPhone,
      ),
    ).toBe(true)
    expect(isSenderPhoneCandidate({ nombre: 'Cliente', telefono: senderPhone }, senderPhone)).toBe(true)
    expect(
      isSenderPhoneCandidate({ nombre: 'Federico López', telefono: null }, senderPhone),
    ).toBe(false)
  })

  it('does not consume task-related sentences as a customer name', () => {
    expect(normalizeClientNameReply('no lo creas, era una prueba', senderPhone)).toBeNull()
    expect(normalizeClientNameReply('estabas creando un presupuesto', senderPhone)).toBeNull()
    expect(normalizeClientNameReply('hola', senderPhone)).toBeNull()
    expect(normalizeClientNameReply('otro', senderPhone)).toBeNull()
    expect(normalizeClientNameReply('Fede López', senderPhone)).toBe('Fede López')
  })
})
