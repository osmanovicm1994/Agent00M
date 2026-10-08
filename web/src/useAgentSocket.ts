import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ClientCommand, ServerMessage } from "./protocol";
import { initialState, reducer, type DashboardState } from "./state";

export interface AgentSocket {
  state: DashboardState;
  // Sends a command. Returns false if the socket is not open.
  send: (command: ClientCommand) => boolean;
  dismissNotice: () => void;
}

// Connects to the agent's WebSocket, reconnects automatically, and folds every event into
// DashboardState. The server replays recent history on connect, so refreshing the page is safe.
// With a control token in the URL the server also accepts tasks and approvals from this page.
export function useAgentSocket(url: string): AgentSocket {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef<WebSocket | undefined>(undefined);

  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      const ws = new WebSocket(url);
      socketRef.current = ws;

      ws.onopen = () => dispatch({ type: "connection", connected: true });

      ws.onmessage = (message) => {
        let parsed: ServerMessage;
        try {
          parsed = JSON.parse(String(message.data)) as ServerMessage;
        } catch {
          return;
        }
        switch (parsed.kind) {
          case "hello":
            dispatch({
              type: "hello",
              roster: parsed.roster,
              history: parsed.history,
              canControl: parsed.canControl,
              acceptsTasks: parsed.acceptsTasks,
              busy: parsed.busy,
            });
            break;
          case "session":
            dispatch({ type: "session", acceptsTasks: parsed.acceptsTasks });
            break;
          case "event":
            dispatch({ type: "event", event: parsed.event });
            break;
          case "busy":
            dispatch({ type: "busy", busy: parsed.busy });
            break;
          case "notice":
            dispatch({ type: "notice", level: parsed.level, text: parsed.text });
            break;
        }
      };

      ws.onclose = () => {
        dispatch({ type: "connection", connected: false });
        if (!disposed) retry = setTimeout(connect, 1500);
      };

      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      socketRef.current?.close();
    };
  }, [url]);

  const send = useCallback((command: ClientCommand): boolean => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(command));
    return true;
  }, []);

  const dismissNotice = useCallback(() => dispatch({ type: "dismiss_notice" }), []);

  return { state, send, dismissNotice };
}
