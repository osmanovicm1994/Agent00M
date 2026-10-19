import Foundation
import Observation
import UserNotifications

// Talks to the agent over the same WebSocket as the web dashboard (see src/server.ts and
// src/core/event-types.ts) and keeps everything the screens show.
@Observable
@MainActor
final class AgentClient {
    // connection
    var connected = false
    var canControl = false
    var acceptsTasks = false
    var busy = false
    // Every terminal switch (/team, /parallel, /auto-write, /auto-run, /auto-debug, /research, /plan). The agent owns the state.
    var settings = AgentSettings()
    var team: Bool { settings.team }
    var roster: [AgentInfo] = []

    // what the agent is doing
    var run: RunInfo?
    var feed: [FeedItem] = []
    var activeAgent: String?
    var lastAgent: String?
    var llmWaiting = false
    var approval: Approval?
    var usage: [UsageEntry] = []
    var files: FileTree?
    var notice: String?
    var history: [RunRecord] = []

    // "Only me": every prompt goes to this agent. Kept on the phone.
    var pinned: String? = UserDefaults.standard.string(forKey: "pinnedAgent") {
        didSet { UserDefaults.standard.set(pinned, forKey: "pinnedAgent") }
    }

    private var socket: URLSessionWebSocketTask?
    private var session = URLSession(configuration: .default)
    private var wsURL: URL?
    private var wantConnection = false
    private var seenKeys = Set<String>()
    var appActive = true

    init() {
        if let data = UserDefaults.standard.data(forKey: "history"),
           let saved = try? JSONDecoder().decode([RunRecord].self, from: data) {
            history = saved
        }
    }

    // MARK: connection

    // `pasted` is the dashboard address with ?token=..., e.g. https://my-mac.tailXXXX.ts.net/?token=...
    // https becomes wss and http becomes ws; the socket path is /ws.
    @discardableResult
    func connect(pasted: String) -> Bool {
        guard var comps = URLComponents(string: pasted.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = comps.host else { return false }
        let token = comps.queryItems?.first(where: { $0.name == "token" })?.value
        comps.scheme = (comps.scheme == "http") ? "ws" : "wss"
        comps.path = "/ws"
        comps.queryItems = token.map { [URLQueryItem(name: "token", value: $0)] }
        _ = host
        guard let url = comps.url else { return false }
        disconnect()
        wsURL = url
        wantConnection = true
        open()
        return true
    }

    func disconnect() {
        wantConnection = false
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connected = false
    }

    private func open() {
        guard let url = wsURL, wantConnection else { return }
        let task = session.webSocketTask(with: url)
        socket = task
        task.resume()
        connected = true
        receive(task)
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.socket === task else { return }
                switch result {
                case .success(let message):
                    if case .string(let text) = message { self.handle(text) }
                    self.receive(task)
                case .failure:
                    self.connected = false
                    guard self.wantConnection else { return }
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    if self.wantConnection { self.open() }
                }
            }
        }
    }

    // MARK: commands

    private func send(_ object: JSON) {
        guard let socket, let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(text)) { _ in }
    }

    func submit(task: String, context: [String]) {
        let header = context.isEmpty ? "" : "Focus on these files:\n" + context.map { "- \($0)" }.joined(separator: "\n") + "\n\n"
        var cmd: JSON = ["kind": "submit_task", "task": header + task]
        if let pinned { cmd["agentId"] = pinned }
        send(cmd)
    }

    func answerApproval(_ approved: Bool) { send(["kind": "answer_approval", "approved": approved]) }
    func requestFiles() { send(["kind": "list_files"]) }
    func stopCommand() { send(["kind": "stop_command"]) }
    func setTeam(_ on: Bool) { send(["kind": "set_team", "on": on]) }
    // key: team, parallel, autoWrite, autoRun, autoDebug, research (Bool) or planner (auto | always | off).
    func setSetting(_ key: String, _ value: Any) { send(["kind": "set_setting", "key": key, "value": value]) }

    // MARK: incoming

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? JSON else { return }
        switch msg.str("kind") {
        case "hello":
            resetForHello(msg)
        case "event":
            if let e = msg["event"] as? JSON { apply(e) }
        case "busy": busy = msg.bool("busy")
        case "session": acceptsTasks = msg.bool("acceptsTasks")
        case "settings":
            settings = AgentSettings(
                team: msg.bool("team"), parallel: msg.bool("parallel"), autoWrite: msg.bool("autoWrite"),
                autoRun: msg.bool("autoRun"), autoDebug: msg.bool("autoDebug"), research: msg.bool("research"),
                planner: msg.optStr("planner") ?? "auto", autoRunLocked: msg.bool("autoRunLocked"),
                researchAvailable: msg.bool("researchAvailable"))
        case "files":
            let entries = (msg["entries"] as? [JSON] ?? []).map {
                FileEntry(path: $0.str("path"), isDir: $0.str("type") == "dir", size: $0["size"] as? Int)
            }
            files = FileTree(root: msg.str("root"), entries: entries, truncated: msg.bool("truncated"))
        case "notice": notice = msg.str("text")
        default: break
        }
    }

    private func resetForHello(_ msg: JSON) {
        roster = (msg["roster"] as? [JSON] ?? []).map { AgentInfo(id: $0.str("id"), name: $0.str("name"), detail: $0.str("description")) }
        canControl = msg.bool("canControl")
        acceptsTasks = msg.bool("acceptsTasks")
        busy = msg.bool("busy")
        run = nil; feed = []; activeAgent = nil; lastAgent = nil; llmWaiting = false; approval = nil; usage = []
        seenKeys = []
        for e in msg["history"] as? [JSON] ?? [] { apply(e, replay: true) }
    }

    private func push(_ item: FeedItem) {
        feed.append(item)
        if feed.count > 600 { feed.removeFirst(feed.count - 600) }
    }

    private func apply(_ e: JSON, replay: Bool = false) {
        let type = e.str("type")
        let seq = e.int("seq"), ts = e.double("ts"), runId = e.str("runId"), agent = e.str("agent")
        let p = e["payload"] as? JSON ?? [:]

        // Team mode runs several executors inside one run; a run that keeps working is running again.
        if run?.running == false, run?.runId == runId,
           ["executor_ready", "llm_request", "tool_running", "log"].contains(type) {
            run?.running = true; run?.endedAt = nil
        }

        switch type {
        case "run_started":
            run = RunInfo(runId: runId, task: p.str("task"), workspace: p.str("workspace"), running: true, startedAt: ts)
            feed = []; approval = nil; llmWaiting = false; activeAgent = "orchestrator"; lastAgent = nil
            push(FeedItem(id: seq, ts: ts, agent: agent, kind: .note, title: "Task", body: p.str("task")))
        case "orchestrator_evaluating":
            activeAgent = "orchestrator"
        case "agent_routed":
            activeAgent = p.str("agentId"); lastAgent = activeAgent
            push(FeedItem(id: seq, ts: ts, agent: p.str("agentId"), kind: .note, title: "Baton",
                          body: "Passed to \(p.str("agentName")) (\(p.str("method") == "forced" ? "chosen by you" : "routed by \(p.str("method"))"))"))
        case "executor_ready":
            activeAgent = p.str("agentId"); lastAgent = activeAgent
            run?.model = p.str("model")
        case "llm_request":
            llmWaiting = true
        case "log":
            let level = p.str("level")
            push(FeedItem(id: seq, ts: ts, agent: agent, kind: .note, title: level, body: p.str("text")))
        case "llm_usage":
            let key = "\(Int(ts)):\(seq)"
            if seenKeys.insert(key).inserted {
                usage.append(UsageEntry(id: key, ts: ts, runId: runId, agent: agent, prompt: p.int("promptTokens"),
                                        completion: p.int("completionTokens"),
                                        estimated: p.bool("promptEstimated") || p.bool("completionEstimated")))
            }
            let secs = { (ms: Double) in String(format: "%.1fs", ms / 1000) }
            push(FeedItem(id: seq, ts: ts, agent: agent, kind: .note, title: "stats",
                          body: "first token \(secs(p.double("ttftMs"))) · \(p.int("completionTokens")) tokens in \(secs(p.double("totalMs"))) · " +
                                String(format: "%.1f tok/s", p.double("tokPerSec"))))
        case "agent_thinking":
            llmWaiting = false
            let label = p.optStr("label") ?? (p.str("source") == "plan" ? "plan" : "step \(p.int("step"))")
            push(FeedItem(id: seq, ts: ts, agent: agent, kind: .thinking, title: label, body: p.str("text")))
        case "tool_running":
            llmWaiting = false
            push(FeedItem(id: seq, ts: ts, agent: agent, kind: .tool, title: p.str("tool"), body: summarizeArgs(p.str("args")),
                          callId: p.str("callId"), status: .running))
        case "tool_output":
            if let i = feed.lastIndex(where: { $0.callId == p.str("callId") }) {
                var out = feed[i].body
                out += "\n" + p.str("chunk")
                feed[i].body = String(out.suffix(4000))
            }
        case "tool_result":
            if let i = feed.lastIndex(where: { $0.callId == p.str("callId") }) {
                feed[i].status = p.bool("ok") ? .ok : .error
            }
        case "approval_requested":
            approval = Approval(message: p.str("message"), viaDashboard: p.str("via") == "dashboard", detail: p.optStr("detail"))
            if !replay && !appActive && p.str("via") == "dashboard" { notifyApproval(p.str("message")) }
        case "approval_resolved":
            approval = nil
        case "artifact_generated":
            push(FeedItem(id: seq, ts: ts, agent: agent, kind: .artifact, title: p.str("action"), body: p.str("path")))
        case "run_completed":
            llmWaiting = false; approval = nil; activeAgent = nil
            run?.running = false; run?.endedAt = ts; run?.steps = p.int("steps")
            run?.filesWritten = p.strings("filesWritten"); run?.commandsRun = p.strings("commandsRun")
            push(FeedItem(id: seq, ts: ts, agent: agent, kind: .final, title: "Agent", body: p.str("finalMessage")))
            archive(summary: p.str("finalMessage"))
        case "run_failed":
            llmWaiting = false; approval = nil; activeAgent = nil
            run?.running = false; run?.failed = true; run?.endedAt = ts
            push(FeedItem(id: seq, ts: ts, agent: agent, kind: .error, title: "Error", body: p.str("error")))
            archive(summary: p.str("error"))
        default: break
        }
    }

    // Saves a finished run on the phone (History tab).
    private func archive(summary: String) {
        guard let r = run else { return }
        let mine = usage.filter { $0.runId == r.runId }
        let record = RunRecord(runId: r.runId, task: r.task, agent: lastAgent ?? "agent", failed: r.failed, startedAt: r.startedAt,
                               endedAt: r.endedAt ?? r.startedAt, promptTokens: mine.reduce(0) { $0 + $1.prompt },
                               completionTokens: mine.reduce(0) { $0 + $1.completion }, summary: String(summary.prefix(1500)))
        history.removeAll { $0.id == record.id }
        history.insert(record, at: 0)
        history = Array(history.prefix(40))
        if let data = try? JSONEncoder().encode(history) { UserDefaults.standard.set(data, forKey: "history") }
    }

    // MARK: notifications
    // iOS suspends the socket shortly after the app leaves the screen, so this only fires in that short window.
    // For a notification that always arrives, set AGENT_NOTIFY_URL on the agent (ntfy), see docs/REMOTE.md.

    func askNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    private func notifyApproval(_ message: String) {
        let content = UNMutableNotificationContent()
        content.title = "Agent needs approval"
        content.body = message
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "approval", content: content, trigger: nil))
    }
}

extension Dictionary where Key == String, Value == Any {
    func strings(_ key: String) -> [String] { (self[key] as? [Any])?.compactMap { $0 as? String } ?? [] }
}
