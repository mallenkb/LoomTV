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
  private var proxySession: URLSession?
  private var proxySessionDelegate: PinnedProxySessionDelegate?

  func start(origin: String, fingerprint: String) async throws -> String {
    let remote = try secureOrigin(origin)
    let normalized = try normalizedFingerprint(fingerprint)
    stateLock.lock()
    if let listener, let port = listener.port, let localSecret, remoteOrigin == remote, certFingerprint == normalized {
      stateLock.unlock()
      return "http://localhost:\(port.rawValue)/\(localSecret)"
    }
    stateLock.unlock()
    stop()

    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let nextListener = try NWListener(using: parameters, on: .any)
    let nextSecret = UUID().uuidString.replacingOccurrences(of: "-", with: "")
    let nextSessionDelegate = PinnedProxySessionDelegate(expectedFingerprint: normalized)
    let sessionConfiguration = URLSessionConfiguration.ephemeral
    sessionConfiguration.timeoutIntervalForRequest = 60
    sessionConfiguration.timeoutIntervalForResource = 24 * 60 * 60
    sessionConfiguration.httpMaximumConnectionsPerHost = 6
    sessionConfiguration.httpShouldUsePipelining = true
    let sessionDelegateQueue = OperationQueue()
    sessionDelegateQueue.maxConcurrentOperationCount = 1
    let nextSession = URLSession(
      configuration: sessionConfiguration,
      delegate: nextSessionDelegate,
      delegateQueue: sessionDelegateQueue
    )
    stateLock.lock()
    listener = nextListener
    remoteOrigin = remote
    certFingerprint = normalized
    localSecret = nextSecret
    proxySession = nextSession
    proxySessionDelegate = nextSessionDelegate
    stateLock.unlock()
    nextListener.newConnectionHandler = { [weak self, weak nextListener] connection in
      guard let self, let nextListener else { connection.cancel(); return }
      self.receiveRequest(from: connection, listener: nextListener, accumulated: Data())
      connection.start(queue: self.queue)
    }

    return try await withCheckedThrowingContinuation { continuation in
      let completionLock = NSLock()
      var completed = false
      nextListener.stateUpdateHandler = { [weak self, weak nextListener] state in
        completionLock.lock()
        defer { completionLock.unlock() }
        guard !completed, let nextListener else { return }
        switch state {
        case .ready:
          guard let port = nextListener.port else {
            completed = true
            continuation.resume(throwing: SecureTransportError.listenerFailed)
            return
          }
          completed = true
          continuation.resume(returning: "http://localhost:\(port.rawValue)/\(nextSecret)")
        case .failed(let error):
          completed = true
          self?.stop()
          continuation.resume(throwing: error)
        case .cancelled:
          completed = true
          continuation.resume(throwing: SecureTransportError.listenerFailed)
        default:
          break
        }
      }
      nextListener.start(queue: queue)
    }
  }

  func stop() {
    stateLock.lock()
    let current = listener
    let currentSession = proxySession
    listener = nil
    remoteOrigin = nil
    certFingerprint = nil
    localSecret = nil
    proxySession = nil
    proxySessionDelegate = nil
    stateLock.unlock()
    current?.cancel()
    currentSession?.invalidateAndCancel()
  }

  private func receiveRequest(from connection: NWConnection, listener expectedListener: NWListener, accumulated: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
      guard let self else { connection.cancel(); return }
      var next = accumulated
      if let data { next.append(data) }
      if next.count > maxHeaderBytes + maxRequestBodyBytes {
        self.writeError(to: connection, status: 413, message: "Local request is too large.")
        return
      }
      do {
        if let request = try self.parseRequest(next) {
          self.forward(request, from: connection, listener: expectedListener)
          return
        }
      } catch {
        self.writeError(to: connection, status: 400, message: "Invalid local request.")
        return
      }
      if isComplete || error != nil {
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

  private func forward(_ request: ProxyRequest, from connection: NWConnection, listener expectedListener: NWListener) {
    stateLock.lock()
    let currentListener = listener
    let remote = remoteOrigin
    let session = proxySession
    let sessionDelegate = proxySessionDelegate
    let secret = localSecret
    stateLock.unlock()
    guard currentListener === expectedListener, let remote, let session, let sessionDelegate, let secret else {
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

    let task = session.dataTask(with: remoteRequest)
    sessionDelegate.register(task: task, connection: connection)
    task.resume()
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
  private var wroteHeaders = false

  init(connection: NWConnection) {
    self.connection = connection
  }

  func receive(response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let response = response as? HTTPURLResponse else {
      completionHandler(.cancel)
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
    wroteHeaders = true
    connection.send(content: Data(value.utf8), completion: .contentProcessed { error in
      completionHandler(error == nil ? .allow : .cancel)
    })
  }

  func receive(data: Data) {
    connection.send(content: data, completion: .contentProcessed { _ in })
  }

  func complete(error: Error?) {
    if error != nil && !wroteHeaders {
      let body = Data("The secure desktop connection failed.".utf8)
      let headers = Data((
        "HTTP/1.1 502 Secure Transport Error\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
      ).utf8)
      connection.send(content: headers + body, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
        self.connection.cancel()
      })
    } else {
      connection.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
        self.connection.cancel()
      })
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

  func register(task: URLSessionDataTask, connection: NWConnection) {
    sinkLock.lock()
    sinks[task.taskIdentifier] = ProxyResponseSink(connection: connection)
    sinkLock.unlock()
  }

  private func sink(for task: URLSessionTask, remove: Bool = false) -> ProxyResponseSink? {
    sinkLock.lock()
    defer { sinkLock.unlock() }
    if remove { return sinks.removeValue(forKey: task.taskIdentifier) }
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
    sink(for: task, remove: true)?.complete(error: error)
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
