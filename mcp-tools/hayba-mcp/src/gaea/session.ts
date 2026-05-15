// Stub — SessionManager was removed when the Gaea session system was refactored.
// Retained here so tool handlers that import the type still compile.

export interface SessionManager {
  sessionId: string;
  [key: string]: unknown;
}
