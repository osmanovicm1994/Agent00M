import { useEffect, useReducer } from "react";
import type { ServerMessage } from "./protocol";
import { initialState, reducer, type DashboardState } from "./state";

// Connects to the agent's WebSocket, reconnects automatically, and folds every event into
// DashboardState. The server replays recent history on connect, so refreshing the page is safe.
export function useAgentSocket(url: string): DashboardState {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      const ws = new WebSocket(url);
      socket = ws;

      ws.onopen = () => dispatch({ type: "connection", connected: true });

      ws.onmessage = (message) => {
        let parsed: ServerMessage;
        try {
          parsed = JSON.parse(String(message.data)) as ServerMessage;
        } catch {
          return;
        }
        if (parsed.kind === "hello") {
          dispatch({ type: "hello", roster: parsed.roster, history: parsed.history });
        } else if (parsed.kind === "event") {
          dispatch({ type: "event", event: parsed.event });
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
      socket?.close();
    };
  }, [url]);

  return state;
}
