# Agent Mustafa for iPhone

A native SwiftUI app (iOS 17+) for the same dashboard as the web app: agents with "Only me", live thinking and feed, approvals with the real command or diff, prompt box with team mode, project tree, history. It talks to the agent over the same WebSocket and the same control token, through Tailscale.

It was written without compiling (no Xcode on the machine that wrote it), so expect to fix a few compiler messages on the first build.

## Build

1. On the Mac: `brew install xcodegen`, then `cd ios/AgentMustafa && xcodegen`. Open `AgentMustafa.xcodeproj`.
   Without XcodeGen: make a new iOS App project in Xcode (SwiftUI, iOS 17) and drag the files from `AgentMustafa/Sources` into it.
2. In Signing & Capabilities pick your team (a free Apple ID is enough to install on your own iPhone; the app expires after 7 days with a free account).
3. Run it on the iPhone (the iPhone needs the Tailscale app connected).
4. First launch: paste the address printed by `npm run chat:ui:remote` (`https://<mac>.<tailnet>.ts.net/?token=...`). It is stored in the iPhone Keychain, so the app reconnects by itself.

## Notifications

- The app asks for notification permission and shows one when an approval arrives while it was just sent to the background. iOS suspends the connection soon after, so this is only a short window.
- For a notification that always arrives (a risky command waiting while the phone is locked), use ntfy: install the ntfy app, pick a long random topic name, and in `.env` on the Mac set `AGENT_NOTIFY_URL=https://ntfy.sh/<your-topic>` (or your own ntfy server on the tailnet). The agent sends only "Agent needs approval" and the agent name, never the command or any file content.

## Limits

- No push through Apple (needs a paid developer account and a server). ntfy covers it.
- Token numbers are the agent's own model usage, not Claude.
- The token address is a password: anyone on your tailnet who has it can run commands on your Mac. Sign out in the Agents tab to forget it.
