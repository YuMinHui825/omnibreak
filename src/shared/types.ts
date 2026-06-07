import { DebugProtocol } from '@vscode/debugprotocol';

export interface DeviceConfig {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  sshAuth: 'password' | 'key';
  sshKeyPath?: string;
  gdbPath: string;
  arch: 'arm64' | 'x86_64' | 'auto';
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface HealthCheck {
  type: 'port' | 'file' | 'socket';
  value: string;
}

export interface DebugTarget {
  processName: string;
  debug: boolean;
  useSudo: boolean;
  binaryPath?: string;
  startCommand?: string;
  envVars?: Record<string, string>;
  container?: string;
  healthCheck?: HealthCheck;
}

export interface DeployFile {
  localPath: string;
  remotePath: string;
  chmod: boolean;
}

export type DebugMode = 'restart-and-debug' | 'attach-only';

export interface OrchestrationConfig {
  deviceId: string;
  mode: DebugMode;
  restartCommand: string;
  useSudoForRestart: boolean;
  targets: DebugTarget[];
  envVars: Record<string, string>;
  timeout: number;
  preBuildCommand: string;
  deployFiles: DeployFile[];
  remoteLogPaths?: string[];
}

export type SessionStatus = 'pending' | 'running' | 'stopped' | 'paused' | 'exited' | 'error';

export interface SessionState {
  id: string;
  targetName: string;
  status: SessionStatus;
  pid?: number;
  gdbserverPort: number;
  breakpointCount: number;
  threadCount: number;
  pausedLine?: number;
  pausedFile?: string;
  memoryKB?: number;
  error?: string;
  startedAt: number;
}

export interface ProcessStats {
  processName: string;
  pid: number;
  cpuPercent: number;
  rssMB: number;
  vszMB: number;
  threadCount: number;
  state: string;
  gpuPercent?: number;
  gpuMemMB?: number;
}

export interface SystemStats {
  processes: ProcessStats[];
  ts: number;
}

export interface MemorySnapshot {
  heapKB: number;
  stackKB: number;
  dataKB: number;
  rssKB: number;
  vszKB: number;
  ts: number;
}

export interface LeakReport {
  processName: string;
  pid: number;
  current: MemorySnapshot;
  baseline?: MemorySnapshot;
  heapDeltaKB: number;
  rssGrowthRate: number;
  risk: 'none' | 'low' | 'medium' | 'high';
  sampleCount: number;
  startedAt: number;
}

/** Perfetto trace capture result */
export interface TraceCaptureResult {
  output: string;
  sizeBytes: number;
  remoteHost: string;
  durationSec: number;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface LogEntry {
  level: LogLevel;
  text: string;
  ts: number;
}

export interface OmniBreakConfig extends DebugProtocol.LaunchRequestArguments {
  targetHost: string;
  targetPort: number;
  sshUser: string;
  sshPort: number;
  sshPassword?: string;
  sudoPassword?: string;
  binaryPath: string;
  gdbPath: string;
  symbolFile?: string;
  sourceFileMap: Record<string, string>;
  nonStopMode: boolean;
  deploySource?: string;
  autoDeploy?: boolean;
  remoteLogPath?: string;
  processName?: string;
  pid?: number;
  solibSearchPath?: string;
  useSudo?: boolean;
  skipGdbserverStart?: boolean;
  envVars?: Record<string, string>;
  localBinaryPath?: string;
  remoteBinaryPath?: string;
  robotHost?: string;
  robotPort?: number;
}

export interface MiResult {
  token: number;
  class: 'done' | 'error' | 'running' | 'connected';
  data: string;
}

export interface MiAsyncRecord {
  token: number;
  type: 'exec' | 'notify' | 'status' | 'console' | 'target' | 'log';
  class: string;
  data: string;
}
