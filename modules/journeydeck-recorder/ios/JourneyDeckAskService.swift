import Foundation
import JavaScriptCore
import SQLite3
import StoreKit
import UIKit

private enum AskFailure: Error { case unavailable, profileChanged, tooLarge }

/// The only native archive reader for Ask. Never creates, migrates, or writes the master.
private final class AskArchive {
  private var db: OpaquePointer?
  private let queries: [String: String]
  init() throws {
    queries = try JSONSerialization.jsonObject(with: AskArchive.resource("ask-queries", "json")) as? [String: String] ?? [:]
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("SQLite/journeydeck-local.db")
    guard FileManager.default.fileExists(atPath: url.path),
          sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
      if let db { sqlite3_close(db) }; db = nil; throw AskFailure.unavailable
    }
    sqlite3_busy_timeout(db, 1000)
    guard try rows("PRAGMA application_id", []).first?["application_id"] as? Int64 == 0x4a444c31,
          try rows("PRAGMA user_version", []).first?["user_version"] as? Int64 == 8 else { throw AskFailure.unavailable }
  }
  deinit { if let db { sqlite3_close(db) } }
  static func resource(_ name: String, _ ext: String) throws -> Data {
    let owner = Bundle(for: JourneyDeckAskService.self)
    guard let url = owner.url(forResource: "JourneyDeckAsk", withExtension: "bundle") ?? Bundle.main.url(forResource: "JourneyDeckAsk", withExtension: "bundle"),
          let resource = Bundle(url: url)?.url(forResource: name, withExtension: ext) else { throw AskFailure.unavailable }
    return try Data(contentsOf: resource)
  }
  func query(_ key: String, _ values: [String] = []) throws -> [[String: Any]] {
    guard let sql = queries[key] else { throw AskFailure.unavailable }
    return try rows(sql, values)
  }
  func transaction(_ begin: Bool) throws {
    guard sqlite3_exec(db, begin ? "BEGIN DEFERRED" : "COMMIT", nil, nil, nil) == SQLITE_OK else { throw AskFailure.unavailable }
  }
  private func rows(_ sql: String, _ values: [String]) throws -> [[String: Any]] {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw AskFailure.unavailable }
    defer { sqlite3_finalize(statement) }
    guard sqlite3_stmt_readonly(statement) != 0, sqlite3_bind_parameter_count(statement) == Int32(values.count) else { throw AskFailure.unavailable }
    for (i, value) in values.enumerated() {
      guard sqlite3_bind_text(statement, Int32(i + 1), value, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) == SQLITE_OK else { throw AskFailure.unavailable }
    }
    var result: [[String: Any]] = [], bytes = 0
    while true {
      let step = sqlite3_step(statement)
      if step == SQLITE_DONE { break }
      guard step == SQLITE_ROW else { throw AskFailure.unavailable }
      var row: [String: Any] = [:]
      for i in 0..<sqlite3_column_count(statement) {
        let key = String(cString: sqlite3_column_name(statement, i))
        switch sqlite3_column_type(statement, i) {
        case SQLITE_INTEGER: row[key] = sqlite3_column_int64(statement, i)
        case SQLITE_FLOAT: row[key] = sqlite3_column_double(statement, i)
        case SQLITE_TEXT:
          let length = Int(sqlite3_column_bytes(statement, i)); bytes += length
          guard length <= 1024, bytes <= 8_000_000, let value = sqlite3_column_text(statement, i) else { throw AskFailure.tooLarge }
          row[key] = String(cString: value)
        default: row[key] = NSNull()
        }
      }
      result.append(row)
      guard result.count <= 20000 else { throw AskFailure.tooLarge }
    }
    return result
  }
  func profile() throws -> (id: String, epoch: String) {
    guard let row = try query("profile").first, let id = row["id"] as? String,
          let epoch = row["epoch"] as? String, !epoch.isEmpty else { throw AskFailure.profileChanged }
    return (id, epoch)
  }
  func snapshot(cutoff: Date, now: Date) throws -> ([String: Any], String, String) {
    try transaction(true)
    let profile = try profile(), iso = ISO8601DateFormatter()
    let values = [profile.id, iso.string(from: cutoff), iso.string(from: now)]
    var input: [String: Any] = ["now": now.timeIntervalSince1970 * 1000, "cutoff": cutoff.timeIntervalSince1970 * 1000]
    for key in ["journeys", "memories", "music"] { input[key] = try query(key, values) }
    input["sensitiveLabels"] = try query("sensitiveLabels", [profile.id])
    try transaction(false)
    return (input, profile.id, profile.epoch)
  }
}

/// Both Expo and the app-target App Intent call this service. Tickets and follow-up
/// context are memory-only, expire in five minutes, and are invalidated on lock.
@MainActor
public final class JourneyDeckAskService: NSObject {
  public static let shared = JourneyDeckAskService()
  private struct Ticket {
    let userID: String, epoch: String, question: String
    let previous: [String: Any]?
    let context: [String: Any]?
    let expires: Date
  }
  private var tickets: [String: Ticket] = [:]
  private var lastSiriTicket: String?
  private var lockGeneration = 0
  private var observer: NSObjectProtocol?
  private let queue = DispatchQueue(label: "journeydeck.ask.readonly", qos: .userInitiated)

  private override init() {
    super.init()
    observer = NotificationCenter.default.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification,
      object: nil, queue: .main) { [weak self] _ in
        Task { @MainActor in
          guard let self else { return }
          self.lockGeneration += 1
          self.tickets.removeAll()
          self.lastSiriTicket = nil
        }
      }
  }
  private var available: Bool {
    Bundle.main.bundleIdentifier == "com.journeydeck.recorder.v3" &&
      Bundle.main.object(forInfoDictionaryKey: "JourneyDeckAskEnabled") as? Bool == true &&
      UIApplication.shared.isProtectedDataAvailable
  }
  private func failure(_ text: String) -> [String: Any] {
    ["status": "unavailable", "text": text, "evidence": [], "ticket": NSNull(), "contextToken": NSNull()]
  }
  private func cutoff(_ now: Date) async -> Date {
    // Same verified StoreKit products as JourneyDeckMembership. No editable cache,
    // preview Atlas flag, or caller-provided entitlement can unlock old history.
    for await value in StoreKit.Transaction.currentEntitlements {
      if case .verified(let transaction) = value,
         ["com.journeydeck.recorder.pro.monthly", "com.journeydeck.recorder.pro.annual"].contains(transaction.productID),
         transaction.revocationDate == nil, !transaction.isUpgraded,
         transaction.expirationDate.map({ $0 > now }) ?? true { return Date(timeIntervalSince1970: 0) }
    }
    return now.addingTimeInterval(-45 * 86400)
  }
  public func answer(question: String, expectedUserID: String? = nil, contextToken: String? = nil, siri: Bool = false) async -> [String: Any] {
    guard available else { return failure("Unlock this device and open JourneyDeck V3 before asking about your data.") }
    guard question.utf16.count <= 500 else { return failure("Please keep your question under 500 characters.") }
    let generation = lockGeneration, now = Date()
    tickets = tickets.filter { $0.value.expires > now }
    let token = contextToken ?? (siri ? lastSiriTicket : nil)
    let previousTicket = token.flatMap { tickets[$0] }
    // An unrecognized question must not leave an older Siri topic active.
    if siri { lastSiriTicket = nil }
    let boundary = await cutoff(now)
    guard available, generation == lockGeneration else { return failure("Unlock this device and ask again.") }
    do {
      let result: ([String: Any], String, String) = try await withCheckedThrowingContinuation { continuation in
        queue.async {
          do {
            let archive = try AskArchive()
            let (input, userID, epoch) = try archive.snapshot(cutoff: boundary, now: now)
            guard expectedUserID == nil || expectedUserID == userID else { throw AskFailure.profileChanged }
            let previous = previousTicket.flatMap { $0.userID == userID && $0.epoch == epoch ? $0.context : nil }
            let payload = try Self.evaluate(question, input: input, previous: previous)
            let current = try archive.profile()
            guard current.id == userID && current.epoch == epoch else { throw AskFailure.profileChanged }
            continuation.resume(returning: (payload, userID, epoch))
          } catch { continuation.resume(throwing: error) }
        }
      }
      guard available, generation == lockGeneration else { return failure("Unlock this device and ask again.") }
      // Recheck after returning to the main actor: a switch or deletion may have
      // committed while the worker's completion waited in the queue.
      let current = try AskArchive().profile()
      guard current.id == result.1 && current.epoch == result.2 else { throw AskFailure.profileChanged }
      var payload = result.0
      guard payload["status"] as? String == "answered" else { return payload }
      let key = UUID().uuidString
      let previous = previousTicket.flatMap { $0.userID == result.1 && $0.epoch == result.2 ? $0.context : nil }
      tickets[key] = Ticket(userID: result.1, epoch: result.2, question: question, previous: previous,
        context: payload["context"] as? [String: Any], expires: now.addingTimeInterval(300))
      if tickets.count > 16 { tickets = [key: tickets[key]!] }
      if siri { lastSiriTicket = key }
      payload.removeValue(forKey: "context")
      payload["ticket"] = key; payload["contextToken"] = key; payload["profileId"] = result.1
      return payload
    } catch AskFailure.profileChanged { return failure("Your active profile changed or is unavailable. Open JourneyDeck and ask again.") }
    catch AskFailure.tooLarge { return failure("This library exceeds the prototype's reading limit. Open JourneyDeck to explore it.") }
    catch { return failure("Your local archive could not be read. Open JourneyDeck, let it finish loading, and try again.") }
  }
  /// A ticket contains no question or identity in its URL. Recompute from live rows
  /// so deleted records, history changes, and profile switches cannot replay old data.
  public func resolveForSiri(ticket: String) async -> [String: Any] {
    guard let stored = tickets[ticket] else { return failure("Open Ask JourneyDeck to ask a new question.") }
    return await resolve(ticket: ticket, expectedUserID: stored.userID)
  }
  public func resolve(ticket: String, expectedUserID: String) async -> [String: Any] {
    guard available, let stored = tickets[ticket], stored.expires > Date(), stored.userID == expectedUserID else {
      return failure("This answer has expired. Ask your question again.")
    }
    do {
      let current = try AskArchive().profile()
      guard current.id == stored.userID, current.epoch == stored.epoch else { throw AskFailure.profileChanged }
      // Feed the saved prior context, not the answer's own context, to reproduce
      // follow-ups such as “What about last week?” without changing their meaning.
      let temporary = UUID().uuidString
      tickets[temporary] = Ticket(userID: stored.userID, epoch: stored.epoch, question: "", previous: nil, context: stored.previous, expires: stored.expires)
      defer { tickets.removeValue(forKey: temporary) }
      return await answer(question: stored.question, expectedUserID: expectedUserID, contextToken: temporary)
    } catch { return failure("Your active profile changed. Ask your question again.") }
  }
  nonisolated private static func evaluate(_ question: String, input: [String: Any], previous: [String: Any]?) throws -> [String: Any] {
    guard let source = String(data: try AskArchive.resource("ask-engine", "js"), encoding: .utf8), let js = JSContext() else { throw AskFailure.unavailable }
    js.evaluateScript(source)
    guard js.exception == nil, let function = js.objectForKeyedSubscript("JourneyDeckAskEngine")?.objectForKeyedSubscript("answer") else { throw AskFailure.unavailable }
    let value = function.call(withArguments: [question, input, previous as Any? ?? NSNull()])
    guard js.exception == nil, let answer = value?.toDictionary() as? [String: Any] else { throw AskFailure.unavailable }
    return answer
  }
}
