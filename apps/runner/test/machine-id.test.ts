import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMachineId } from '../src/config.js'

test('reads the machine ID each OS shows', () => {
  assert.equal(
    parseMachineId(
      'darwin',
      '+-o J314sAP  <class IOPlatformExpertDevice>\n    "IOPlatformUUID" = "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0"\n',
    ),
    '0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0',
  )
  assert.equal(
    parseMachineId(
      'win32',
      '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    6c1d7a52-2b9e-4f0e-9d1a-3e5f7b9c1d2e\r\n',
    ),
    '6c1d7a52-2b9e-4f0e-9d1a-3e5f7b9c1d2e',
  )
  assert.equal(parseMachineId('linux', '4c4c4544004d3510\n'), '4c4c4544004d3510')
})

test('no machine ID when the OS does not say', () => {
  assert.equal(parseMachineId('darwin', ''), undefined)
  assert.equal(parseMachineId('win32', 'ERROR: The system was unable to find the key'), undefined)
  assert.equal(parseMachineId('linux', '\n'), undefined)
})
