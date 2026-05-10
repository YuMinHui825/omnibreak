import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, ContinuedEvent, OutputEvent, Thread, StackFrame, Scope, Source, Handles } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { GdbMiClient, GdbLaunchOptions } from './gdbMiClient';
import { parseBreakpoint, parseThreadInfo, parseFrames, parseVariables } from './gdbMiParser';
import { SourceMapper } from './sourceMapper';
import { OmniBreakConfig } from '../shared/types';

class OmniBreakSession extends DebugSession {
  private gdb: GdbMiClient | null = null;
  private firstStop = true;
  private launchResolve: (() => void) | null = null;
  private binaryLoaded = false;
  private pendingBreakpoints: DebugProtocol.SetBreakpointsArguments[] = [];
  private variableHandles = new Handles<{ name: string; value: string; scope: string }>();
  private sourceMapper = new SourceMapper({});

  constructor() { super(); this.setDebuggerLinesStartAt1(false); this.setDebuggerColumnsStartAt1(false); }

  protected initializeRequest(r: DebugProtocol.InitializeResponse, _a: DebugProtocol.InitializeRequestArguments): void {
    r.body = r.body || {};
    r.body.supportsConfigurationDoneRequest = true;
    r.body.supportsConditionalBreakpoints = true;
    r.body.supportsEvaluateForHovers = true;
    this.sendResponse(r);
    this.sendEvent(new InitializedEvent());
  }

  private resolve(cfg: OmniBreakConfig) {
    return {
      host: cfg.targetHost || cfg.robotHost || 'localhost',
      port: cfg.targetPort || cfg.robotPort || 2345, user: cfg.sshUser || 'root',
      sshPort: cfg.sshPort || 22, pwd: cfg.sshPassword,
      gdb: cfg.gdbPath || '/usr/bin/gdb-multiarch',
      bin: cfg.symbolFile || cfg.localBinaryPath || cfg.binaryPath || '',
      rbin: cfg.binaryPath || cfg.remoteBinaryPath || '',
      nonStop: cfg.nonStopMode !== false,
    };
  }

  private setupGdbEvents(): void {
    if (!this.gdb) return;
    this.gdb.on('stopped', (d) => {
      if (d.includes('exited-normally') || d.includes('exited-signalled')) return;
      let reason: 'breakpoint' | 'step' | 'pause' | 'exception' = 'pause';
      const m = d.match(/thread-id="(\d+)"/);
      if (d.includes('breakpoint-hit')) reason = 'breakpoint';
      else if (d.includes('end-stepping-range')) reason = 'step';
      else if (d.includes('signal-received')) {
        reason = 'exception';
        this.gdb!.sendCommand('-stack-list-frames 0 500').then(r => {
          this.sendEvent(new OutputEvent('\n=== CRASH BACKTRACE ===\n', 'console'));
          for (const f of require('./gdbMiParser').parseFrames(r.data)) {
            const ff = f['fullname'] || f['file'] || '??';
            const lp = this.sourceMapper.compileToLocal(ff);
            this.sendEvent(new OutputEvent(`#${f['level']} ${f['func']} at ${lp || ff}:${f['line']}\n`, 'console'));
          }
        }).catch(() => {});
      }
      this.sendEvent(new StoppedEvent(reason, m ? parseInt(m[1], 10) : undefined));
      if (this.firstStop) { this.firstStop = false; this.launchResolve?.(); }
    });
    this.gdb.on('running', (d) => {
      if (this.firstStop) return;
      const m = d.match(/thread-id="(\d+)"/);
      this.sendEvent(new ContinuedEvent(m ? parseInt(m[1], 10) : 0, true));
    });
    this.gdb.on('output', (cat, text) => this.sendEvent(new OutputEvent(text, cat)));
    this.gdb.on('exit', () => this.sendEvent(new TerminatedEvent()));
  }

  private sshExec(c: ReturnType<typeof this.resolve>, cmd: string): void {
    const { execSync } = require('child_process');
    const pfx = c.pwd
      ? `sshpass -p '${c.pwd}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${c.sshPort} ${c.user}@${c.host}`
      : `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${c.sshPort} ${c.user}@${c.host}`;
    try { execSync(`${pfx} ${cmd}`, { timeout: 10000 }); } catch { /* best effort */ }
  }

  private async applyPendingBreakpoints(): Promise<void> {
    for (const args of this.pendingBreakpoints)
      for (const bp of args.breakpoints || []) {
        try {
          const lp = args.source.path || ''; const gp = lp ? this.sourceMapper.localToCompile(lp) : lp;
          await this.gdb!.sendCommand(bp.condition ? `-break-insert -f ${gp}:${bp.line} -c "${bp.condition}"` : `-break-insert -f ${gp}:${bp.line}`);
        } catch {}
      }
    this.pendingBreakpoints = [];
  }

  // ═══ LAUNCH ═══
  protected async launchRequest(r: DebugProtocol.LaunchResponse, args: OmniBreakConfig): Promise<void> {
    const c = this.resolve(args);
    this.sourceMapper = new SourceMapper(args.sourceFileMap || {});
    this.firstStop = true; this.pendingBreakpoints = []; this.binaryLoaded = false;
    const useSsh = c.host !== 'localhost' && c.host !== '127.0.0.1';
    this.gdb = new GdbMiClient({ gdbPath: c.gdb, sshRemote: useSsh ? { host: c.host, user: c.user, port: c.sshPort } : undefined });
    this.setupGdbEvents();
    this.launchResolve = null;
    const wait = new Promise<void>((r) => { this.launchResolve = r; });

    try {
      await this.gdb.init();
      if (c.nonStop) await this.gdb.sendCommand('-gdb-set non-stop on');

      if (useSsh) {
        if (args.autoDeploy && args.deploySource) {
          this.sendEvent(new OutputEvent(`Deploying ${args.deploySource} -> ${c.host}:${c.rbin}...\n`, 'console'));
          try {
            const sc = c.pwd
              ? `sshpass -p '${c.pwd}' scp -o StrictHostKeyChecking=no ${args.deploySource} ${c.user}@${c.host}:${c.rbin}`
              : `scp -o StrictHostKeyChecking=no ${args.deploySource} ${c.user}@${c.host}:${c.rbin}`;
            require('child_process').execSync(sc, { timeout: 30000 });
            this.sendEvent(new OutputEvent('Deploy done\n', 'console'));
          } catch (e: any) { this.sendEvent(new OutputEvent(`Deploy failed: ${e.message}\n`, 'stderr')); }
        }

        // Auto-detect: try connecting first, start gdbserver if needed
        let gdbsrvRunning = false;
        try {
          await this.gdb.sendCommand(`-target-select remote localhost:${c.port}`);
          gdbsrvRunning = true;
          this.sendEvent(new OutputEvent(`Connected to existing gdbserver\n`, 'console'));
        } catch {
          try { await this.gdb.sendCommand(`-target-select extended-remote localhost:${c.port}`); gdbsrvRunning = true; this.sendEvent(new OutputEvent(`Connected to existing gdbserver (multi)\n`, 'console')); }
          catch { /* not running */ }
        }
        if (!gdbsrvRunning) {
          this.sendEvent(new OutputEvent(`Starting gdbserver on ${c.host}...\n`, 'console'));
          this.sshExec(c, `"pkill -x gdbserver 2>/dev/null || true; rm -f /tmp/omnibreak_output.log; setsid stdbuf -o0 gdbserver --multi :${c.port} >/tmp/omnibreak_output.log 2>&1 &"`);
          await new Promise<void>((r) => setTimeout(r, 1500));
          await this.gdb.sendCommand(`-target-select extended-remote localhost:${c.port}`);
        }

        const { spawn } = require('child_process');
        const targs = c.pwd
          ? ['sshpass', '-p', c.pwd, 'ssh', '-o', 'StrictHostKeyChecking=no', '-p', String(c.sshPort), `${c.user}@${c.host}`, 'tail -f /tmp/omnibreak_output.log']
          : ['ssh', '-o', 'StrictHostKeyChecking=no', '-p', String(c.sshPort), `${c.user}@${c.host}`, 'tail -f /tmp/omnibreak_output.log'];
        const tail = spawn(targs[0], targs.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        tail.stdout?.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) if (l.trim()) this.sendEvent(new OutputEvent(l + '\n', 'console')); });
        this.gdb!.on('exit', () => { try { tail.kill(); } catch {} });

        await this.gdb.sendCommand(`-target-select extended-remote localhost:${c.port}`);
        if (c.bin) { await this.gdb.sendCommand(`-file-exec-and-symbols ${c.bin}`); }
        
        this.binaryLoaded = true;
        await this.applyPendingBreakpoints();
        if (gdbsrvRunning) {
          // Already-running gdbserver — program is executing, just continue
          this.sendEvent(new OutputEvent('Program already running, continuing...\n', 'console'));
        } else {
          // We started gdbserver — set exec-file and start
          await this.gdb.sendCommand(`-interpreter-exec console "set remote exec-file ${c.rbin}"`);
          await this.gdb.sendCommand('-exec-run');
        }
      } else {
        if (c.bin) await this.gdb.sendCommand(`-file-exec-and-symbols ${c.bin}`);
        await this.gdb.sendCommand(`-target-select remote localhost:${c.port}`);
        this.binaryLoaded = true;
        await this.applyPendingBreakpoints();
      }
      this.sendResponse(r);
      await wait;
    } catch (err) { this.sendEvent(new OutputEvent(`Launch failed: ${err}\n`, 'stderr')); this.sendErrorResponse(r, 1, `Launch failed: ${err}`); }
  }

  // ═══ ATTACH ═══
  protected async attachRequest(r: DebugProtocol.AttachResponse, args: OmniBreakConfig): Promise<void> {
    const c = this.resolve(args);
    this.sourceMapper = new SourceMapper(args.sourceFileMap || {});
    this.firstStop = true; this.pendingBreakpoints = []; this.binaryLoaded = false;
    const useSsh = c.host !== 'localhost';
    this.gdb = new GdbMiClient({ gdbPath: c.gdb, sshRemote: useSsh ? { host: c.host, user: c.user, port: c.sshPort } : undefined });
    this.setupGdbEvents();
    this.launchResolve = null;
    const wait = new Promise<void>((r) => { this.launchResolve = r; });

    try {
      await this.gdb.init();
      if (c.nonStop) await this.gdb.sendCommand('-gdb-set non-stop on');
      if (args.solibSearchPath) await this.gdb.sendCommand(`-interpreter-exec console "set solib-search-path ${args.solibSearchPath}"`);
      if (c.bin) await this.gdb.sendCommand(`-file-exec-and-symbols ${c.bin}`);

      if (useSsh) {
        const { execSync } = require('child_process');
        const pfx = c.pwd
          ? `sshpass -p '${c.pwd}' ssh -o StrictHostKeyChecking=no -p ${c.sshPort} ${c.user}@${c.host}`
          : `ssh -o StrictHostKeyChecking=no -p ${c.sshPort} ${c.user}@${c.host}`;
        let pid = String(args.pid || '');
        if (!pid && args.processName) {
          try { pid = execSync(`${pfx} "pgrep -x '${args.processName}' | head -1"`, { timeout: 3000, encoding: 'utf8' }).trim(); } catch {}
        }
        if (!pid) throw new Error(`Process '${args.processName || ''}' not found`);
        this.sendEvent(new OutputEvent(`Attaching to PID ${pid} on ${c.host}...\n`, 'console'));
        this.sshExec(c, `"setsid stdbuf -o0 gdbserver --attach :${c.port} ${pid} >/tmp/omnibreak_output.log 2>&1 &"`);
        await new Promise<void>((r) => setTimeout(r, 1500));

        const { spawn } = require('child_process');
        const targs = c.pwd
          ? ['sshpass', '-p', c.pwd, 'ssh', '-o', 'StrictHostKeyChecking=no', '-p', String(c.sshPort), `${c.user}@${c.host}`, 'tail -f /tmp/omnibreak_output.log']
          : ['ssh', '-o', 'StrictHostKeyChecking=no', '-p', String(c.sshPort), `${c.user}@${c.host}`, 'tail -f /tmp/omnibreak_output.log'];
        const tail = spawn(targs[0], targs.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        tail.stdout?.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) if (l.trim()) this.sendEvent(new OutputEvent(l + '\n', 'console')); });
        this.gdb!.on('exit', () => { try { tail.kill(); } catch {} });

        await this.gdb.sendCommand(`-target-select extended-remote localhost:${c.port}`);
        this.binaryLoaded = true;
        await this.applyPendingBreakpoints();
      }
      this.sendResponse(r);
      await wait;
    } catch (err) { this.sendEvent(new OutputEvent(`Attach failed: ${err}\n`, 'stderr')); this.sendErrorResponse(r, 1, `Attach failed: ${err}`); }
  }

  // ═══ DAP HANDLERS ═══
  protected async setBreakPointsRequest(r: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
    if (!this.gdb) { this.sendResponse(r); return; }
    if (!this.binaryLoaded) { this.pendingBreakpoints.push(args); r.body = { breakpoints: (args.breakpoints || []).map(bp => ({ verified: false, line: bp.line })) }; this.sendResponse(r); return; }
    const bps: DebugProtocol.Breakpoint[] = [];
    for (const bp of args.breakpoints || []) {
      try {
        const lp = args.source.path || ''; const gp = lp ? this.sourceMapper.localToCompile(lp) : lp;
        const loc = gp ? `-f ${gp}:${bp.line}` : `${args.source.name}:${bp.line}`;
        const result = await this.gdb.sendCommand(bp.condition ? `-break-insert ${loc} -c "${bp.condition}"` : `-break-insert ${loc}`);
        const info = parseBreakpoint(result.data);
        bps.push({ id: parseInt(info.number || '0', 10), verified: true, line: parseInt(info.line || String(bp.line), 10) });
      } catch (err) { bps.push({ verified: false, line: bp.line, message: String(err) }); }
    }
    r.body = { breakpoints: bps }; this.sendResponse(r);
  }
  protected async configurationDoneRequest(r: DebugProtocol.ConfigurationDoneResponse): Promise<void> { this.sendResponse(r); }
  protected async continueRequest(r: DebugProtocol.ContinueResponse, a: DebugProtocol.ContinueArguments): Promise<void> { if (this.gdb) await this.gdb.sendCommand(a.threadId ? `-exec-continue --thread ${a.threadId}` : '-exec-continue'); this.sendResponse(r); }
  protected async nextRequest(r: DebugProtocol.NextResponse, a: DebugProtocol.NextArguments): Promise<void> { if (this.gdb) await this.gdb.sendCommand(a.threadId ? `-exec-next --thread ${a.threadId}` : '-exec-next'); this.sendResponse(r); }
  protected async stepInRequest(r: DebugProtocol.StepInResponse, a: DebugProtocol.StepInArguments): Promise<void> { if (this.gdb) await this.gdb.sendCommand(a.threadId ? `-exec-step --thread ${a.threadId}` : '-exec-step'); this.sendResponse(r); }
  protected async stepOutRequest(r: DebugProtocol.StepOutResponse, a: DebugProtocol.StepOutArguments): Promise<void> { if (this.gdb) await this.gdb.sendCommand(a.threadId ? `-exec-finish --thread ${a.threadId}` : '-exec-finish'); this.sendResponse(r); }
  protected async pauseRequest(r: DebugProtocol.PauseResponse): Promise<void> { if (this.gdb) await this.gdb.sendCommand('-exec-interrupt'); this.sendResponse(r); }
  protected async threadsRequest(r: DebugProtocol.ThreadsResponse): Promise<void> {
    if (!this.gdb) { this.sendResponse(r); return; }
    const threads: Thread[] = [];
    try { const result = await this.gdb.sendCommand('-thread-info'); for (const t of parseThreadInfo(result.data)) threads.push(new Thread(parseInt(t.id,10), `#${t.id} ${t.name||''}`)); } catch {}
    r.body = { threads }; this.sendResponse(r);
  }
  protected async stackTraceRequest(r: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
    if (!this.gdb) { this.sendResponse(r); return; }
    const frames: StackFrame[] = [];
    try {
      const result = await this.gdb.sendCommand(`-stack-list-frames --thread ${args.threadId} 0 20`);
      for (const f of parseFrames(result.data)) {
        const cp = f['fullname']||f['file']||''; const lp = this.sourceMapper.compileToLocal(cp);
        frames.push(new StackFrame(frames.length, `${f['func']||'??'} ${(lp||cp).split('/').pop()}:${f['line']}`, lp?new Source((lp||cp).split('/').pop()!,lp):undefined, parseInt(f['line']||'0',10), 0));
      }
    } catch {}
    r.body = { stackFrames: frames }; this.sendResponse(r);
  }
  protected async scopesRequest(r: DebugProtocol.ScopesResponse): Promise<void> { r.body={scopes:[new Scope('Local',this.variableHandles.create({name:'locals',value:'',scope:'local'}),false)]}; this.sendResponse(r); }
  protected async variablesRequest(r: DebugProtocol.VariablesResponse, _a: DebugProtocol.VariablesArguments): Promise<void> {
    if (!this.gdb) { this.sendResponse(r); return; }
    const vars: DebugProtocol.Variable[] = [];
    try { const result = await this.gdb.sendCommand('-stack-list-variables --simple-values'); for (const v of parseVariables(result.data)) vars.push({name:v['name']||'??',value:v['value']||'',variablesReference:0}); } catch {}
    r.body={variables:vars}; this.sendResponse(r);
  }
  protected async evaluateRequest(r: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
    if (!this.gdb) { this.sendResponse(r); return; }
    const expr = args.expression;
    try {
      if (expr.startsWith('!')) {
        // GDB CLI command: !bt, !info threads, !p var, etc.
        const cmd = expr.substring(1).trim();
        const result = await this.gdb.sendCommand(`-interpreter-exec console "${cmd}"`);
        // Extract console output
        const m = result.data.match(/^done/);
        r.body = { result: m ? `GDB: ${cmd} executed. See Debug Console for output.` : result.data, variablesReference: 0 };
      } else {
        const result = await this.gdb.sendCommand(`-data-evaluate-expression "${expr}"`);
        const m = result.data.match(/done,value="([^"]*)"/);
        r.body = { result: m ? m[1] : result.data, variablesReference: 0 };
      }
    } catch (err) { r.body = { result: `Error: ${err}`, variablesReference: 0 }; }
    this.sendResponse(r);
  }
  protected async disconnectRequest(r: DebugProtocol.DisconnectResponse): Promise<void> { if(this.gdb){await this.gdb.terminate();this.gdb=null;} this.sendResponse(r); }
}
OmniBreakSession.run(OmniBreakSession);
