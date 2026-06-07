import type { DeviceConfig, OrchestrationConfig, SessionState, LogEntry, SystemStats, LeakReport, TraceCaptureResult } from './types';

export type WebviewMsg =
  | { type: 'load-devices' }
  | { type: 'save-device'; device: DeviceConfig; sshPassword?: string; sudoPassword?: string }
  | { type: 'delete-device'; id: string }
  | { type: 'test-connection'; deviceId: string }
  | { type: 'start-debug'; config: OrchestrationConfig }
  | { type: 'disconnect'; deviceId: string }
  | { type: 'request-stats' }
  | { type: 'request-leak-scan' }
  | { type: 'start-leak-monitor' }
  | { type: 'stop-leak-monitor' }
  | { type: 'start-trace'; duration: number; useSudo: boolean; startCmd?: string };

export type ExtMsg =
  | { type: 'devices-loaded'; devices: DeviceConfig[] }
  | { type: 'connection-test-result'; deviceId: string; ok: boolean; info: string }
  | { type: 'session-update'; sessions: SessionState[] }
  | { type: 'log'; entry: LogEntry }
  | { type: 'connection-lost'; deviceId: string }
  | { type: 'stats-update'; stats: SystemStats | null }
  | { type: 'leak-update'; report: LeakReport | null }
  | { type: 'trace-result'; result: TraceCaptureResult | null; error?: string };
