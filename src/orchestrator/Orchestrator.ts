import { execSync } from 'child_process';
import { SshConnection, SshOpts } from './SshConnection';
import { ProcessScanner } from './ProcessScanner';
import { SessionManager } from './SessionManager';
import type { DeviceConfig, OrchestrationConfig, LogEntry, SessionState } from '../shared/types';
import { DEFAULT_GDBSERVER_BASE_PORT } from '../shared/constants';

const LEAK_MEDIUM_THRESHOLD_KB = 64;
const LEAK_HIGH_THRESHOLD_KB = 128;

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
  private leakSamples: Map<string, number[]> = new Map();

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
      // Correct PID: run ps to find the real binary (skip shell wrappers)
      const realPid = t.binaryPath ? await this.findRealPid(t.binaryPath, pid) : pid;
      if (realPid !== pid) this.log('info', t.processName + ': PID corrected ' + pid + ' -> ' + realPid);
      this.sessions.update(session.id, { status: 'running', pid: realPid });
      this.log('success', t.processName + ': PID ' + realPid);
      started.push({ id: session.id, port: session.gdbserverPort, name: t.processName, pid: realPid, binaryPath: t.binaryPath });
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
  getSshConnection(): SshConnection | null { return this.ssh || this._testSsh; }

  async collectLeakReport(baseline?: import('../shared/types').MemorySnapshot): Promise<import('../shared/types').LeakReport | null> {
    const ssh = this.ssh || this._testSsh;
    if (!ssh || !this.sessions) return null;
    const active = this.sessions.active.filter(s => s.pid);
    if (!active.length) return null;
    try {
      const s = active[0];
      const r = await ssh.exec(`grep -E '^(Vm|Rss)' /proc/${s.pid}/status 2>/dev/null; echo ===; cat /proc/${s.pid}/smaps 2>/dev/null | grep -E '^[0-9a-f]|^Size:|^Anonymous:' | head -120`, false, 5000);
      const parts = r.stdout.split('===');
      const status: Record<string,number> = {};
      (parts[0]||'').split('\n').forEach(line => {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if(m) status[m[1].toLowerCase()] = parseInt(m[2]);
      });
      let heapKB=0,stackKB=0,heapAnonKB=0;
      let curAddr='',curSize=0,curAnon=0,consumed=false;
      (parts[1]||'').split('\n').forEach(line => {
        const am=line.match(/^([0-9a-f]+)-/);
        if(am){
          if(!consumed&&curAddr.includes('[heap]')){heapKB+=curSize;heapAnonKB+=curAnon;}
          if(!consumed&&curAddr.includes('[stack]'))stackKB+=curSize;
          curAddr=line;curSize=0;curAnon=0;consumed=false;
        }
        const sm=line.match(/^Size:\s+(\d+)/); if(sm){curSize=parseInt(sm[1]);consumed=false}
        const an=line.match(/^Anonymous:\s+(\d+)/); if(an){curAnon=parseInt(an[1]);consumed=false}
      });
      if(!consumed){if(curAddr.includes('[heap]')){heapKB+=curSize;heapAnonKB+=curAnon;}if(curAddr.includes('[stack]'))stackKB+=curSize;}
      // Use heapAnonKB as primary metric (actual used pages, more sensitive)
      const heapMetric = heapAnonKB > 0 ? heapAnonKB : heapKB;
      const current: import('../shared/types').MemorySnapshot = {
        heapKB:heapMetric,stackKB,
        dataKB:(status.vmdata||0),
        rssKB:(status.vmrss||0),
        vszKB:(status.vmsize||0),
        ts:Date.now(),
      };
      // Rolling heap samples for trend detection
      const key = s.targetName;
      let samples = this.leakSamples.get(key) || [];
      samples.push(current.heapKB);
      if(samples.length > 60) samples = samples.slice(-60);
      this.leakSamples.set(key, samples);
      // Auto-detect: compare first vs last quartile
      let autoRisk: import('../shared/types').LeakReport['risk'] = 'none';
      if(samples.length >= 10) {
        const n = samples.length;
        const firstQ = samples.slice(0, Math.floor(n/4)).reduce((a,b)=>a+b,0) / Math.floor(n/4);
        const lastQ = samples.slice(-Math.floor(n/4)).reduce((a,b)=>a+b,0) / Math.floor(n/4);
        const growth = lastQ - firstQ;
        // Count how many points show growth vs first value
        let growing = 0;
        for(let i=1;i<n;i++) if(samples[i] > samples[0]) growing++;
        const growthRatio = growing / (n-1);
        if(growth > LEAK_HIGH_THRESHOLD_KB && growthRatio > 0.7) autoRisk = 'high';
        else if(growth > LEAK_MEDIUM_THRESHOLD_KB && growthRatio > 0.5) autoRisk = 'medium';
        else if(growth > 0 && growthRatio > 0.4) autoRisk = 'low';
      }
      const heapDeltaKB=baseline?current.heapKB-baseline.heapKB:0;
      const elapsed=baseline?(current.ts-baseline.ts)/1000:0;
      const rssGrowthRate=elapsed>0&&baseline?((current.rssKB-baseline.rssKB)/elapsed):0;
      const risk = autoRisk !== 'none' ? autoRisk :
        heapDeltaKB>1024||rssGrowthRate>100?'high':
        heapDeltaKB>256||rssGrowthRate>20?'medium':
        heapDeltaKB>0||rssGrowthRate>0?'low':'none';
      return {
        processName:s.targetName,pid:s.pid!,
        current,baseline,
        heapDeltaKB,rssGrowthRate,risk,
        sampleCount:samples.length,startedAt:baseline?.ts||current.ts,
      };
    } catch { return null; }
  }

  private async findRealPid(binaryPath: string, fallbackPid: number): Promise<number> {
    try {
      // Quick single-shot — if binary is already running, return it immediately
      const r = await this.ssh!.exec(`ps -e -o pid= -o args=`, false, 5000);
      for (const line of r.stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(.*)/);
        if (!m) continue;
        const p = parseInt(m[1], 10);
        if (m[2].startsWith(binaryPath)) return p;
      }
    } catch {}
    // Not found yet — schedule background retry every 2s, update session when found
    const sessionManager = this.sessions;
    this.schedulePidCorrection(binaryPath, fallbackPid, sessionManager);
    return fallbackPid;
  }

  private schedulePidCorrection(binaryPath: string, fallbackPid: number, sm: any, attempt = 0) {
    if (attempt > 10) return;
    setTimeout(async () => {
      try {
        const r = await this.ssh!.exec(`ps -e -o pid= -o args=`, false, 5000);
        for (const line of r.stdout.split('\n')) {
          const m = line.trim().match(/^(\d+)\s+(.*)/);
          if (!m) continue;
          const p = parseInt(m[1], 10);
          if (m[2].startsWith(binaryPath) && p !== fallbackPid) {
            this.log('info', 'PID corrected: ' + fallbackPid + ' -> ' + p);
            const session = sm.all.find((s: any) => s.pid === fallbackPid);
            if (session) sm.update(session.id, { pid: p });
            this.emitSessions();
            return;
          }
        }
        this.schedulePidCorrection(binaryPath, fallbackPid, sm, attempt + 1);
      } catch { this.schedulePidCorrection(binaryPath, fallbackPid, sm, attempt + 1); }
    }, 2000);
  }

  async collectStats(): Promise<import('../shared/types').SystemStats | null> {
    const ssh = this.ssh || this._testSsh;
    if (!ssh || !this.sessions) return null;
    const active = this.sessions.active.filter(s => s.pid);
    if (!active.length) return null;
    try {
      // Build a single command to query all PIDs at once
      const pidList = active.map(s => s.pid).join(' ');
      const cmds = [
        `for p in ${pidList}; do echo "PID:$p"; ps -p $p -o %cpu=,rss=,vsz=,nlwp=,stat= --no-headers 2>/dev/null || echo "- - - - -"; done`,
      ];
      // Try nvidia-smi for GPU processes (best-effort)
      cmds.push(`nvidia-smi --query-compute-apps=pid,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null || echo NO_GPU`);
      cmds.push(`tegrastats --interval 0 --count 1 2>/dev/null | head -1 || echo NO_TEGRA`);

      const [psR, gpuR] = await Promise.all([
        ssh.exec(cmds[0]),
        ssh.exec(`${cmds[1]}; echo GPU_SPLIT; ${cmds[2]}`),
      ]);

      // Parse GPU data: pid -> gpuUtil estimate
      const gpuPids: Record<number, number> = {};
      if (gpuR.stdout && !gpuR.stdout.includes('NO_GPU')) {
        const parts = gpuR.stdout.split('GPU_SPLIT');
        // nvidia-smi compute apps
        if (parts[0] && !parts[0].includes('NO_GPU')) {
          parts[0].trim().split('\n').forEach(line => {
            const f = line.split(',').map(s => s.trim());
            const pid = parseInt(f[0]);
            if (pid) gpuPids[pid] = (gpuPids[pid] || 0) + (parseInt(f[1]) || 0);
          });
        }
      }

      // Parse per-process stats
      const processes: import('../shared/types').ProcessStats[] = [];
      const blocks = psR.stdout.split('PID:').filter(b => b.trim());
      for (const block of blocks) {
        const lines = block.trim().split('\n');
        const pid = parseInt(lines[0]);
        const activeSession = active.find(s => s.pid === pid);
        if (!pid || !activeSession) continue;
        const vals = (lines[1] || '').trim().split(/\s+/);
        const cpuPercent = parseFloat(vals[0]) || 0;
        const rssKB = parseInt(vals[1]) || 0;
        const vszKB = parseInt(vals[2]) || 0;
        const threads = parseInt(vals[3]) || 0;
        const state = vals[4] || '?';
        processes.push({
          processName: activeSession.targetName,
          pid,
          cpuPercent: Math.round(cpuPercent * 10) / 10,
          rssMB: Math.round(rssKB / 1024 * 10) / 10,
          vszMB: Math.round(vszKB / 1024),
          threadCount: threads,
          state,
          gpuPercent: gpuPids[pid] || undefined,
          gpuMemMB: gpuPids[pid] || undefined,
        });
      }

      return { processes, ts: Date.now() };
    } catch {
      return null;
    }
  }

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
