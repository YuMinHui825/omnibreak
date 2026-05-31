import { Client } from 'ssh2';

export interface SshOpts {
  host: string; port: number; user: string;
  password?: string; sudoPassword?: string;
  keyPath?: string; keyPassword?: string;
}

export interface CmdResult { stdout: string; stderr: string; exitCode: number | null; }

export class SshConnection {
  private client: Client;
  private _connected = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: SshOpts) {
    this.client = new Client();
    this.client.on('close', () => { this._connected = false; this.stopHeartbeat(); });
    this.client.on('error', (err: Error) => { console.error('[OmniBreak SSH]', err.message); });
  }

  get connected(): boolean { return this._connected; }

  startHeartbeat(onLost: () => void) {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      try {
        const r = await this.exec('echo OK', false, 5000);
        if (r.exitCode !== 0 || !r.stdout.includes('OK')) {
          this._connected = false;
          this.stopHeartbeat();
          onLost();
        }
      } catch {
        this._connected = false;
        this.stopHeartbeat();
        onLost();
      }
    }, 5000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private async connect(): Promise<void> {
    if (this._connected) return;
    return new Promise((resolve, reject) => {
      const config: any = {
        host: this.opts.host, port: this.opts.port, username: this.opts.user,
        readyTimeout: 10000, keepaliveInterval: 10000,
      };
      if (this.opts.password) config.password = this.opts.password;
      if (this.opts.keyPath) config.privateKey = require('fs').readFileSync(this.opts.keyPath);
      if (this.opts.keyPassword) config.passphrase = this.opts.keyPassword;
      this.client.once('ready', () => { this._connected = true; resolve(); });
      this.client.once('error', (err) => { reject(err); });
      this.client.connect(config);
    });
  }

  async exec(cmd: string, useSudo = false, timeout = 30000): Promise<CmdResult> {
    try { await this.connect(); } catch (e: any) { return { stdout: '', stderr: `SSH failed: ${e.message}`, exitCode: 1 }; }
    const fullCmd = useSudo && this.opts.sudoPassword
      ? `echo '${this.opts.sudoPassword.replace(/'/g, "'\\''")}' | sudo -S ${cmd}`
      : cmd;
    return new Promise((resolve) => {
      this.client.exec(fullCmd, (err, stream) => {
        if (err) { resolve({ stdout: '', stderr: err.message, exitCode: 1 }); return; }
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { stream.close(); resolve({ stdout, stderr, exitCode: -1 }); }, timeout);
        stream.on('data', (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        stream.on('close', (code: number | null) => { clearTimeout(timer); resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code }); });
        stream.on('error', (e: Error) => { clearTimeout(timer); resolve({ stdout: stdout.trim(), stderr: e.message, exitCode: 1 }); });
      });
    });
  }

  async streamExec(cmd: string, onData: (text: string) => void): Promise<{ close: () => void }> {
    await this.connect();
    return new Promise((resolve, reject) => {
      this.client.exec(cmd, (err, stream) => {
        if (err) { reject(err); return; }
        stream.on('data', (d: Buffer) => onData(d.toString()));
        stream.stderr.on('data', (d: Buffer) => onData(d.toString()));
        const closer = () => { try { stream.close(); } catch {} };
        resolve({ close: closer });
        stream.on('error', () => {});
      });
    });
  }

  async scp(localPath: string, remotePath: string, timeout = 60000): Promise<void> {
    try { await this.connect(); } catch (e: any) { throw new Error(`SSH failed: ${e.message}`); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('SCP timeout')); }, timeout);
      this.client.sftp((err, sftp) => {
        if (err) { clearTimeout(timer); reject(err); return; }
        const content = require('fs').readFileSync(localPath);
        const ws = sftp.createWriteStream(remotePath);
        ws.on('close', () => { clearTimeout(timer); resolve(); });
        ws.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
        ws.end(content);
      });
    });
  }

  async close(): Promise<void> {
    this.stopHeartbeat();
    return new Promise((resolve) => {
      if (!this._connected) { resolve(); return; }
      const timer = setTimeout(() => { this._connected = false; try { this.client.end(); } catch {} resolve(); }, 2000);
      this.client.once('close', () => { clearTimeout(timer); this._connected = false; resolve(); });
      try { this.client.end(); } catch { clearTimeout(timer); this._connected = false; resolve(); }
    });
  }

  async testGdb(): Promise<{ ok: boolean; version: string }> {
    const r = await this.exec('gdb --version 2>/dev/null || gdb-multiarch --version 2>/dev/null || echo NOT_FOUND');
    return r.stdout.includes('NOT_FOUND') ? { ok: false, version: 'GDB not found' } : { ok: true, version: r.stdout.split('\n')[0] || r.stdout };
  }

  async testConnection(): Promise<{ ok: boolean; info: string }> {
    try {
      const r = await this.exec('echo OK && uname -m');
      if (r.exitCode === 0 && r.stdout.includes('OK')) return { ok: true, info: `Connected. Arch: ${r.stdout.split('\n')[1] || '?'}` };
      return { ok: false, info: r.stderr || r.stdout || 'Connection failed' };
    } catch (e: any) { return { ok: false, info: e.message }; }
  }
}
