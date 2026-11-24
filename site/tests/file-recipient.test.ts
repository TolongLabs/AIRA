import { expect, it } from 'vitest'
import { fileRecipient } from '../src/lib/file-recipient'

const dm = { type: 'dm' as const, waId: '000000000@s.whatsapp.net' }
const known = { kind: 'dm', target: 'whatsapp:fixture@lid', number: '+000000000', name: 'Fixture' }

it('prefers a matching canonical target and otherwise accepts one explicit host phone alias', () => {
  const exact = { ...known, target: 'whatsapp:' + dm.waId }
  expect(fileRecipient(dm, [known, exact])).toBe(exact)
  expect(fileRecipient(dm, [known])).toBe(known)
})
it('rejects ambiguous routes, unrelated address types and groups with the same digits', () => {
  expect(fileRecipient({ ...dm, deliveryTarget: null }, [known])).toBeUndefined()
  expect(fileRecipient(dm, [known, { ...known, target: 'whatsapp:other@lid' }])).toBeUndefined()
  expect(fileRecipient({ ...dm, waId: '000000000@lid' }, [known])).toBeUndefined()
  expect(fileRecipient(dm, [{ ...known, kind: 'group' }])).toBeUndefined()
})
