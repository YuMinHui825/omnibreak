import { Client, ClientChannel } from 'ssh2';
import { EventEmitter } from 'events';
import { GdbMiParser } from './gdbMiParser';
import { MiResult, MiAsyncRecord } from '../shared/types';
import { logger } from '../shared/logging';

export declare interface GdbMiClient {
  on(event: 'stopped', listener: (data: string) => void): this;
  on(event: 'running', listener: (data: string) => void): this;
  on(event: 'output', listener: (category: string, text: string) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
}

export interface GdbLaunchOptions {
  gdbPath: string;
  sshRemote?: { host: string; user: string; port?: number; password?: string; keyPath?: string };
}

export class GdbMiClient extends EventEmitter {
  private sshClient: Client | null = null;
  private gdbStream: ClientChannel | null = null;
  private parser: GdbMiParser;
  private token = 0;
  private pending = new Map<number, { resolve: (r: MiResult) => void; reject: (e: Error) => void }>();
  private cmdQueue: Array<{ cmd: string; resolve: (r: MiResult) => void; reject: (e: Error) => void }> = [];
  private processing = false;
  private isAlive = false;

  constructor(private opts: GdbLaunchOptions) {
    super();
    this.parser = new GdbMiParser();
    this.parser.onResult((r) => this.handleResult(r));
    this.parser.onRecord((r) => this.handleRecord(r));
  }

  get alive(): boolean { return this.isAlive; }

  async init(): Promise<void> {
    await this.launch();
    await this.sendCommand('-gdb-set mi-async on');
    logger.info('GDB/MI async mode enabled');
  }

  // ═══ SSH2-based launch ═══
  async launch(): Promise<void> {
    const gdbArgs = ['--interpreter=mi3', '--quiet'];

    if (this.opts.sshRemote) {
      const r = this.opts.sshRemote;
      this.sshClient = new Client();
      const config: any = {
        host: r.host, port: r.port || 22, username: r.user,
        readyTimeout: 15000, keepaliveInterval: 10000,
      };
      if (r.password) config.password = r.password;
      if (r.keyPath) config.privateKey = require('fs').readFileSync(r.keyPath);

      await new Promise<void>((resolve, reject) => {
        this.sshClient!.on('ready', () => resolve());
        this.sshClient!.on('error', (err) => reject(err));
        this.sshClient!.connect(config);
      });
      logger.info(`SSH connected to ${r.host}`);

      const fullCmd = `${this.opts.gdbPath} ${gdbArgs.join(' ')}`;
      logger.info(`Launching GDB via SSH2: ${fullCmd}`);

      await new Promise<void>((resolve, reject) => {
        this.sshClient!.exec(fullCmd, (err, stream) => {
          if (err) { reject(err); return; }
          this.gdbStream = stream;
          stream.stdout?.on('data', (chunk: Buffer) => { this.parser.feed(chunk.toString()); });
          stream.stderr?.on('data', (chunk: Buffer) => { this.emit('output', 'stderr', chunk.toString()); });
          stream.on('close', (code: number | null) => {
            logger.info(`GDB exited: code=${code}`);
            this.isAlive = false;
            this.emit('exit', code, null);
            for (const [, p] of this.pending) p.reject(new Error(`GDB exited`));
            this.pending.clear();
            this.cmdQueue = [];
          });
          setTimeout(() => { this.isAlive = true; resolve(); }, 500);
        });
      });
    } else {
      // Local GDB
      const { spawn } = require('child_process');
      const proc: any = spawn(this.opts.gdbPath, gdbArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
      logger.info(`Launching local GDB: ${this.opts.gdbPath}`);
      await new Promise<void>((resolve, reject) => {
        proc.stdout?.on('data', (chunk: Buffer) => { this.parser.feed(chunk.toString()); });
        proc.stderr?.on('data', (chunk: Buffer) => { this.emit('output', 'stderr', chunk.toString()); });
        proc.on('error', (err: Error) => { this.isAlive = false; reject(err); });
        proc.on('exit', (code: number | null, signal: string | null) => {
          this.isAlive = false; this.emit('exit', code, signal);
          for (const [, p] of this.pending) p.reject(new Error(`GDB exited`));
          this.pending.clear(); this.cmdQueue = [];
        });
        (this as any)._localProc = proc;
        setTimeout(() => { this.isAlive = true; resolve(); }, 300);
      });
    }
  }

  // ═══ Command queue ═══

  sendCommand(cmd: string): Promise<MiResult> {
    return new Promise((resolve, reject) => {
      this.cmdQueue.push({ cmd, resolve, reject });
      this.processQueue();
    });
  }

  async terminate(): Promise<void> {
    try { await this.sendCommand('-gdb-exit'); } catch {}
    if (this.sshClient) {
      try { this.sshClient.end(); } catch {}
    } else {
      const proc = (this as any)._localProc;
      if (proc && !proc.killed) { proc.kill('SIGTERM'); setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 2000); }
    }
  }

  private processQueue(): void {
    if (this.processing || this.cmdQueue.length === 0) return;
    this.processing = true;
    const item = this.cmdQueue.shift()!;
    this.token++;
    const token = this.token;
    const fullCmd = `${token}${item.cmd}\n`;
    this.pending.set(token, item);

    if (this.sshClient && this.gdbStream) {
      this.gdbStream.write(fullCmd);
    } else {
      const proc = (this as any)._localProc;
      if (proc) proc.stdin?.write(fullCmd);
    }
    this.processing = false;
    if (this.cmdQueue.length > 0) setImmediate(() => this.processQueue());
  }

  private handleResult(result: MiResult): void {
    const pending = this.pending.get(result.token);
    if (pending) {
      this.pending.delete(result.token);
      if (result.class === 'error') {
        const msgMatch = result.data.match(/msg="([^"]*)"/);
        pending.reject(new Error(msgMatch?.[1] || result.data));
      } else {
        pending.resolve(result);
      }
    }
  }

  private handleRecord(record: MiAsyncRecord): void {
    switch (record.type) {
      case 'exec':
        if (record.class === 'stopped') this.emit('stopped', record.data);
        else if (record.class === 'running') this.emit('running', record.data);
        break;
      case 'notify':
        this.emit('output', 'console', this.stripQuotes(record.data));
        break;
      case 'console': this.emit('output', 'console', this.stripQuotes(record.data)); break;
      case 'target': this.emit('output', 'target', this.stripQuotes(record.data)); break;
      case 'log': this.emit('output', 'log', this.stripQuotes(record.data)); break;
    }
  }

  private stripQuotes(data: string): string {
    const match = data.match(/^"([^]*)"$/);
    return match ? match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : data;
  }
}
