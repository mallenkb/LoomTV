import CryptoKit
import ExpoModulesCore
import Foundation
import Network
import Security

public final class LoomTvSecureTransportModule: Module {
  private let proxy = SecureLanProxy()

  public func definition() -> ModuleDefinition {
    Name("LoomTvSecureTransport")

    AsyncFunction("probeCertificate") { (origin: String) async throws -> String in
      try await CertificateProbe.probe(origin: origin)
    }

    AsyncFunction("start") { (origin: String, certFingerprint: String) async throws -> String in
      try await self.proxy.start(origin: origin, fingerprint: certFingerprint)
    }

    AsyncFunction("stop") {
      self.proxy.stop()
    }

    OnDestroy {
      self.proxy.stop()
    }
  }
}

private let maxHeaderBytes = 64 * 1024
private let maxRequestBodyBytes = 2 * 1024 * 1024
private let hopByHopHeaders: Set<String> = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "accept-encoding",
]

private enum SecureTransportError: Error {
  case invalidOrigin
  case invalidFingerprint
  case certificateChanged
  case certificateUnavailable
  case invalidRequest
  case listenerFailed
}

private func normalizedFingerprint(_ value: String) throws -> String {
  let normalized = value.lowercased().filter { $0.isHexDigit }
  guard normalized.count == 64 else { throw SecureTransportError.invalidFingerprint }
  return normalized
}

private func secureOrigin(_ value: String) throws -> URL {
  guard
    let components = URLComponents(string: value),
    components.scheme?.lowercased() == "https",
    let host = components.host,
    !host.isEmpty,
    components.user == nil,
    components.password == nil,
    components.query == nil,
    components.fragment == nil,
    components.path.isEmpty || components.path == "/",
    let origin = URL(string: "https://\(host.contains(":") ? "[\(host)]" : host)\(components.port.map { ":\($0)" } ?? "")")
  else { throw SecureTransportError.invalidOrigin }
  return origin
}

private func fingerprint(of certificate: SecCertificate) -> String {
  let digest = SHA256.hash(data: SecCertificateCopyData(certificate) as Data)
  return digest.map { String(format: "%02x", $0) }.joined()
}

private func evaluatePinnedTrust(_ trust: SecTrust, expectedFingerprint: String?) -> Bool {
  guard let certificate = SecTrustGetCertificateAtIndex(trust, 0) else { return false }
  if let expectedFingerprint, fingerprint(of: certificate) != expectedFingerprint { return false }
  SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, nil))
  SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
  SecTrustSetAnchorCertificatesOnly(trust, true)
  return SecTrustEvaluateWithError(trust, nil)
}

private final class CertificateProbeDelegate: NSObject, URLSessionDelegate {
  private(set) var certFingerprint: String?

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard
      challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust,
      let certificate = SecTrustGetCertificateAtIndex(trust, 0),
      evaluatePinnedTrust(trust, expectedFingerprint: nil)
    else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    certFingerprint = fingerprint(of: certificate)
    completionHandler(.useCredential, URLCredential(trust: trust))
  }
}

private enum CertificateProbe {
  static func probe(origin: String) async throws -> String {
    let remote = try secureOrigin(origin)
    let delegate = CertificateProbeDelegate()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 10
    configuration.timeoutIntervalForResource = 10
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var components = URLComponents(url: remote, resolvingAgainstBaseURL: false)
    components?.path = "/api/ping"
    guard let url = components?.url else { throw SecureTransportError.invalidOrigin }
    _ = try await session.data(from: url)
    guard let certFingerprint = delegate.certFingerprint else { throw SecureTransportError.certificateUnavailable }
    return certFingerprint
  }
}

private struct ProxyRequest {
  let method: String
  let target: String
  let headers: [(String, String)]
  let body: Data
}

private final class SecureLanProxy {
  private let queue = DispatchQueue(label: "app.loomtv.secure-transport.listener", qos: .userInitiated)
  private let stateLock = NSLock()
  private var listener: NWListener?
  private var remoteOrigin: URL?
  private var certFingerprint: String?
  private var localSecret: String?
  private var proxySessions: ProxySessionPool?
  private static let maxLocalConnections = 32
  private static let requestReceiveTimeoutSeconds: TimeInterval = 10
  private final class LocalConnection {
    let id = UUID()
    let connection: NWConnection
    var parsing = true
    init(_ connection: NWConnection) { self.connection = connection }
  }
  private var localConnections: [LocalConnection] = []

  func start(origin: String, fingerprint: String) async throws -> String {
    let remote = try secureOrigin(origin)
    let normalized = try normalizedFingerprint(fingerprint)
    stateLock.lock()
    if let listener, case .ready = listener.state, let port = listener.port,
      let localSecret, remoteOrigin == remote, certFingerprint == normalized {
      stateLock.unlock()
      return "http://localhost:\(port.rawValue)/\(localSecret)"
    }
    stateLock.unlock()

    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let nextListener = try NWListener(using: parameters, on: .any)
    let nextSecret = UUID().uuidString.replacingOccurrences(of: "-", with: "")
    let nextSessions = ProxySessionPool(expectedFingerprint: normalized)
    nextListener.newConnectionHandler = { [weak self, weak nextListener] connection in
      guard let self, let nextListener, self.admit(connection, listener: nextListener) else { connection.cancel(); return }
      self.receiveRequest(from: connection, listener: nextListener, accumulated: Data())
      connection.start(queue: self.queue)
    }

    return try await withCheckedThrowingContinuation { continuation in
      let completionLock = NSLock()
      var completed = false
      nextListener.stateUpdateHandler = { [weak self, weak nextListener] state in
        completionLock.lock()
        defer { completionLock.unlock() }
        guard let self, let nextListener else {
          if !completed {
            completed = true
            continuation.resume(throwing: SecureTransportError.listenerFailed)
          }
          return
        }
        self.stateLock.lock()
        let current = self.listener === nextListener
        self.stateLock.unlock()
        // A concurrent start may supersede readiness still pending. Its older
        // callback must neither return the new secret nor stop the new listener.
        guard current else {
          if !completed {
            completed = true
            continuation.resume(throwing: SecureTransportError.listenerFailed)
          }
          return
        }
        switch state {
        case .ready:
          guard !completed else { return }
          guard let port = nextListener.port else {
            completed = true
            self.stop(expectedListener: nextListener)
            continuation.resume(throwing: SecureTransportError.listenerFailed)
            return
          }
          completed = true
          continuation.resume(returning: "http://localhost:\(port.rawValue)/\(nextSecret)")
        case .failed(let error):
          self.stop(expectedListener: nextListener)
          if !completed {
            completed = true
            continuation.resume(throwing: error)
          }
        case .cancelled:
          self.stop(expectedListener: nextListener)
          if !completed {
            completed = true
            continuation.resume(throwing: SecureTransportError.listenerFailed)
          }
        default:
          break
        }
      }
      // Publish and start one generation atomically. A competing start/stop
      // cannot cancel a listener before its state handler and queue are installed.
      stateLock.lock()
      let previousListener = listener
      let previousSessions = proxySessions
      let previousConnections = localConnections
      localConnections.removeAll()
      listener = nextListener
      remoteOrigin = remote
      certFingerprint = normalized
      localSecret = nextSecret
      proxySessions = nextSessions
      nextListener.start(queue: queue)
      stateLock.unlock()
      previousListener?.cancel()
      previousSessions?.stop()
      for entry in previousConnections { entry.connection.cancel() }
    }
  }

  func stop() { stop(expectedListener: nil) }

  private func stop(expectedListener: NWListener?) {
    stateLock.lock()
    if let expectedListener, listener !== expectedListener { stateLock.unlock(); return }
    let current = listener
    let currentSessions = proxySessions
    let currentConnections = localConnections
    localConnections.removeAll()
    listener = nil
    remoteOrigin = nil
    certFingerprint = nil
    localSecret = nil
    proxySessions = nil
    stateLock.unlock()
    current?.cancel()
    currentSessions?.stop()
    for entry in currentConnections { entry.connection.cancel() }
  }

  private func admit(_ connection: NWConnection, listener expected: NWListener) -> Bool {
    stateLock.lock()
    guard listener === expected else { stateLock.unlock(); return false }
    localConnections.removeAll { entry in
      switch entry.connection.state {
      case .failed, .cancelled: return true
      default: return false
      }
    }
    guard localConnections.count < Self.maxLocalConnections else { stateLock.unlock(); return false }
    let entry = LocalConnection(connection)
    localConnections.append(entry)
    stateLock.unlock()
    // The deadline covers only request parsing, not playback or queued work.
    queue.asyncAfter(deadline: .now() + Self.requestReceiveTimeoutSeconds) { [weak self, weak entry] in
      guard let self, let entry else { return }
      self.stateLock.lock()
      let index = self.localConnections.firstIndex(where: { $0 === entry })
      if entry.parsing, let index {
        self.localConnections.remove(at: index)
        self.stateLock.unlock()
        entry.connection.cancel()
      } else { self.stateLock.unlock() }
    }
    return true
  }

  private func parsed(_ connection: NWConnection) {
    stateLock.lock()
    localConnections.first(where: { $0.connection === connection })?.parsing = false
    stateLock.unlock()
  }

  private func receiveRequest(from connection: NWConnection, listener expectedListener: NWListener, accumulated: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
      guard let self else { connection.cancel(); return }
      guard error == nil else { connection.cancel(); return }
      var next = accumulated
      if let data { next.append(data) }
      if next.count > maxHeaderBytes + maxRequestBodyBytes {
        self.writeError(to: connection, status: 413, message: "Local request is too large.")
        return
      }
      do {
        if let request = try self.parseRequest(next) {
          self.parsed(connection)
          self.forward(request, from: connection, listener: expectedListener, requestReadComplete: isComplete)
          return
        }
      } catch {
        self.writeError(to: connection, status: 400, message: "Invalid local request.")
        return
      }
      if isComplete {
        connection.cancel()
        return
      }
      self.receiveRequest(from: connection, listener: expectedListener, accumulated: next)
    }
  }

  private func parseRequest(_ data: Data) throws -> ProxyRequest? {
    let delimiter = Data("\r\n\r\n".utf8)
    guard let headerRange = data.range(of: delimiter) else {
      if data.count >= maxHeaderBytes { throw SecureTransportError.invalidRequest }
      return nil
    }
    guard let headerText = String(data: data[..<headerRange.lowerBound], encoding: .isoLatin1) else {
      throw SecureTransportError.invalidRequest
    }
    let lines = headerText.components(separatedBy: "\r\n")
    let requestParts = lines.first?.split(separator: " ", maxSplits: 2).map(String.init) ?? []
    guard
      requestParts.count == 3,
      requestParts[2].hasPrefix("HTTP/1."),
      ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].contains(requestParts[0].uppercased()),
      requestParts[1].hasPrefix("/"),
      !requestParts[1].hasPrefix("//")
    else { throw SecureTransportError.invalidRequest }
    let headers = try lines.dropFirst().map { line -> (String, String) in
      guard let separator = line.firstIndex(of: ":") else { throw SecureTransportError.invalidRequest }
      return (
        String(line[..<separator]).trimmingCharacters(in: .whitespaces),
        String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
      )
    }
    let contentLength = headers.first { $0.0.caseInsensitiveCompare("Content-Length") == .orderedSame }
      .flatMap { Int($0.1) } ?? 0
    guard contentLength >= 0 && contentLength <= maxRequestBodyBytes else { throw SecureTransportError.invalidRequest }
    let bodyStart = headerRange.upperBound
    guard data.count >= bodyStart + contentLength else { return nil }
    return ProxyRequest(
      method: requestParts[0].uppercased(),
      target: requestParts[1],
      headers: headers,
      body: data.subdata(in: bodyStart..<(bodyStart + contentLength))
    )
  }

  private func forward(_ request: ProxyRequest, from connection: NWConnection, listener expectedListener: NWListener, requestReadComplete: Bool) {
    stateLock.lock()
    let currentListener = listener
    let remote = remoteOrigin
    let sessions = proxySessions
    let secret = localSecret
    stateLock.unlock()
    guard currentListener === expectedListener, let remote, let sessions, let secret else {
      writeError(to: connection, status: 503, message: "Secure transport is restarting.")
      return
    }
    let prefix = "/\(secret)"
    guard request.target == prefix || request.target.hasPrefix(prefix + "/") || request.target.hasPrefix(prefix + "?") else {
      writeError(to: connection, status: 403, message: "The local transport session is invalid.")
      return
    }
    let strippedTarget = String(request.target.dropFirst(prefix.count))
    let forwardedTarget = strippedTarget.isEmpty ? "/" : strippedTarget
    guard let url = URL(string: forwardedTarget, relativeTo: remote)?.absoluteURL else {
      writeError(to: connection, status: 400, message: "Invalid local request target.")
      return
    }
    var remoteRequest = URLRequest(url: url)
    remoteRequest.httpMethod = request.method
    for (name, value) in request.headers where !hopByHopHeaders.contains(name.lowercased()) && name.caseInsensitiveCompare("Content-Length") != .orderedSame {
      remoteRequest.addValue(value, forHTTPHeaderField: name)
    }
    remoteRequest.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    if !request.body.isEmpty { remoteRequest.httpBody = request.body }

    if !sessions.start(remoteRequest, connection: connection, requestReadComplete: requestReadComplete) {
      writeError(to: connection, status: 503, message: "The secure transport is busy. Please retry.")
    }
  }

  private func writeError(to connection: NWConnection, status: Int, message: String) {
    let body = Data(message.utf8)
    let headers = Data((
      "HTTP/1.1 \(status) Secure Transport Error\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
    ).utf8)
    connection.send(content: headers + body, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
      connection.cancel()
    })
  }
}

private final class ProxyResponseSink {
  private let connection: NWConnection
  private weak var task: URLSessionDataTask?
  private let lock = NSCondition()
  private let onClose: () -> Void
  private var buffer = LoomTvResponseBuffer()
  private var suspended = false
  private var closed = false
  private var wroteHeaders = false
  private var released = false

  init(task: URLSessionDataTask, connection: NWConnection, onClose: @escaping () -> Void) {
    self.onClose = onClose
    self.task = task
    self.connection = connection
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled: self?.cancel()
      default: break
      }
    }
  }

  func cancel() {
    lock.lock()
    guard !released && !buffer.cancelled else { lock.unlock(); return }
    closed = true
    buffer.cancel()
    lock.broadcast()
    let currentTask = task
    lock.unlock()
    currentTask?.cancel()
    connection.cancel()
    release()
  }

  private func release() {
    lock.lock()
    guard !released else { lock.unlock(); return }
    released = true
    lock.unlock()
    onClose()
  }

  func receive(response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let response = response as? HTTPURLResponse else {
      completionHandler(.cancel)
      cancel()
      return
    }
    var value = "HTTP/1.1 \(response.statusCode) Response\r\n"
    for (nameValue, headerValue) in response.allHeaderFields {
      let name = String(describing: nameValue)
      if !hopByHopHeaders.contains(name.lowercased()) {
        value += "\(name): \(headerValue)\r\n"
      }
    }
    value += "Connection: close\r\n\r\n"
    lock.lock()
    guard !closed else { lock.unlock(); completionHandler(.cancel); return }
    wroteHeaders = true
    lock.unlock()
    connection.send(content: Data(value.utf8), completion: .contentProcessed { error in
      self.lock.lock()
      let allowed = error == nil && !self.closed
      self.lock.unlock()
      completionHandler(allowed ? .allow : .cancel)
      if !allowed { self.cancel() }
    })
  }

  func receive(data: Data) {
    // URLSession can coalesce several MiB into one callback after resuming.
    // Only this transfer's serial delegate waits; other session lanes stay free.
    // The framework owns the callback Data until this method returns. Our queue
    // holds at most the high-water budget, including its outstanding socket send.
    var offset = 0
    while offset < data.count {
      lock.lock()
      while !closed && buffer.shouldSuspend {
        _ = lock.wait(until: Date(timeIntervalSinceNow: 0.1))
        // External task cancellation can precede its queued delegate callback.
        if task?.state == .canceling || task?.error != nil {
          lock.unlock()
          cancel()
          return
        }
      }
      guard !closed else { lock.unlock(); return }
      let end = min(data.count, offset + 64 * 1024)
      let chunk = data.subdata(in: offset..<end)
      guard buffer.enqueue(chunk) else { lock.unlock(); cancel(); return }
      if !suspended && buffer.shouldSuspend {
        suspended = true
        task?.suspend()
      }
      let next = buffer.nextChunk()
      lock.unlock()
      if let next { send(next) }
      offset = end
    }
  }

  private func send(_ data: Data) {
    // Exactly one body send can be awaiting its completion. That completion,
    // rather than the URLSession producer, advances the response queue.
    connection.send(content: data, completion: .contentProcessed { error in
      if error != nil { self.cancel(); return }
      self.lock.lock()
      guard !self.closed else { self.lock.unlock(); return }
      self.buffer.didSend(byteCount: data.count)
      self.lock.broadcast()
      if self.suspended && self.buffer.shouldResume && !self.buffer.upstreamFinished {
        self.suspended = false
        self.task?.resume()
      }
      let next = self.buffer.nextChunk()
      let finish = self.buffer.canFinish
      if finish { self.closed = true }
      self.lock.unlock()
      if let next { self.send(next) }
      else if finish { self.finishConnection() }
    })
  }

  private func finishConnection() {
    connection.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
      self.connection.cancel()
      self.release()
    })
  }

  func complete(error: Error?) {
    lock.lock()
    guard !closed else { lock.unlock(); return }
    if error != nil && !wroteHeaders {
      closed = true
      lock.unlock()
      let body = Data("The secure desktop connection failed.".utf8)
      let headers = Data((
        "HTTP/1.1 502 Secure Transport Error\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
      ).utf8)
      connection.send(content: headers + body, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
        self.connection.cancel()
        self.release()
      })
    } else if error != nil {
      lock.unlock()
      cancel()
    } else {
      buffer.finishUpstream()
      let finish = buffer.canFinish
      if finish { closed = true }
      lock.unlock()
      // Completion can arrive with body chunks still queued locally.
      if finish { finishConnection() }
    }
  }
}

private final class PinnedProxySessionDelegate: NSObject, URLSessionDataDelegate {
  private let expectedFingerprint: String
  private let sinkLock = NSLock()
  private var sinks: [Int: ProxyResponseSink] = [:]

  init(expectedFingerprint: String) {
    self.expectedFingerprint = expectedFingerprint
  }

  func register(task: URLSessionDataTask, connection: NWConnection, onClose: @escaping () -> Void) {
    sinkLock.lock()
    let identifier = task.taskIdentifier
    sinks[identifier] = ProxyResponseSink(task: task, connection: connection) { [weak self] in
      if let self {
        self.sinkLock.lock()
        self.sinks.removeValue(forKey: identifier)
        self.sinkLock.unlock()
      }
      onClose()
    }
    sinkLock.unlock()
  }

  func cancelAll() {
    sinkLock.lock()
    let active = Array(sinks.values)
    sinkLock.unlock()
    for sink in active { sink.cancel() }
  }

  private func sink(for task: URLSessionTask) -> ProxyResponseSink? {
    sinkLock.lock()
    defer { sinkLock.unlock() }
    return sinks[task.taskIdentifier]
  }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard
      challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust,
      evaluatePinnedTrust(trust, expectedFingerprint: expectedFingerprint)
    else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let sink = sink(for: dataTask) else { completionHandler(.cancel); return }
    sink.receive(response: response, completionHandler: completionHandler)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    sink(for: dataTask)?.receive(data: data)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    // Keep the sink registered until downstream EOF/cancel, even when the
    // upstream task completed earlier. Stop must still find draining sinks.
    sink(for: task)?.complete(error: error)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

// Six reusable lanes retain the previous connection limit without letting a slow
// consumer block every URLSession delegate callback. A bounded FIFO absorbs
// normal bursts; admission stays held until downstream drain or cancel.
private final class ProxySessionPool {
  static let capacity = 6
  static let maxPendingRequests = 12
  static let maxPendingBodyBytes = 4 * 1024 * 1024
  static let pendingTimeoutSeconds: TimeInterval = 60

  private final class Lane {
    let delegate: PinnedProxySessionDelegate
    let session: URLSession
    var lease: UUID?

    init(expectedFingerprint: String) {
      delegate = PinnedProxySessionDelegate(expectedFingerprint: expectedFingerprint)
      let configuration = URLSessionConfiguration.ephemeral
      configuration.timeoutIntervalForRequest = 60
      configuration.timeoutIntervalForResource = 24 * 60 * 60
      configuration.httpMaximumConnectionsPerHost = 1
      let queue = OperationQueue()
      queue.maxConcurrentOperationCount = 1
      session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
    }
  }

  private final class Pending {
    let request: URLRequest
    let connection: NWConnection
    let bodyBytes: Int
    let deadline: DispatchTime

    init(request: URLRequest, connection: NWConnection, deadline: DispatchTime = .now() + ProxySessionPool.pendingTimeoutSeconds) {
      self.deadline = deadline
      self.request = request
      self.connection = connection
      bodyBytes = request.httpBody?.count ?? 0
    }
  }

  private let lock = NSLock()
  private let lanes: [Lane]
  private var pending: [Pending] = []
  private var pendingBodyBytes = 0
  private var stopped = false

  init(expectedFingerprint: String) {
    lanes = (0..<Self.capacity).map { _ in Lane(expectedFingerprint: expectedFingerprint) }
  }

  func start(_ request: URLRequest, connection: NWConnection, requestReadComplete: Bool) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !stopped else { return false }
    // Detect a reset before response writes begin, unless parsing already
    // consumed request-side EOF. Scheduling another receive past that terminal
    // event can report an error even though a valid half-close still allows writes.
    if !requestReadComplete {
      connection.receive(minimumIncompleteLength: 1, maximumLength: 1) { [weak connection] data, _, _, error in
        if error != nil || data?.isEmpty == false { connection?.cancel() }
      }
    }
    if let lane = lanes.first(where: { $0.lease == nil }) {
      begin(request, connection: connection, lane: lane)
      return true
    }
    let entry = Pending(request: request, connection: connection)
    guard pending.count < Self.maxPendingRequests,
      entry.bodyBytes <= Self.maxPendingBodyBytes - pendingBodyBytes else { return false }
    pending.append(entry)
    pendingBodyBytes += entry.bodyBytes
    DispatchQueue.global().asyncAfter(deadline: entry.deadline) { [weak self, weak entry] in
      if let entry, self?.remove(entry) == true { entry.connection.cancel() }
    }
    connection.stateUpdateHandler = { [weak self, weak entry] state in
      switch state {
      case .failed, .cancelled:
        if let entry { _ = self?.remove(entry) }
      default: break
      }
    }
    return true
  }

  // The pool lock covers admission and registration, including stop races.
  private func begin(_ request: URLRequest, connection: NWConnection, lane: Lane) {
    let lease = UUID()
    lane.lease = lease
    let task = lane.session.dataTask(with: request)
    lane.delegate.register(task: task, connection: connection) { [weak self, weak lane] in
      if let lane { self?.release(lane, lease: lease) }
    }
    task.resume()
  }

  private func release(_ lane: Lane, lease: UUID) {
    var expired: [NWConnection] = []
    lock.lock()
    defer {
      lock.unlock()
      for connection in expired { connection.cancel() }
    }
    guard lane.lease == lease else { return }
    lane.lease = nil
    while !stopped && !pending.isEmpty {
      let entry = pending.removeFirst()
      pendingBodyBytes -= entry.bodyBytes
      // The timer may run late under load. Never forward an expired request.
      if DispatchTime.now() >= entry.deadline {
        expired.append(entry.connection)
        continue
      }
      switch entry.connection.state {
      case .failed, .cancelled: continue
      default:
        begin(entry.request, connection: entry.connection, lane: lane)
        return
      }
    }
  }

  @discardableResult
  private func remove(_ entry: Pending) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard let index = pending.firstIndex(where: { $0 === entry }) else { return false }
    pending.remove(at: index)
    pendingBodyBytes -= entry.bodyBytes
    return true
  }

  func stop() {
    lock.lock()
    guard !stopped else { lock.unlock(); return }
    stopped = true
    let waiting = pending
    pending.removeAll()
    pendingBodyBytes = 0
    lock.unlock()
    for entry in waiting {
      entry.connection.stateUpdateHandler = nil
      entry.connection.cancel()
    }
    for lane in lanes {
      // Wake a blocked body callback before invalidation queues task completion.
      lane.delegate.cancelAll()
      lane.session.invalidateAndCancel()
    }
  }
}
