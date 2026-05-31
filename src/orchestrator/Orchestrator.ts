import { execSync } from 'child_process';
import { SshConnection, SshOpts } from './SshConnection';
import { ProcessScanner } from './ProcessScanner';
import { SessionManager } from './SessionManager';
import type { DeviceConfig, OrchestrationConfig, LogEntry, SessionState } from '../shared/types';
import { DEFAULT_GDBSERVER_BASE_PORT } from '../shared/constants';

export type LogCallback = (entry: LogEntry) => void;
export type SessionsCallback = (sessions: SessionState[]) => void;

export class Orchestrator {
  private ssh: SshConnection | null = null;
  private _testSsh: SshConnection | null = null;
  private scanner: ProcessScanner | null = null;
  private sessions: SessionManager | null = null;
  private onLog: LogCallback | null = null;
  private onSessions: SessionsCallback | null = null;
  private onConnectionLost: (() => void) | null = null;
  private workspaceRoot = '';
  private tailClosers: Array<{ close: () => void }> = [];

  setLogCallback(cb: LogCallback) { this.onLog = cb; }
  setSessionsCallback(cb: SessionsCallback) { this.onSessions = cb; }
  setConnectionLostCallback(cb: () => void) { this.onConnectionLost = cb; }
  setWorkspaceRoot(root: string) { this.workspaceRoot = root; }

  private log(level: LogEntry['level'], text: string) {
    if (this.onLog) this.onLog({ level, text, ts: Date.now() });
  }
  private emitSessions() {
    if (this.onSessions) this.onSessions(this.sessions?.all ?? []);
  }

  async testConnection(device: DeviceConfig, sshPassword?: string): Promise<{ ok: boolean; info: string }> {
    if (this._testSsh) { try { await this._testSsh.close(); } catch {} }
    this._testSsh = new SshConnection(this.deviceToSshOpts(device, sshPassword));
    this.log('info', `Connecting to ${device.host}:${device.sshPort}...`);
    const result = await this._testSsh.testConnection();
    if (result.ok) {
      this.log('success', `Connected to ${device.host} — ${result.info}`);
      this._testSsh.startHeartbeat(() => {
        this.log('error', 'Heartbeat lost — ' + device.host + ' is down');
        this._testSsh = null;
        if (this.onConnectionLost) this.onConnectionLost();
      });
    } else {
      this.log('error', `Connection failed: ${result.info}`);
      try { await this._testSsh.close(); } catch {}
      this._testSsh = null;
    }
    return result;
  }

  async start(config: OrchestrationConfig, device: DeviceConfig, sshPassword?: string, sudoPassword?: string): Promise<Array<{name:string;port:number;pid:number;binaryPath?:string}>|void> {
    const opts = this.deviceToSshOpts(device, sshPassword, sudoPassword);
    this.ssh = new SshConnection(opts);
    this.scanner = new ProcessScanner(this.ssh);
    this.sessions = new SessionManager(DEFAULT_GDBSERVER_BASE_PORT);
    this.sessions.onChange(() => this.emitSessions());

    const cr = await this.ssh.testConnection();
    if (!cr.ok) { this.log('error', `SSH failed: ${cr.info}`); return; }
    this.log('success', `SSH connected. ${cr.info}`);

    const gr = await this.ssh.testGdb();
    if (!gr.ok) { this.log('error', `GDB not found: ${gr.version}`); return; }
    this.log('success', `GDB: ${gr.version}`);

    if (config.preBuildCommand) {
      this.log('info', `Building: ${config.preBuildCommand}`);
      try { execSync(config.preBuildCommand, { cwd: this.workspaceRoot || undefined, stdio: 'pipe', timeout: 120000 }); this.log('success', 'Build done'); }
      catch (e: any) { this.log('error', `Build failed: ${e.stderr || e.message}`); return; }
    }
    if (config.deployFiles.length > 0) {
      this.log('info', `Deploying ${config.deployFiles.length} file(s)...`);
      for (const f of config.deployFiles) {
        const local = f.localPath.replace('${workspaceFolder}', this.workspaceRoot);
        try { await this.ssh!.scp(local, f.remotePath); if (f.chmod) await this.ssh!.exec(`chmod +x ${f.remotePath}`, false, 5000); this.log('success', '  deployed: ' + f.remotePath); }
        catch (e: any) { this.log('error', '  deploy failed ' + local + ': ' + e.message); }
      }
    }
    if (config.mode === 'restart-and-debug' && config.restartCommand) {
      this.log('info', `Restart: ${config.restartCommand}`);
      try { const r = await this.ssh.exec(config.restartCommand, config.useSudoForRestart, 60000); if (r.exitCode !== 0) { this.log('error', `Restart failed: ${r.stderr || r.stdout}`); return; } this.log('success', 'Restart done'); }
      catch (e: any) { this.log('error', `Restart failed: ${e.message}`); return; }
    }
    for (const t of config.targets) {
      if (t.startCommand) {
        const ep = t.envVars ? Object.entries(t.envVars).map(([k,v]) => `export ${k}=${v}`).join(' && ') + ' && ' : '';
        this.log('info', `Starting ${t.processName}: ${ep}${t.startCommand}`);
        try { await this.ssh!.exec(ep + t.startCommand, t.useSudo, 30000); this.log('success', t.processName + ' started'); }
        catch (e: any) { this.log('warn', t.processName + ' start: ' + e.message); }
      }
    }

    const debugTargets = config.targets.filter(t => t.debug);
    if (!debugTargets.length) { this.log('warn', 'No processes selected'); return []; }

    this.log('info', `Waiting for ${debugTargets.length} process(es)...`);
    const started: Array<{id:string;port:number;name:string;pid:number;binaryPath?:string}> = [];
    for (const t of debugTargets) {
      const session = this.sessions.add(t.processName);
      const pid = await this.scanner!.waitForProcess(t, config.timeout);
      if (pid === null) { this.sessions.update(session.id, { status: 'error', error: `Timeout (${config.timeout}s)` }); this.log('error', t.processName + ': timeout'); continue; }
      this.sessions.update(session.id, { status: 'running', pid });
      this.log('success', t.processName + ': PID ' + pid);
      started.push({ id: session.id, port: session.gdbserverPort, name: t.processName, pid, binaryPath: t.binaryPath });
    }
    if (!started.length) { this.log('error', 'No processes started'); return []; }

    const result: Array<{name:string;port:number;pid:number;binaryPath?:string}> = [];
    for (const s of started) {
      try {
        const useSudo = config.targets.find(t => t.processName === s.name)?.useSudo ?? false;
        await this.ssh!.exec(`pkill -x gdbserver 2>/dev/null || true; gdbserver --multi :${s.port} &>/tmp/omnibreak-gdb-${s.name}.log &`, useSudo, 10000);
        this.log('success', `gdbserver :${s.port} for ${s.name}`);
        this.sessions!.update(s.id, { status: 'running' });
        result.push({ name: s.name, port: s.port, pid: s.pid, binaryPath: s.binaryPath });
      } catch (e: any) { this.log('error', `gdbserver failed for ${s.name}: ${e.message}`); this.sessions!.update(s.id, { status: 'error', error: e.message }); }
    }
    this.log('success', `Debugging: ${result.length} session(s) active`);
    if (config.remoteLogPaths?.length) await this.startLogTails(config.remoteLogPaths);
    this.emitSessions();
    return result;
  }

  getSessionManager(): SessionManager | null { return this.sessions; }
  getSshConnection(): SshConnection | null { return this.ssh; }

  async startLogTails(paths: string[]): Promise<void> {
    for (const p of paths) {
      const name = p.split('/').pop() || p;
      try {
        const h = await this.ssh!.streamExec(`tail -f "${p}" 2>/dev/null`, (text) => {
          this.log('info', `[${name}] ${text.trim()}`);
        });
        this.tailClosers.push(h);
        this.log('success', `Tailing: ${name}`);
      } catch (e: any) { this.log('warn', `tail ${name}: ${e.message}`); }
    }
  }

  stopLogTails(): void {
    for (const s of this.tailClosers) { try { s.close(); } catch {} }
    this.tailClosers = [];
  }

  async stop(): Promise<void> {
    this.stopLogTails();
    if (this._testSsh) { this.log('info', 'Closing test connection...'); try { await this._testSsh.close(); this.log('success', 'SSH test connection closed'); } catch (e: any) { this.log('error', 'Close: ' + e.message); } this._testSsh = null; }
    if (this.ssh) { this.log('info', 'Stopping gdbserver...'); try { await this.ssh.exec('pkill -x gdbserver 2>/dev/null || true', true, 5000); this.log('success', 'gdbserver stopped'); } catch (e: any) { this.log('warn', 'gdbserver: ' + e.message); } this.log('info', 'Closing SSH...'); try { await this.ssh.close(); this.log('success', 'SSH disconnected'); } catch (e: any) { this.log('error', 'SSH close: ' + e.message); } this.ssh = null; }
    this.sessions?.stopAll(); this.emitSessions();
  }

  private deviceToSshOpts(device: DeviceConfig, sshPassword?: string, sudoPassword?: string): SshOpts {
    return { host: device.host, port: device.sshPort, user: device.sshUser, password: sshPassword, sudoPassword, keyPath: device.sshKeyPath };
  }
}
