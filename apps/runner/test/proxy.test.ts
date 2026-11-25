// A Mac that reaches the internet only through a proxy set in System Settings (a VPN app's
// "system proxy" mode): Brigade.app's window got through, while Claude Code, started by the
// runner without the proxy, was refused on every turn (src/harness/proxy.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { personShell } from '../src/harness/env.js'
import { namesProxy, parseScutilProxy, proxyVarsIn, withSystemProxy } from '../src/harness/proxy.js'

/** What `scutil --proxy` prints with a VPN app's system proxy on (HTTP and HTTPS on one port). */
const SYSTEM = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : localhost
    3 : *.local
    4 : 169.254/16
    5 : timestamp.apple.com
  }
  ExcludeSimpleHostnames : 1
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}
`

test("the system's proxy becomes the variables Claude Code and Codex read", () => {
  assert.deepEqual(parseScutilProxy(SYSTEM), {
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    https_proxy: 'http://127.0.0.1:7890',
    HTTP_PROXY: 'http://127.0.0.1:7890',
    http_proxy: 'http://127.0.0.1:7890',
    NO_PROXY: 'localhost,127.0.0.1,::1,.local,timestamp.apple.com',
    no_proxy: 'localhost,127.0.0.1,::1,.local,timestamp.apple.com',
  })
})

test('an HTTP proxy alone serves HTTPS too; a SOCKS proxy or none gives nothing', () => {
  const http = `<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 8080\n  HTTPProxy : proxy.corp\n}\n`
  assert.equal(parseScutilProxy(http)?.HTTPS_PROXY, 'http://proxy.corp:8080')
  assert.equal(parseScutilProxy(http)?.NO_PROXY, 'localhost,127.0.0.1,::1')
  const socks = `<dictionary> {\n  SOCKSEnable : 1\n  SOCKSPort : 1086\n  SOCKSProxy : 127.0.0.1\n}\n`
  assert.equal(parseScutilProxy(socks), undefined)
  // Turned off in System Settings: its host stays written, with Enable at 0.
  const off = `<dictionary> {\n  HTTPEnable : 0\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n}\n`
  assert.equal(parseScutilProxy(off), undefined)
  assert.equal(parseScutilProxy('<dictionary> {\n  FTPPassive : 1\n}\n'), undefined)
})

test('a proxy the runner or the shell names wins over the system one', () => {
  const system = () => parseScutilProxy(SYSTEM)
  const own = { PATH: '/bin', https_proxy: 'http://10.0.0.1:3128' }
  assert.deepEqual(withSystemProxy(own, system), own)
  const none = withSystemProxy({ PATH: '/bin', no_proxy: 'intranet.corp' }, system)
  assert.equal(none.HTTPS_PROXY, 'http://127.0.0.1:7890')
  // Hosts the person sends straight stay straight, beside the system's.
  assert.equal(none.no_proxy, 'intranet.corp,localhost,127.0.0.1,::1,.local,timestamp.apple.com')
  assert.deepEqual(
    withSystemProxy({ PATH: '/bin' }, () => undefined),
    { PATH: '/bin' },
  )
  assert.equal(namesProxy({ NO_PROXY: 'localhost' }), false)
  assert.equal(namesProxy({ ALL_PROXY: 'socks5://127.0.0.1:1086' }), true)
})

test("the login shell's proxy comes with its PATH, whatever the shell prints around them", () => {
  const out =
    'Last login: Tue\n__BRIGADE_PATH__/opt/homebrew/bin:/usr/bin__BRIGADE_PATH____BRIGADE_PROXY__' +
    'HOME=/Users/kim\nhttps_proxy=http://127.0.0.1:7890\nALL_PROXY=socks5://127.0.0.1:7891\n' +
    'NOT_A_PROXY=x\nno_proxy=localhost\n__BRIGADE_PROXY__'
  assert.deepEqual(personShell(out), {
    path: '/opt/homebrew/bin:/usr/bin',
    proxy: {
      https_proxy: 'http://127.0.0.1:7890',
      ALL_PROXY: 'socks5://127.0.0.1:7891',
      no_proxy: 'localhost',
    },
  })
  assert.deepEqual(proxyVarsIn('http_proxy=\n'), {})
})
