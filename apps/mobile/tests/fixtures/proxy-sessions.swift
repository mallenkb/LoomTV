// Appended to the unchanged native implementation after removing only the Expo
// module wrapper, so the fixture exercises its actual pool, delegates and sink.
// A deterministic native lifecycle fixture holds one send in flight, then
// delivers the production delegate's completion callback. Real socket buffering
// otherwise makes the final-drain window too brief to assert reliably.
private extension ProxyResponseSink {
  func fixtureStageOutstandingSend() -> URLSessionDataTask? {
    lock.lock()
    defer { lock.unlock() }
    guard buffer.enqueue(Data(repeating: 0x5a, count: LoomTvResponseBuffer.highWaterBytes)) else { return nil }
    _ = buffer.nextChunk()
    return task
  }
}

private extension PinnedProxySessionDelegate {
  func fixtureCompleteWhileDraining(_ session: URLSession) -> Bool {
    sinkLock.lock()
    let current = sinks.values.first
    sinkLock.unlock()
    guard let task = current?.fixtureStageOutstandingSend() else { return false }
    urlSession(session, task: task, didCompleteWithError: nil)
    sinkLock.lock()
    defer { sinkLock.unlock() }
    return sinks[task.taskIdentifier] != nil
  }
}

private extension ProxySessionPool {
  func fixtureExpireOldest() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard let entry = pending.first else { return false }
    // Replace only the fixture's timestamp. The promotion path must reject it
    // even when its asynchronous expiry callback has not executed.
    pending[0] = Pending(request: entry.request, connection: entry.connection, deadline: .now())
    return true
  }

  func fixtureCompleteWhileDraining() -> Bool {
    lock.lock()
    let lane = lanes.first(where: { $0.lease != nil })
    lock.unlock()
    guard let lane else { return false }
    return lane.delegate.fixtureCompleteWhileDraining(lane.session)
  }
}

private extension SecureLanProxy {
  func fixtureHoldListenerQueue() -> DispatchSemaphore {
    let gate = DispatchSemaphore(value: 0)
    let entered = DispatchSemaphore(value: 0)
    queue.async { entered.signal(); gate.wait() }
    entered.wait()
    return gate
  }

  func fixtureLocalConnectionCount() -> Int {
    stateLock.lock()
    defer { stateLock.unlock() }
    return localConnections.count
  }

  func fixtureListener() -> NWListener? {
    stateLock.lock()
    defer { stateLock.unlock() }
    return listener
  }
}

private func fixtureListenerReplacement() async -> Bool {
  let proxy = SecureLanProxy()
  defer { proxy.stop() }
  let pin = String(repeating: "0", count: 64)
  let gate = proxy.fixtureHoldListenerQueue()
  let older = Task { try await proxy.start(origin: "https://127.0.0.1:9", fingerprint: pin) }
  var obsolete: NWListener?
  for _ in 0..<2_000 {
    obsolete = proxy.fixtureListener()
    if obsolete != nil { break }
    try? await Task.sleep(nanoseconds: 1_000_000)
  }
  guard let obsolete else { gate.signal(); return false }
  let newer = Task { try await proxy.start(origin: "https://127.0.0.1:10", fingerprint: pin) }
  var replaced = false
  for _ in 0..<2_000 {
    if let listener = proxy.fixtureListener(), listener !== obsolete { replaced = true; break }
    try? await Task.sleep(nanoseconds: 1_000_000)
  }
  guard replaced else { gate.signal(); return false }
  // Deliver a stale failure while both real listener readiness callbacks wait.
  // It must fail only the obsolete start, without stopping its replacement.
  obsolete.stateUpdateHandler?(.failed(.posix(.ECONNRESET)))
  gate.signal()
  guard case .failure = await older.result else { return false }
  do {
    let current = try await newer.value
    let reused = try await proxy.start(origin: "https://127.0.0.1:10", fingerprint: pin)
    guard current == reused else { return false }
    let (_, response) = try await URLSession.shared.data(from: URL(string: current + "/api/ping")!)
    // The remote closed port intentionally fails. A 502 proves the replacement
    // listener, secret and session pool are still alive and accepted the request.
    guard (response as? HTTPURLResponse)?.statusCode == 502 else { return false }
    proxy.fixtureListener()?.stateUpdateHandler?(.failed(.posix(.ECONNRESET)))
    guard proxy.fixtureListener() == nil else { return false }
    await withTaskGroup(of: Void.self) { group in
      for index in 0..<12 {
        group.addTask {
          if index % 3 == 0 { proxy.stop() }
          _ = try? await proxy.start(origin: "https://127.0.0.1:\(9 + index % 2)", fingerprint: pin)
        }
      }
    }
    proxy.stop()
    let final = try await proxy.start(origin: "https://127.0.0.1:9", fingerprint: pin)
    let (_, finalResponse) = try await URLSession.shared.data(from: URL(string: final + "/api/ping")!)
    return (finalResponse as? HTTPURLResponse)?.statusCode == 502
  } catch { return false }
}

private final class ProxyFixture {
  let pool = ProxySessionPool(expectedFingerprint: String(repeating: "0", count: 64))
  let upstream: URL
  let localProxy = SecureLanProxy()
  let listener: NWListener

  init(upstream: URL) throws {
    self.upstream = upstream
    listener = try NWListener(using: .tcp, on: .any)
    listener.newConnectionHandler = { [weak self] connection in
      guard let self else { return }
      connection.start(queue: DispatchQueue(label: "fixture-consumer"))
      self.read(connection, accumulated: Data())
    }
    listener.stateUpdateHandler = { [weak self] state in
      if case .ready = state, let port = self?.listener.port {
        print("PORT \(port.rawValue)")
        fflush(stdout)
      }
    }
    listener.start(queue: DispatchQueue(label: "fixture-listener"))
  }

  private func reply(_ connection: NWConnection, status: Int, body: String) {
    let bytes = Data(body.utf8)
    let header = "HTTP/1.1 \(status) Fixture\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
    connection.send(content: Data(header.utf8) + bytes, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
  }

  private func read(_ connection: NWConnection, accumulated: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, complete, error in
      guard let self else { return }
      var bytes = accumulated
      if let data { bytes.append(data) }
      guard let text = String(data: bytes, encoding: .utf8), text.contains("\r\n\r\n") else {
        if complete || error != nil { connection.cancel() }
        else { self.read(connection, accumulated: bytes) }
        return
      }
      let path = text.components(separatedBy: " ")[1]
      if path == "/local-start" {
        Task {
          do {
            let url = try await self.localProxy.start(origin: "https://127.0.0.1:9", fingerprint: String(repeating: "0", count: 64))
            self.reply(connection, status: 200, body: url)
          } catch { self.reply(connection, status: 500, body: "start failed") }
        }
        return
      }
      if path == "/local-count" {
        self.reply(connection, status: 200, body: String(self.localProxy.fixtureLocalConnectionCount()))
        return
      }
      if path == "/local-stop" {
        self.localProxy.stop()
        self.reply(connection, status: 200, body: "stopped")
        return
      }
      if path == "/start-race" {
        Task {
          let passed = await fixtureListenerReplacement()
          self.reply(connection, status: passed ? 200 : 500, body: "listener race")
        }
        return
      }
      if path == "/expire-queued" {
        self.reply(connection, status: self.pool.fixtureExpireOldest() ? 200 : 500, body: "expired")
        return
      }
      if path == "/stage-final-drain" {
        self.reply(connection, status: self.pool.fixtureCompleteWhileDraining() ? 200 : 500, body: "staged")
        return
      }
      if path == "/stop" {
        self.pool.stop()
        self.reply(connection, status: 200, body: "stopped")
        return
      }
      if path == "/oversized" {
        self.oversized(connection)
        return
      }
      var request = URLRequest(url: URL(string: path, relativeTo: self.upstream)!)
      if let line = text.components(separatedBy: "\r\n").first(where: { $0.lowercased().hasPrefix("x-fixture-body-bytes:") }),
        let count = Int(line.components(separatedBy: ":")[1].trimmingCharacters(in: .whitespaces)), count > 0 {
        request.httpBody = Data(repeating: 0, count: count)
      }
      if self.pool.start(request, connection: connection) {
        print("ADMITTED \(path)")
        fflush(stdout)
      } else {
        self.reply(connection, status: 503, body: "busy")
      }
    }
  }

  private func oversized(_ connection: NWConnection) {
    let task = URLSession.shared.dataTask(with: URL(string: "/hold/manual", relativeTo: upstream)!)
    task.resume()
    let sink = ProxyResponseSink(task: task, connection: connection) { task.cancel() }
    let count = 16 * 1024 * 1024
    let response = HTTPURLResponse(url: upstream, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": String(count)])!
    sink.receive(response: response) { disposition in
      guard disposition == .allow else { return }
      DispatchQueue.global().async {
        // One deterministic 16 MiB callback exceeds the old hard cap by 16x.
        sink.receive(data: Data(repeating: 0x5a, count: count))
        sink.complete(error: nil)
      }
    }
  }
}
private let fixture = try ProxyFixture(upstream: URL(string: CommandLine.arguments[1])!)
RunLoop.main.run(until: Date(timeIntervalSinceNow: 110))
fixture.pool.stop()
fixture.localProxy.stop()
