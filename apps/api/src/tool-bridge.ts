// The script the sandbox host adds first to a tool's pages (docs/tools.md): it
// gives the page `window.brigade`, whose calls go to the dashboard around it by
// postMessage, since the page's origin is opaque and it reaches nothing of the
// API itself. The dashboard checks each call, makes it with the person's
// session, asks the person before any that changes something, and answers.
// Messages it sends carry `source: 'brigade-tool'`; it reads only answers from
// its parent with `source: 'brigade-host'`. Outside Brigade (the page opened on
// its own), every call fails saying so, and `brigade.inBrigade` is false.
//
// Plain JavaScript in a string: it runs in the tool's page, not here.

const SOURCE = String.raw`(function () {
  if (window.brigade) return
  var framed = window.parent !== window
  var pending = {}
  var next = 1
  var call = function (method, params) {
    if (!framed)
      return Promise.reject(new Error('Open this tool in Brigade to use brigade.' + method))
    return new Promise(function (resolve, reject) {
      var id = 'c' + next++
      pending[id] = { resolve: resolve, reject: reject }
      window.parent.postMessage(
        { source: 'brigade-tool', id: id, method: method, params: params || {} },
        '*',
      )
    })
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return
    var m = event.data
    if (!m || m.source !== 'brigade-host' || typeof m.id !== 'string' || !pending[m.id]) return
    var p = pending[m.id]
    delete pending[m.id]
    if (m.ok) return p.resolve(m.result)
    var error = new Error(m.error || 'The call failed')
    if (m.code) error.code = m.code
    p.reject(error)
  })
  var state = function (shared) {
    return {
      get: function (key) {
        return call('state.get', { shared: shared, key: key })
      },
      list: function (prefix) {
        return call('state.list', { shared: shared, prefix: prefix })
      },
      set: function (key, value, options) {
        return call('state.set', {
          shared: shared,
          key: key,
          value: value,
          version: options && options.version,
        })
      },
      delete: function (key, options) {
        return call('state.delete', { shared: shared, key: key, version: options && options.version })
      },
    }
  }
  window.brigade = {
    inBrigade: framed,
    me: function () {
      return call('me')
    },
    files: {
      list: function (folder) {
        return call('files.list', { folder: folder })
      },
    },
    state: state(false),
    shared: state(true),
    apps: {
      list: function () {
        return call('apps.list')
      },
      operations: function (account) {
        return call('apps.operations', { account: account })
      },
      call: function (account, operation, input) {
        return call('apps.call', { account: account, operation: operation, input: input || {} })
      },
    },
    thread: {
      send: function (text) {
        return call('thread.send', { text: text })
      },
    },
  }
})()`

/** The bridge, as a script tag for the start of a tool page's head. */
export const toolBridgeScript = () => `<script data-brigade-tool-bridge>${SOURCE}</script>`
