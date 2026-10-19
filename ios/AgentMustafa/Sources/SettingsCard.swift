import SwiftUI

// Mirror of the agent's switches (see SettingsState in src/core/event-types.ts).
struct AgentSettings {
    var team = false
    var parallel = false
    var autoWrite = false
    var autoRun = false
    var autoDebug = false
    var research = false
    var planner = "auto"
    var autoRunLocked = false
    var researchAvailable = false
}

// Every switch the terminal has. Changes go to the agent; the screen updates when the agent confirms,
// so the phone, the web dashboard and the terminal always agree.
struct SettingsCard: View {
    @Environment(AgentClient.self) private var client

    private func row(_ title: String, _ hint: String, key: String, on: Bool, blocked: String? = nil) -> some View {
        Toggle(isOn: Binding(get: { on }, set: { client.setSetting(key, $0) })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(blocked ?? hint).font(.footnote).foregroundStyle(blocked == nil ? Theme.muted : Theme.amber)
            }
        }
        .disabled(!client.canControl || (blocked != nil && !on))
    }

    var body: some View {
        let s = client.settings
        VStack(alignment: .leading, spacing: 14) {
            row("Team mode", "Project Manager plans, engineers build, Safety Reviewer checks.", key: "team", on: s.team)
            Divider().overlay(Theme.line)
            row("Parallel team", "Independent engineer tasks run at the same time. Needs auto-write and auto-run.", key: "parallel", on: s.parallel)
            Divider().overlay(Theme.line)
            row("Auto-write", "Files are written and commands run without asking (risky ones still ask).", key: "autoWrite", on: s.autoWrite)
            Divider().overlay(Theme.line)
            row("Auto-run", "Shell commands run without asking. Risky ones still ask.", key: "autoRun", on: s.autoRun,
                blocked: s.autoRunLocked ? "Disabled by AGENT_AUTO_RUN=0 in the env file." : nil)
            Divider().overlay(Theme.line)
            row("Auto-debug", "A failed command starts the Debug Agent right away. Needs auto-write and auto-run.", key: "autoDebug", on: s.autoDebug)
            Divider().overlay(Theme.line)
            row("Research stage", "Gemini researches each task first (sends your question and a file-name overview to Google).",
                key: "research", on: s.research, blocked: s.researchAvailable ? nil : "Needs GEMINI_API_KEY in the agent's .env.")
            VStack(alignment: .leading, spacing: 6) {
                Text("Planner").font(.headline)
                Picker("Planner", selection: Binding(get: { s.planner }, set: { client.setSetting("planner", $0) })) {
                    Text("Auto").tag("auto")
                    Text("Always").tag("always")
                    Text("Off").tag("off")
                }
                .pickerStyle(.segmented)
                .disabled(!client.canControl || !s.researchAvailable)
                Text("Auto = only when the research says a plan is needed.").font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .padding(14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line))
    }
}
