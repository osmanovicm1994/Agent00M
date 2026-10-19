import SwiftUI

@main
struct AgentMustafaApp: App {
    @State private var client = AgentClient()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(client)
                .preferredColorScheme(.dark)
                .tint(Theme.teal)
                .onAppear {
                    client.askNotificationPermission()
                    // Reconnect with the saved address (Keychain), so the app opens straight into the dashboard.
                    if let saved = Keychain.load() { client.connect(pasted: saved) }
                }
                .onChange(of: scenePhase) { _, phase in
                    client.appActive = (phase == .active)
                    if phase == .active, let saved = Keychain.load(), !client.connected { client.connect(pasted: saved) }
                }
        }
    }
}

struct RootView: View {
    @Environment(AgentClient.self) private var client
    @State private var hasAddress = Keychain.load() != nil

    var body: some View {
        Group {
            if hasAddress {
                MainTabs(onSignOut: {
                    client.disconnect()
                    Keychain.delete()
                    hasAddress = false
                })
            } else {
                ConnectView { hasAddress = true }
            }
        }
        .background(Theme.bg.ignoresSafeArea())
    }
}

// First launch: paste the address printed by `npm run chat:ui:remote` (it contains the token).
struct ConnectView: View {
    @Environment(AgentClient.self) private var client
    @State private var text = ""
    @State private var failed = false
    let done: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Agent Mustafa").font(.largeTitle.bold())
            Text("Paste the remote address from the terminal. It looks like https://your-mac.tailXXXX.ts.net/?token=… and is stored in the iPhone Keychain. The Tailscale app must be connected.")
                .foregroundStyle(Theme.muted)
            TextField("https://…ts.net/?token=…", text: $text, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .padding(14)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line))
            if failed { Text("That does not look like a dashboard address.").foregroundStyle(Theme.red) }
            Button {
                let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if client.connect(pasted: value) { Keychain.save(value); done() } else { failed = true }
            } label: {
                Text("Connect").font(.headline).frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .foregroundStyle(Color.black)
            .disabled(text.isEmpty)
            Spacer()
        }
        .padding(20)
    }
}

struct MainTabs: View {
    @Environment(AgentClient.self) private var client
    let onSignOut: () -> Void
    @State private var context: [String] = []

    var body: some View {
        TabView {
            AgentsView(onSignOut: onSignOut)
                .tabItem { Label("Agents", systemImage: "square.grid.2x2") }
            LiveView()
                .tabItem { Label("Live", systemImage: "waveform.path.ecg") }
                .badge(client.approval?.viaDashboard == true ? "!" : nil)
            PromptView(context: $context)
                .tabItem { Label("Prompt", systemImage: "bubble.left") }
            ProjectView(context: $context)
                .tabItem { Label("Project", systemImage: "folder") }
            HistoryView()
                .tabItem { Label("History", systemImage: "clock") }
        }
    }
}
