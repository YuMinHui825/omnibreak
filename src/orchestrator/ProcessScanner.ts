import { SshConnection } from './SshConnection';
import type { DebugTarget, HealthCheck } from '../shared/types';

export interface ProcessInfo {
  pid: number;
  name: string;
  ppid: number;
  cmdline: string;
}

export class ProcessScanner {
  constructor(private ssh: SshConnection) {}

  async findProcess(processName: string, container?: string): Promise<number | null> {
    const cmd = container
      ? `docker exec ${container} pgrep -f "${processName}" | head -1`
      : `pgrep -f "${processName}" | head -1`;
    try {
      const result = await this.ssh.exec(cmd, false, 5000);
      const pid = parseInt(result.stdout.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  async waitForProcess(
    target: DebugTarget,
    timeout: number,
  ): Promise<number | null> {
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      const pid = await this.findProcess(target.processName, target.container);
      if (pid !== null) {
        if (!target.healthCheck || await this.checkHealth(target.healthCheck, target.container)) {
          return pid;
        }
      }
      await sleep(1000);
    }
    return null;
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    try {
      const result = await this.ssh.exec('ps -eo pid,ppid,comm,args --no-headers 2>/dev/null || ps aux | awk \'{print $2, $3, $11, $0}\'', false, 5000);
      const procs: ProcessInfo[] = [];
      for (const line of result.stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          procs.push({
            pid: parseInt(parts[0], 10),
            ppid: parseInt(parts[1], 10) || 0,
            name: parts[2],
            cmdline: parts.slice(3).join(' ') || parts[2],
          });
        }
      }
      return procs;
    } catch {
      return [];
    }
  }

  private async checkHealth(hc: HealthCheck, container?: string): Promise<boolean> {
    let cmd = '';
    switch (hc.type) {
      case 'port':
        cmd = container
          ? `docker exec ${container} curl -s -o /dev/null -w '%{http_code}' ${hc.value} 2>/dev/null`
          : `curl -s -o /dev/null -w '%{http_code}' ${hc.value} 2>/dev/null`;
        break;
      case 'file':
        cmd = `test -f ${hc.value} && echo OK`;
        break;
      case 'socket':
        cmd = `test -S ${hc.value} && echo OK`;
        break;
    }
    try {
      const result = await this.ssh.exec(cmd, false, 5000);
      return result.stdout.includes('200') || result.stdout.includes('OK');
    } catch {
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
