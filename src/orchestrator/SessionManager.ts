import type { SessionState, SessionStatus } from '../shared/types';

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private listeners = new Set<() => void>();
  private portBase: number;

  constructor(portBase: number) {
    this.portBase = portBase;
  }

  get all(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  get active(): SessionState[] {
    return this.all.filter((s) => s.status !== 'exited' && s.status !== 'error');
  }

  add(targetName: string): { id: string; gdbserverPort: number } {
    const id = `${targetName}-${Date.now()}`;
    const port = this.portBase + this.sessions.size;
    this.sessions.set(id, {
      id,
      targetName,
      status: 'pending',
      gdbserverPort: port,
      breakpointCount: 0,
      threadCount: 0,
      startedAt: Date.now(),
    });
    this.emit();
    return { id, gdbserverPort: port };
  }

  update(id: string, patch: Partial<Pick<SessionState, 'status' | 'pid' | 'breakpointCount' | 'threadCount' | 'pausedLine' | 'pausedFile' | 'memoryKB' | 'error'>>) {
    const s = this.sessions.get(id);
    if (s) {
      Object.assign(s, patch);
      this.emit();
    }
  }

  remove(id: string) {
    this.sessions.delete(id);
    this.emit();
  }

  pauseAll() {
    for (const s of this.sessions.values()) {
      if (s.status === 'running') s.status = 'stopped';
    }
    this.emit();
  }

  resumeAll() {
    for (const s of this.sessions.values()) {
      if (s.status === 'stopped') s.status = 'running';
    }
    this.emit();
  }

  stopAll() {
    for (const s of this.sessions.values()) {
      if (s.status !== 'exited' && s.status !== 'error') {
        s.status = 'exited';
      }
    }
    this.emit();
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
