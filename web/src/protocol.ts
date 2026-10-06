// The wire types live in the backend (src/core/event-types.ts) so there is ONE source of truth.
// Type-only re-exports are erased at build time: nothing from the Node side reaches the browser.
export type {
  AgentEvent,
  AgentEventType,
  AgentInfo,
  EventPayloads,
  ServerMessage,
} from "../../src/core/event-types";
