// The local socket the runner talks to: one JSON object per line each way.
// Request: {"id": 1, "token": "...", "method": "click", "params": {...}}
// Reply:   {"id": 1, "ok": true, "result": {...}} or {"id": 1, "ok": false, "error": {"code", "message"}}
import Foundation

struct HelperError: Error {
  let code: String
  let message: String
  init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }
}

typealias Handler = (_ method: String, _ params: [String: Any]) async throws -> Any

final class SocketServer {
  private let path: String
  private let token: String
  private let handle: Handler

  init(path: String, token: String, handle: @escaping Handler) {
    self.path = path
    self.token = token
    self.handle = handle
  }

  func start() throws {
    unlink(path)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw HelperError("socket", "socket() failed: \(errno)") }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let capacity = MemoryLayout.size(ofValue: addr.sun_path)
    guard path.utf8.count < capacity else { throw HelperError("socket", "socket path too long: \(path)") }
    withUnsafeMutablePointer(to: &addr.sun_path) { pointer in
      pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { _ = strncpy($0, path, capacity - 1) }
    }
    let bound = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bound == 0 else { throw HelperError("socket", "bind(\(path)) failed: \(errno)") }
    chmod(path, 0o600)
    guard listen(fd, 16) == 0 else { throw HelperError("socket", "listen() failed: \(errno)") }
    Thread {
      while true {
        let client = accept(fd, nil, nil)
        if client < 0 { continue }
        Thread { self.serve(client) }.start()
      }
    }.start()
  }

  private func serve(_ fd: Int32) {
    defer { close(fd) }
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 65536)
    while true {
      let count = read(fd, &chunk, chunk.count)
      if count <= 0 { return }
      buffer.append(contentsOf: chunk[0..<count])
      while let newline = buffer.firstIndex(of: 0x0A) {
        let line = buffer.subdata(in: buffer.startIndex..<newline)
        buffer.removeSubrange(buffer.startIndex...newline)
        let reply = respond(to: line)
        guard var out = try? JSONSerialization.data(withJSONObject: reply) else { return }
        out.append(0x0A)
        let sent = out.withUnsafeBytes { write(fd, $0.baseAddress, out.count) }
        if sent < 0 { return }
      }
    }
  }

  private func respond(to line: Data) -> [String: Any] {
    guard let request = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
      return failure(nil, HelperError("invalid_request", "not a JSON object"))
    }
    let id = request["id"]
    guard request["token"] as? String == token else {
      return failure(id, HelperError("unauthorized", "wrong token"))
    }
    guard let method = request["method"] as? String else {
      return failure(id, HelperError("invalid_request", "method is required"))
    }
    let params = request["params"] as? [String: Any] ?? [:]
    // Each connection has its own thread: wait here for the async handler.
    let done = DispatchSemaphore(value: 0)
    var reply: [String: Any] = [:]
    Task {
      do {
        let result = try await handle(method, params)
        reply = ["id": id ?? NSNull(), "ok": true, "result": result]
      } catch let error as HelperError {
        reply = failure(id, error)
      } catch {
        reply = failure(id, HelperError("failed", "\(error)"))
      }
      done.signal()
    }
    done.wait()
    return reply
  }

  private func failure(_ id: Any?, _ error: HelperError) -> [String: Any] {
    ["id": id ?? NSNull(), "ok": false, "error": ["code": error.code, "message": error.message]]
  }
}
