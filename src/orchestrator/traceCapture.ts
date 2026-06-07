import * as path from 'path';
import * as os from 'os';
import { SshConnection } from './SshConnection';

const REMOTE_TRACEBOX = '/tmp/omnibreak-tracebox';
const REMOTE_TRACE_FILE = '/tmp/omnibreak-trace.pftrace';
const REMOTE_TRACE_CFG = '/tmp/omnibreak-trace.cfg';

const GPU_PROBES: Record<string, string> = {
  i915: 'i915/i915_gem_request_submit',
  mali: 'mali/mali_job_slot_event',
  kgsl: 'kgsl/kgsl_pwrlevel',
  amdgpu: 'amdgpu/amdgpu_cs_ioctl',
  virtio_gpu: 'virtio_gpu/virtio_gpu_cmd_queue',
  v3d: 'v3d/v3d_submit_cl',
  panfrost: 'panfrost/panfrost_job_submit',
  etnaviv: 'etnaviv/etnaviv_submit',
  nouveau: 'nouveau/nouveau_fence_signaled',
  msm: 'msm/msm_gpu_submit',
  lima: 'lima/lima_submit',
  drm: 'drm/drm_vblank_event',
};

async function detectGpuEvents(ssh: SshConnection, useSudo: boolean, log: (msg: string) => void): Promise<string[]> {
  const events: string[] = [];
  try {
    const r = await ssh.exec('ls /sys/kernel/tracing/events/ 2>/dev/null', useSudo);
    const dirs = r.stdout.split('\n').map((s: string) => s.trim()).filter(Boolean);
    for (const [dir, event] of Object.entries(GPU_PROBES)) {
      if (dirs.includes(dir)) {
        events.push(event);
        log(`Detected GPU: ${dir} (${event})`);
      }
    }
  } catch {}
  return events;
}

function buildTraceConfig(durationSec: number, events: string): string {
  const eventList = events.split(' ').filter(e => e).map(e => `      ftrace_events: "${e}"`).join('\n');
  return [
    'buffers { size_kb: 4096 }',
    'data_sources {',
    '  config {',
    '    name: "linux.ftrace"',
    '    ftrace_config {',
    eventList,
    '      buffer_size_kb: 2048',
    '    }',
    '  }',
    '}',
    'data_sources {',
    '  config {',
    '    name: "linux.process_stats"',
    '    process_stats_config {',
    '      scan_all_processes_on_start: true',
    '      proc_stats_poll_ms: 1000',
    '    }',
    '  }',
    '}',
    'data_sources {',
    '  config {',
    '    name: "linux.system_info"',
    '  }',
    '}',
    `duration_ms: ${durationSec * 1000}`,
  ].join('\n');
}

export interface TraceConfig {
  durationSec: number;
  outputPath?: string;
  events?: string;
  useSudo: boolean;
  startCmd?: string;
}

export interface TraceCaptureResult {
  output: string;
  sizeBytes: number;
  remoteHost: string;
  durationSec: number;
}

export async function captureTrace(
  ssh: SshConnection,
  config: TraceConfig,
  log: (msg: string) => void,
): Promise<TraceCaptureResult> {
  // Step 1: Ensure tracebox exists on remote
  const exists = await ssh.exec(`test -x ${REMOTE_TRACEBOX} && echo yes || echo no`);
  if (!exists.stdout.includes('yes')) {
    log('Downloading tracebox on remote (first time, ~20MB)...');
    const curlR = await ssh.exec(`curl -fsSL -o ${REMOTE_TRACEBOX} https://get.perfetto.dev/tracebox && chmod +x ${REMOTE_TRACEBOX}`, false, 120000);
    if (curlR.exitCode !== 0) {
      throw new Error(`Failed to download tracebox: ${curlR.stderr || curlR.stdout}`);
    }
    log('Tracebox downloaded on remote');
  }

  // Step 2: Auto-detect GPU events
  let gpuEvents: string[] = [];
  if (!config.events) {
    gpuEvents = await detectGpuEvents(ssh, config.useSudo, log);
  }

  // Step 3: Write trace config to remote
  let events = config.events || 'sched/sched_switch sched/sched_waking sched/sched_process_exec sched/sched_process_fork sched/sched_process_exit sched/sched_wakeup_new';
  if (gpuEvents.length > 0) {
    events += ' ' + gpuEvents.join(' ');
    log(`Including GPU events: ${gpuEvents.join(' ')}`);
  }
  const cfg = buildTraceConfig(config.durationSec, events);
  const cfgB64 = Buffer.from(cfg).toString('base64');
  await ssh.exec(`echo ${cfgB64} | base64 -d > ${REMOTE_TRACE_CFG}`);

  // Step 3: Run trace capture
  const cmd = `${REMOTE_TRACEBOX} -c ${REMOTE_TRACE_CFG} --txt -o ${REMOTE_TRACE_FILE} --background`;

  let remoteCmd: string;
  if (config.startCmd) {
    remoteCmd = `${cmd} && sleep 1 && ${config.startCmd} && sleep ${config.durationSec}`;
  } else {
    remoteCmd = `${cmd} && sleep ${config.durationSec}`;
  }

  log(`Capturing trace for ${config.durationSec}s...`);
  if (config.startCmd) {
    log(`Running: ${config.startCmd}`);
  }

  const r = await ssh.exec(remoteCmd, config.useSudo, (config.durationSec + 60) * 1000);
  if (r.exitCode !== 0 && r.exitCode !== null && !config.useSudo) {
    // tracebox --background may exit with 0 or null; only error on non-sudo paths with actual errors
  }

  // Step 4: Fix permissions if sudo was used
  if (config.useSudo) {
    await ssh.exec(`chmod 644 ${REMOTE_TRACE_FILE}`, true);
  }

  // Step 5: Pull trace file
  const outputPath = config.outputPath || path.join(os.homedir(), 'trace.pftrace');
  log('Fetching trace file...');
  await ssh.pullFile(REMOTE_TRACE_FILE, outputPath);

  // Step 6: Clean up remote
  try {
    await ssh.exec(`rm -f ${REMOTE_TRACE_FILE} ${REMOTE_TRACE_CFG}`, config.useSudo);
  } catch {}

  const fs = require('fs');
  const sizeBytes = fs.statSync(outputPath).size;
  log(`Trace saved: ${outputPath} (${(sizeBytes / 1024).toFixed(1)} KB)`);

  return { output: outputPath, sizeBytes, remoteHost: (ssh as any).opts?.host || 'unknown', durationSec: config.durationSec };
}
