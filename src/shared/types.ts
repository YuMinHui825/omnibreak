import { DebugProtocol } from '@vscode/debugprotocol';

export interface OmniBreakConfig extends DebugProtocol.LaunchRequestArguments {
  targetHost: string;
  targetPort: number;
  sshUser: string;
  sshPort: number;
  sshPassword?: string;
  binaryPath: string;
  symbolFile?: string;
  gdbPath: string;
  sourceFileMap: Record<string, string>;
  nonStopMode: boolean;
  deploySource?: string;
  autoDeploy?: boolean;
  remoteLogPath?: string;
  processName?: string;
  pid?: number;
  solibSearchPath?: string;
  skipGdbserverStart?: boolean;
  // Legacy
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
