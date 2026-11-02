// `run` (Sources/BrigadeComputerUse/Run.swift): what it returns, and that nothing it started
// outlives it. `swift test` in apps/computer-use-macos; it starts no app and asks for nothing.
import XCTest

@testable import BrigadeComputerUse

final class RunTests: XCTestCase {
  let keep: () async -> Bool = { true }

  func run(_ command: String, cwd: String? = nil, env: [String: String] = [:], timeout: Double = 10)
    async throws -> [String: Any]
  {
    try await Run.run(command: command, cwd: cwd, env: env, timeout: timeout, hold: keep)
  }

  /// Whether a `sleep <tag>` is still running.
  func sleeping(_ tag: String) async throws -> Bool {
    let r = try await run("ps -axo command= | grep -c '^sleep \(tag)$' || true")
    return (r["output"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) != "0"
  }

  func testOutputAndExitCode() async throws {
    let r = try await run("echo hello; echo oops >&2; exit 3")
    XCTAssertEqual(r["output"] as? String, "hello\noops\n")
    XCTAssertEqual(r["exitCode"] as? Int32, 3)
  }

  func testCwdAndEnvironment() async throws {
    let r = try await run("pwd; echo $FOO", cwd: "/tmp", env: ["FOO": "bar"])
    XCTAssertTrue((r["output"] as? String ?? "").hasSuffix("/tmp\nbar\n"))
  }

  func testTimeoutStopsIt() async throws {
    let started = Date()
    let r = try await run("sleep 30", timeout: 1)
    XCTAssertEqual(r["timedOut"] as? Bool, true)
    XCTAssertLessThan(Date().timeIntervalSince(started), 2)
  }

  func testACommandIgnoringSigtermIsKilled() async throws {
    let started = Date()
    let r = try await run("trap '' TERM; sleep 30", timeout: 1)
    XCTAssertEqual(r["timedOut"] as? Bool, true)
    XCTAssertLessThan(Date().timeIntervalSince(started), 6)
  }

  func testWhatItLeavesInTheBackgroundStops() async throws {
    _ = try await run("sleep 4251 & echo started")
    try await Task.sleep(nanoseconds: 500_000_000)
    let left = try await sleeping("4251")
    XCTAssertFalse(left)
  }

  func testStopEndsIt() async throws {
    var holds = 0
    let started = Date()
    do {
      _ = try await Run.run(
        command: "sleep 4252", cwd: nil, env: [:], timeout: 60,
        hold: {
          holds += 1
          return holds < 2
        })
      XCTFail("a stopped command answers with an error")
    } catch let error as HelperError {
      XCTAssertEqual(error.code, "stopped")
    }
    XCTAssertLessThan(Date().timeIntervalSince(started), 4)
    let left = try await sleeping("4252")
    XCTAssertFalse(left)
  }

  func testLongOutputKeepsItsEnd() async throws {
    let r = try await run("head -c 300000 /dev/zero | tr '\\0' a; echo END")
    let output = r["output"] as? String ?? ""
    XCTAssertEqual(output.count, Run.maxOutput)
    XCTAssertTrue(output.hasSuffix("aEND\n"))
    XCTAssertEqual(r["truncated"] as? Bool, true)
  }

  func testNoDescriptorOfTheAppIsInherited() async throws {
    let held = open("/etc/hosts", O_RDONLY)
    defer { close(held) }
    let r = try await run("lsof -a -p $$ -d 0-50 -F n")
    XCTAssertFalse((r["output"] as? String ?? "").contains("/etc/hosts"))
  }

  func testCwdMustBeADirectory() async throws {
    do {
      _ = try await run("true", cwd: "/nope")
      XCTFail("expected an error")
    } catch let error as HelperError {
      XCTAssertEqual(error.code, "invalid_argument")
    }
  }
}
