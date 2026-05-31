import type { DeviceConfig, OrchestrationConfig, SessionState, LogEntry } from './types';

export type WebviewMsg =
  | { type: 'load-devices' }
  | { type: 'save-device'; device: DeviceConfig; sshPassword?: string; sudoPassword?: string }
  | { type: 'delete-device'; id: string }
  | { type: 'test-connection'; deviceId: string }
  | { type: 'start-debug'; config: OrchestrationConfig }
  | { type: 'disconnect'; deviceId: string };

export type ExtMsg =
  | { type: 'devices-loaded'; devices: DeviceConfig[] }
  | { type: 'connection-test-result'; deviceId: string; ok: boolean; info: string }
  | { type: 'session-update'; sessions: SessionState[] }
  | { type: 'log'; entry: LogEntry }
  | { type: 'connection-lost'; deviceId: string };
