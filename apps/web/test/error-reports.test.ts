// The dashboard's error reports (lib/error-reports): what is not worth sending to PostHog.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ignored } from '../lib/error-reports'

test("the browser's ResizeObserver notice is not reported", () => {
  // What `window.onerror` gets: no error object, only the message, read as a plain Error.
  for (const value of [
    'ResizeObserver loop completed with undelivered notifications.',
    'ResizeObserver loop completed with undelivered notifications',
    'ResizeObserver loop limit exceeded',
  ])
    assert.equal(ignored(value, 'Error', value), true, value)
})

test('other errors are still reported', () => {
  const error = new TypeError("Cannot read properties of undefined (reading 'id')")
  assert.equal(ignored(error, error.name, error.message), false)
  for (const value of [
    'ResizeObserver is not defined',
    'Something about a ResizeObserver loop completed with undelivered notifications.',
  ])
    assert.equal(ignored(value, 'Error', value), false, value)
})

test('the network gone and cross-origin scripts stay left out', () => {
  assert.equal(ignored(new TypeError('Failed to fetch'), 'TypeError', 'Failed to fetch'), true)
  assert.equal(ignored('Script error.', 'Error', 'Script error.'), true)
})
