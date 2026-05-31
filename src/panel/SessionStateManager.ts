import type { SessionState, LogEntry, LogLevel } from '../shared/types';

export type LogCallback = (entry: LogEntry) => void;

export class SessionStateManager {
  private sessions: SessionState[] = [];
  private logs: LogEntry[] = [];
  private sessionListeners = new Set<(sessions: SessionState[]) => void>();
  private logListeners = new Set<LogCallback>();

  updateSessions(sessions: SessionState[]) {
    this.sessions = sessions;
    for (const fn of this.sessionListeners) fn(this.sessions);
  }

  log(level: LogLevel, text: string) {
    const entry: LogEntry = { level, text, ts: Date.now() };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs = this.logs.slice(-200);
    for (const fn of this.logListeners) fn(entry);
  }

  getLogs(): LogEntry[] { return this.logs; }

  onSessions(fn: (sessions: SessionState[]) => void) {
    this.sessionListeners.add(fn);
    return () => { this.sessionListeners.delete(fn); };
  }

  onLog(fn: LogCallback) {
    this.logListeners.add(fn);
    return () => { this.logListeners.delete(fn); };
  }
}
