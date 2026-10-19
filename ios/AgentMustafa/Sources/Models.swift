import Foundation
import SwiftUI

// Plain value types for what the agent sends. The wire format is JSON (see src/core/event-types.ts);
// AgentClient reads it with JSONSerialization so a new field on the server never breaks decoding.

typealias JSON = [String: Any]

extension Dictionary where Key == String, Value == Any {
    func str(_ key: String) -> String { self[key] as? String ?? "" }
    func optStr(_ key: String) -> String? { self[key] as? String }
    func int(_ key: String) -> Int { (self[key] as? NSNumber)?.intValue ?? 0 }
    func double(_ key: String) -> Double { (self[key] as? NSNumber)?.doubleValue ?? 0 }
    func bool(_ key: String) -> Bool { (self[key] as? NSNumber)?.boolValue ?? false }
}

struct AgentInfo: Identifiable, Hashable {
    let id: String
    let name: String
    let detail: String
}

enum ToolStatus { case running, ok, error }

struct FeedItem: Identifiable {
    enum Kind { case note, thinking, tool, artifact, final, error }
    let id: Int
    let ts: Double
    let agent: String
    let kind: Kind
    var title: String
    var body: String
    var callId: String = ""
    var status: ToolStatus = .ok
}

struct RunInfo {
    var runId: String
    var task: String
    var workspace: String
    var running: Bool
    var failed: Bool = false
    var startedAt: Double
    var endedAt: Double?
    var model: String = ""
    var steps: Int = 0
    var filesWritten: [String] = []
    var commandsRun: [String] = []
}

struct Approval {
    let message: String
    let viaDashboard: Bool
    let detail: String?
}

struct UsageEntry: Identifiable {
    let id: String
    let ts: Double
    let runId: String
    let agent: String
    let prompt: Int
    let completion: Int
    let estimated: Bool
}

struct FileEntry: Identifiable, Hashable {
    var id: String { path }
    let path: String
    let isDir: Bool
    let size: Int?
}

struct FileTree {
    let root: String
    let entries: [FileEntry]
    let truncated: Bool
}

// A finished run kept on the phone (History tab).
struct RunRecord: Codable, Identifiable {
    var id: String { runId + String(Int(startedAt)) }
    let runId: String
    let task: String
    let agent: String
    let failed: Bool
    let startedAt: Double
    let endedAt: Double
    let promptTokens: Int
    let completionTokens: Int
    let summary: String
}

enum Theme {
    static let bg = Color(red: 0.055, green: 0.063, blue: 0.078)
    static let card = Color(red: 0.082, green: 0.098, blue: 0.125)
    static let line = Color(red: 0.149, green: 0.176, blue: 0.216)
    static let teal = Color(red: 0.369, green: 0.918, blue: 0.831)
    static let amber = Color(red: 0.961, green: 0.722, blue: 0.294)
    static let red = Color(red: 0.949, green: 0.545, blue: 0.51)
    static let muted = Color(red: 0.604, green: 0.639, blue: 0.686)
}

func formatTokens(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
    if n >= 10_000 { return "\(Int((Double(n) / 1000).rounded()))K" }
    if n >= 1000 { return String(format: "%.1fK", Double(n) / 1000) }
    return "\(n)"
}

// The command or path out of a tool call's raw JSON arguments (may be truncated by the server).
func summarizeArgs(_ args: String) -> String {
    guard let regex = try? NSRegularExpression(pattern: "\"(command|path)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\""),
          let m = regex.firstMatch(in: args, range: NSRange(args.startIndex..., in: args)),
          let r = Range(m.range(at: 2), in: args) else { return args }
    let raw = String(args[r])
    if let data = "\"\(raw)\"".data(using: .utf8),
       let decoded = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? String {
        return decoded
    }
    return raw
}
