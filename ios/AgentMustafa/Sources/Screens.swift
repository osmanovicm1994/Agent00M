import SwiftUI

// Shared building blocks

struct Card<Content: View>: View {
    var accent: Color? = nil
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 6) { content }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(accent ?? Theme.line, lineWidth: accent == nil ? 1 : 1.5))
    }
}

struct Label2: View {
    let text: String
    var color: Color = Theme.muted
    var body: some View { Text(text.uppercased()).font(.caption2.weight(.medium)).tracking(1).foregroundStyle(color) }
}

// MARK: Agents

struct AgentsView: View {
    @Environment(AgentClient.self) private var client
    let onSignOut: () -> Void

    private var todayTokens: Int {
        let start = Calendar.current.startOfDay(for: Date()).timeIntervalSince1970 * 1000
        return client.usage.filter { $0.ts >= start }.reduce(0) { $0 + $1.prompt + $1.completion }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    HStack(spacing: 12) {
                        Circle().fill(client.connected ? Theme.teal : Theme.red).frame(width: 10, height: 10)
                        VStack(alignment: .leading) {
                            Text(client.connected ? "Connected" : "Reconnecting…").font(.headline)
                            Text(client.canControl ? "You can control the agent" : "Read-only: the token is missing")
                                .font(.footnote).foregroundStyle(Theme.muted)
                        }
                        Spacer()
                    }
                    .padding(14)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 16))

                    Card {
                        Label2(text: "Model tokens this session")
                        Text(formatTokens(todayTokens)).font(.system(size: 28, weight: .medium, design: .monospaced))
                        Text("\(client.usage.count) model calls. Counts the agent's own model, not Claude.")
                            .font(.footnote).foregroundStyle(Theme.muted)
                    }

                    SettingsCard()

                    NotificationsCard()

                    NavigationLink {
                        GuideView()
                    } label: {
                        Card {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("How to prompt the agent").font(.headline)
                                    Text("The tutorial: what to write so it builds what you want.").font(.footnote).foregroundStyle(Theme.muted)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").foregroundStyle(Theme.muted)
                            }
                        }
                    }
                    .buttonStyle(.plain)

                    HStack {
                        Text("Who is active").font(.title3.bold())
                        Spacer()
                        Label2(text: client.pinned == nil ? "Auto routing" : "Solo")
                    }

                    ForEach(client.roster) { agent in
                        let on = client.pinned == agent.id
                        let used = client.usage.filter { $0.agent == agent.id }.reduce(0) { $0 + $1.prompt + $1.completion }
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 8) {
                                    Circle().fill(client.activeAgent == agent.id ? Theme.teal : Theme.muted).frame(width: 8, height: 8)
                                    Text(agent.name).font(.headline)
                                }
                                Text(agent.detail).font(.footnote).foregroundStyle(Theme.muted).lineLimit(2)
                                Text(used > 0 ? "\(formatTokens(used)) tokens" : (client.activeAgent == agent.id ? "Working" : "Idle"))
                                    .font(.caption.monospaced()).foregroundStyle(Theme.muted)
                            }
                            Spacer()
                            VStack(spacing: 4) {
                                Toggle("Only \(agent.name) active", isOn: Binding(get: { on }, set: { client.pinned = $0 ? agent.id : nil }))
                                    .labelsHidden()
                                    .disabled(!client.canControl)
                                Text("Only me").font(.caption2).foregroundStyle(Theme.muted)
                            }
                        }
                        .padding(14)
                        .background(on ? Theme.teal.opacity(0.08) : Theme.card, in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(on ? Theme.teal : Theme.line))
                        .opacity(client.pinned != nil && !on ? 0.6 : 1)
                    }

                    if client.pinned != nil {
                        Button("Release to auto routing") { client.pinned = nil }
                            .buttonStyle(.bordered).frame(minHeight: 48)
                    }
                    Button("Sign out and forget the address", role: .destructive, action: onSignOut)
                        .padding(.top, 8)
                }
                .padding(16)
            }
            .background(Theme.bg)
            .navigationTitle("Agents")
        }
    }
}

// MARK: Guide

// One block of the tutorial. The tutorial is Markdown; only what it uses is drawn: headings, paragraphs, bullets,
// numbered lines, code blocks and table rows (as one line of cells).
struct GuideBlock: Identifiable {
    enum Kind { case h1, h2, h3, paragraph, bullet, numbered, code, row }
    let id: Int
    let kind: Kind
    let text: String
}

func parseGuide(_ markdown: String) -> [GuideBlock] {
    var out: [GuideBlock] = []
    var code: [String]?
    var para: [String] = []
    func add(_ kind: GuideBlock.Kind, _ text: String) { out.append(GuideBlock(id: out.count, kind: kind, text: text)) }
    func flush() {
        if !para.isEmpty { add(.paragraph, para.joined(separator: " ")); para = [] }
    }
    for raw in markdown.components(separatedBy: "\n") {
        if raw.hasPrefix("```") {
            if let c = code { add(.code, c.joined(separator: "\n")); code = nil } else { flush(); code = [] }
            continue
        }
        if code != nil { code?.append(raw); continue }
        let line = raw.trimmingCharacters(in: .whitespaces)
        if line.isEmpty { flush(); continue }
        if line.hasPrefix("### ") { flush(); add(.h3, String(line.dropFirst(4))) }
        else if line.hasPrefix("## ") { flush(); add(.h2, String(line.dropFirst(3))) }
        else if line.hasPrefix("# ") { flush(); add(.h1, String(line.dropFirst(2))) }
        else if line.hasPrefix("- ") || line.hasPrefix("* ") { flush(); add(.bullet, String(line.dropFirst(2))) }
        else if line.range(of: #"^\d+\.\s"#, options: .regularExpression) != nil { flush(); add(.numbered, line) }
        else if line.hasPrefix("|") {
            flush()
            if !line.contains("---") {
                add(.row, line.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: "  ·  "))
            }
        }
        else { para.append(line) }
    }
    if let c = code { add(.code, c.joined(separator: "\n")) }
    flush()
    return out
}

private func inlineMarkdown(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
}

struct GuideView: View {
    @Environment(AgentClient.self) private var client
    @State private var blocks: [GuideBlock] = []

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if blocks.isEmpty {
                    Text(client.connected ? "Loading the guide from your Mac…" : "Not connected. The guide is read from the agent when you are connected.")
                        .foregroundStyle(Theme.muted)
                    if let n = client.notice { Text(n).font(.footnote).foregroundStyle(Theme.amber) }
                }
                ForEach(blocks) { b in blockView(b) }
            }
            .padding(16)
        }
        .background(Theme.bg)
        .navigationTitle("Prompting guide")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if let g = client.guide { blocks = parseGuide(g) } else { client.requestGuide() }
        }
        .onChange(of: client.guide) { _, new in blocks = new.map(parseGuide) ?? [] }
    }

    @ViewBuilder private func blockView(_ b: GuideBlock) -> some View {
        switch b.kind {
        case .h1: Text(inlineMarkdown(b.text)).font(.title.bold()).padding(.top, 6)
        case .h2: Text(inlineMarkdown(b.text)).font(.title2.bold()).foregroundStyle(Theme.teal).padding(.top, 12)
        case .h3: Text(inlineMarkdown(b.text)).font(.headline).padding(.top, 6)
        case .paragraph: Text(inlineMarkdown(b.text)).font(.callout)
        case .bullet:
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("•").foregroundStyle(Theme.teal)
                Text(inlineMarkdown(b.text)).font(.callout)
            }
        case .numbered: Text(inlineMarkdown(b.text)).font(.callout)
        case .code:
            ScrollView(.horizontal, showsIndicators: false) {
                Text(b.text).font(.caption.monospaced()).textSelection(.enabled).padding(12)
            }
            .background(Color.black.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
        case .row: Text(inlineMarkdown(b.text)).font(.footnote).foregroundStyle(Theme.muted)
        }
    }
}

// MARK: Live

struct LiveView: View {
    @Environment(AgentClient.self) private var client
    @State private var showThinking = true

    private var lastTool: FeedItem? { client.feed.last(where: { $0.kind == .tool }) }
    private var lastThought: FeedItem? { client.feed.last(where: { $0.kind == .thinking }) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            if let r = client.run {
                                Text(r.task).font(.footnote).foregroundStyle(Theme.muted).lineLimit(3)
                                Picker("", selection: $showThinking) {
                                    Text("Thinking").tag(true)
                                    Text("Full feed").tag(false)
                                }
                                .pickerStyle(.segmented)
                            } else {
                                Text("Nothing running. Send a prompt from the Prompt tab.").foregroundStyle(Theme.muted)
                            }

                            if showThinking, client.run != nil {
                                Card(accent: Theme.teal) {
                                    Label2(text: "Wants to do", color: Theme.teal)
                                    Text(lastTool.map { "\($0.title): \($0.body)" } ?? (client.llmWaiting ? "Working out the first step…" : "Waiting for the first step."))
                                        .font(.callout.monospaced())
                                    if lastTool?.status == .running && client.canControl {
                                        Button("Stop this command", role: .destructive) { client.stopCommand() }
                                            .buttonStyle(.bordered).frame(minHeight: 44)
                                    }
                                }
                                Card(accent: Theme.amber) {
                                    Label2(text: "Why", color: Theme.amber)
                                    Text(lastThought?.body ?? "No reasoning text yet.").font(.callout)
                                }
                            } else {
                                ForEach(client.feed) { item in FeedRow(item: item).id(item.id) }
                                if client.llmWaiting { Text("The model is generating…").font(.footnote).foregroundStyle(Theme.teal) }
                            }
                            Color.clear.frame(height: 1).id("bottom")
                        }
                        .padding(16)
                    }
                    .onChange(of: client.feed.count) { _, _ in
                        if !showThinking { withAnimation { proxy.scrollTo("bottom") } }
                    }
                }
                if let a = client.approval { ApprovalDock(approval: a) }
            }
            .background(Theme.bg)
            .navigationTitle(client.run.map { $0.running ? "Working" : ($0.failed ? "Failed" : "Done") } ?? "Live")
        }
    }
}

struct FeedRow: View {
    let item: FeedItem
    var body: some View {
        switch item.kind {
        case .tool:
            Card(accent: item.status == .error ? Theme.red : nil) {
                HStack {
                    Text(item.title).font(.footnote.monospaced().weight(.semibold)).foregroundStyle(Theme.amber)
                    Spacer()
                    Text(item.status == .running ? "running" : item.status == .error ? "failed" : "done")
                        .font(.caption).foregroundStyle(item.status == .error ? Theme.red : item.status == .running ? Theme.teal : .green)
                }
                Text(item.body).font(.caption.monospaced()).textSelection(.enabled)
            }
        case .thinking:
            Card { Label2(text: "💭 \(item.title)"); Text(item.body).font(.callout).italic() }
        case .final:
            Card(accent: .green) { Label2(text: "Agent", color: .green); Text(item.body).font(.callout) }
        case .error:
            Text("✖ \(item.body)").font(.callout).foregroundStyle(Theme.red)
        case .artifact:
            Text("📄 \(item.title) \(item.body)").font(.footnote.monospaced()).foregroundStyle(.green)
        case .note:
            switch item.title {
            case "step": Text(item.body).font(.callout.weight(.semibold)).foregroundStyle(Theme.teal).padding(.top, 6)
            case "warn": Text("⚠ \(item.body)").font(.footnote).foregroundStyle(Theme.amber)
            case "stats": Text("⏱ \(item.body)").font(.caption2.monospaced()).foregroundStyle(Theme.muted)
            case "plan": Card(accent: Theme.line) { Label2(text: "Team plan"); Text(item.body).font(.footnote) }
            default: Text(item.body).font(.footnote).foregroundStyle(Theme.muted).lineLimit(item.title == "Task" ? 3 : nil)
            }
        }
    }
}

struct ApprovalDock: View {
    @Environment(AgentClient.self) private var client
    let approval: Approval
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label2(text: approval.viaDashboard ? "Waiting for your approval" : "Waiting in the terminal", color: Theme.amber)
            Text(approval.message).font(.headline)
            if let d = approval.detail {
                ScrollView { Text(d).font(.caption.monospaced()).frame(maxWidth: .infinity, alignment: .leading) }
                    .frame(maxHeight: 150).padding(8).background(Color.black.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
            }
            if approval.viaDashboard && client.canControl {
                HStack(spacing: 10) {
                    Button { client.answerApproval(true) } label: { Text("Approve").frame(maxWidth: .infinity, minHeight: 50) }
                        .buttonStyle(.borderedProminent).foregroundStyle(.black)
                    Button(role: .destructive) { client.answerApproval(false) } label: { Text("Deny").frame(maxWidth: .infinity, minHeight: 50) }
                        .buttonStyle(.bordered)
                }
            }
        }
        .padding(14)
        .background(Color(red: 0.11, green: 0.10, blue: 0.08))
        .overlay(alignment: .top) { Rectangle().fill(Theme.amber.opacity(0.5)).frame(height: 1) }
    }
}

// MARK: Prompt

struct PromptView: View {
    @Environment(AgentClient.self) private var client
    @Binding var context: [String]
    @State private var text = ""
    @FocusState private var focused: Bool

    private var target: String {
        client.pinned.flatMap { id in client.roster.first { $0.id == id }?.name }.map { "To \($0) · solo" } ?? "To the orchestrator · auto"
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text(client.busy ? "The agent is working…" : target).font(.footnote.monospaced()).foregroundStyle(Theme.muted)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(context, id: \.self) { p in
                            Button { context.removeAll { $0 == p } } label: { Text("\(p) ✕").font(.caption.monospaced()) }
                                .buttonStyle(.bordered)
                        }
                        Text(context.isEmpty ? "Add files in the Project tab" : "").font(.caption).foregroundStyle(Theme.muted)
                    }
                }

                DisclosureGroup("Switches: team \(client.settings.team ? "on" : "off"), auto-write \(client.settings.autoWrite ? "on" : "off")…") {
                    ScrollView { SettingsCard() }.frame(maxHeight: 360)
                }
                .tint(Theme.teal)

                TextEditor(text: $text)
                    .focused($focused)
                    .scrollContentBackground(.hidden)
                    .padding(10)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line))
                    .frame(minHeight: 140)

                if let n = client.notice { Text(n).font(.footnote).foregroundStyle(Theme.amber) }

                Button {
                    client.submit(task: text.trimmingCharacters(in: .whitespacesAndNewlines), context: context)
                    text = ""; context = []; focused = false
                } label: { Text("Send").font(.headline).frame(maxWidth: .infinity, minHeight: 52) }
                    .buttonStyle(.borderedProminent).foregroundStyle(.black)
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || client.busy || !client.canControl || !client.acceptsTasks)

                if !client.acceptsTasks { Text("The agent is not ready for prompts yet (startup questions are open in the terminal).").font(.footnote).foregroundStyle(Theme.muted) }
                Spacer()
            }
            .padding(16)
            .background(Theme.bg)
            .navigationTitle("Prompt")
        }
    }
}

// MARK: Project

struct ProjectView: View {
    @Environment(AgentClient.self) private var client
    @Binding var context: [String]

    var body: some View {
        NavigationStack {
            List {
                if let tree = client.files {
                    Section { Text(tree.root).font(.caption.monospaced()).foregroundStyle(Theme.muted) }
                    ForEach(tree.entries) { e in
                        let depth = e.path.split(separator: "/").count - 1
                        let name = e.path.split(separator: "/").last.map(String.init) ?? e.path
                        let inCtx = context.contains(e.path)
                        Button {
                            if !e.isDir { if inCtx { context.removeAll { $0 == e.path } } else { context.append(e.path) } }
                        } label: {
                            HStack {
                                Text(e.isDir ? "\(name)/" : name).font(.callout.monospaced())
                                    .foregroundStyle(e.isDir ? Theme.muted : .white)
                                    .padding(.leading, CGFloat(depth) * 16)
                                Spacer()
                                if inCtx { Text("in prompt").font(.caption).foregroundStyle(Theme.teal) }
                            }
                            .frame(minHeight: 36)
                        }
                        .listRowBackground(inCtx ? Theme.teal.opacity(0.1) : Theme.card)
                    }
                    if tree.truncated { Text("The list was cut off.").font(.footnote).foregroundStyle(Theme.amber) }
                } else {
                    Text(client.canControl ? "Loading, or the startup questions are still open in the terminal." : "The project tree needs the control token.")
                        .foregroundStyle(Theme.muted)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Project")
            .toolbar { Button("Refresh") { client.requestFiles() }.disabled(!client.canControl) }
            .onAppear { if client.files == nil && client.canControl { client.requestFiles() } }
            .refreshable { client.requestFiles() }
        }
    }
}

// MARK: History

struct HistoryView: View {
    @Environment(AgentClient.self) private var client

    var body: some View {
        NavigationStack {
            List {
                if client.history.isEmpty { Text("No finished runs yet.").foregroundStyle(Theme.muted) }
                ForEach(client.history) { r in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(r.task).font(.callout).lineLimit(2)
                            Spacer()
                            Text(r.failed ? "Failed" : "Done").font(.caption).foregroundStyle(r.failed ? Theme.red : .green)
                        }
                        Text("\(r.agent) · \(Date(timeIntervalSince1970: r.startedAt / 1000).formatted(.relative(presentation: .named))) · \(formatTokens(r.promptTokens + r.completionTokens)) tokens")
                            .font(.caption.monospaced()).foregroundStyle(Theme.muted)
                        if !r.summary.isEmpty { Text(r.summary).font(.footnote).foregroundStyle(Theme.muted).lineLimit(4) }
                    }
                    .listRowBackground(Theme.card)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("History")
        }
    }
}
