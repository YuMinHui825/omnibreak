<p align="center"><img src="resources/omnibreak.png" width="128" alt="OmniBreak" /></p>

# OmniBreak

[:cn: 中文文档](README_CN.md)

> Visual remote debugging for Linux — break anywhere, any thread, any process.  
> Like Xcode for ARM64/x86 Linux. No launch.json, no remote agents. Just SSH.

## What is OmniBreak?

OmniBreak is a VSCode extension that gives you visual breakpoint debugging for remote Linux targets. You write code on your machine, the binary runs on a remote Linux box (robot, embedded device, cloud server), and you debug seamlessly in VSCode — full breakpoints, variable inspection, call stacks, thread control.

**No launch.json needed.** Everything is configured through a visual sidebar panel.

## How it works

```
Your Mac / PC                    Remote Linux Target
(VSCode + OmniBreak)             (binary runs here)
│                                │
│  Sidebar UI: add device ───────→ SSH connect + heartbeat
│  Config targets + deploy ──────→ SCP files, start commands
│  Click "Debug" ───────────────→ gdbserver --multi per process
│  VSCode Debug view ───────────→ GDB ↔ gdbserver ↔ binary
│                                │
└─ printf output ────────────────→ Remote logs tail in sidebar
```

All debugging runs through GDB on the target. No GDB needed locally. Zero external dependencies — pure Node.js `ssh2` library.

## Prerequisites

### Remote Target

```bash
sudo apt install -y gdbserver gdb-multiarch
```

That's it. Both packages are in standard Ubuntu/Debian repos.

### Your Machine (where VSCode runs)

- **VSCode 1.90+** — macOS, Linux, or Windows
- **Node.js 20+** — only if building from source

## Install

### Download & Install

```bash
code --install-extension omnibreak-0.2.0-beta.vsix
```

### Build from Source

```bash
git clone https://github.com/YuMinHui825/omnibreak.git
cd omnibreak
npm install
npm run compile
npm run package
code --install-extension omnibreak-0.2.0-beta.vsix
```

## Quick Start

### 1. Open OmniBreak sidebar

Click the OmniBreak icon in the VSCode activity bar.

### 2. Add a device

Click **+ Add Device**, fill in the remote target's IP, SSH user, and password. Credentials are stored encrypted in VSCode SecretStorage (macOS Keychain / system keyring).

### 3. Configure debug targets

Select a device, then add **Debug targets** — one per process you want to debug. Fill in:
- **Process name** — e.g. `host`
- **Binary path** — e.g. `/tmp/example/build/host`
- **Start command** — e.g. `/tmp/example/build/host` (automatically started before attach)
- **Env vars** — `KEY=VALUE` per line (optional)

Optionally configure **Deploy files** to SCP local binaries to the target before debugging, and **Remote logs** to tail log files in real-time.

### 4. Click Connect, then Debug

Click **Connect** to test the SSH connection. Once connected, click **Debug**. OmniBreak handles the rest — SSH to target, start gdbserver (one per process), launch VSCode debug sessions, and you're debugging.

## Sidebar Tabs

| Tab | Description |
|-----|-------------|
| **Config** | Device management, deploy files, debug targets, remote log paths |
| **Stats** | Real-time CPU / RSS / VSZ / threads / process state |
| **Leaks** | Auto heap tracking, leak risk detection, GDB malloc tracing |
| **Logs** | Real-time log viewer with sub-pages per remote log file |

## Features

- **Multi-process debugging** — debug N processes simultaneously, each with independent breakpoints and DAP sessions
- **One-click restart + attach** — configure a start command and OmniBreak restarts your service then attaches automatically
- **Deploy pipeline** — SCP local binaries to the target before debugging, with chmod support
- **Remote log tailing** — add remote log file paths, tailed in real-time in the Logs tab
- **Connection heartbeat** — monitors SSH connection every 5 seconds, detects disconnects instantly
- **Encrypted credentials** — SSH and sudo passwords stored in VSCode SecretStorage
- **Crash debugging** — SIGSEGV/SIGABRT trigger automatic backtrace display, session stays alive
- **GDB commands** — type `!` in Debug Console to run any GDB command (`!bt full`, `!info threads`, etc.)
- **SSH key or password auth** — both supported, configured per device
- **Process stats monitoring** — real-time CPU%, RSS, VSZ, thread count, process state per debug session
- **Memory leak detection** — automatic heap growth tracking with rolling samples and risk assessment (LOW/MEDIUM/HIGH)

## Troubleshooting

### "Connection timed out" / gdbserver not found

Ensure `gdbserver` and `gdb-multiarch` are installed on the target, and port 2345 is reachable.

### Breakpoints not hitting

The binary must be compiled with debug symbols (`-g`). Binary and source must match — recompile after any source changes.

### Attach shows "Operation not permitted"

Linux ptrace security restriction. On the target:

```bash
sudo sysctl -w kernel.yama.ptrace_scope=0
```

### Program output not showing

Program printf output is written to gdbserver's stdout. Add the log path (e.g. `/tmp/omnibreak-gdb-host.log`) to **Remote logs** in the Config tab, then view it in the Logs tab.

## Related

Check out [OmniBreak Skill](https://github.com/YuMinHui825/omnibreak-skill) — the same remote debugging power as a Claude Code skill. No VSCode needed.

## License

MIT

## Author

[shibu](https://github.com/YuMinHui825)

---

<p align="center">
  <b>If you find OmniBreak useful, please give it a ⭐</b><br/><br/>
  <img src="IMG_9667.JPG" width="200" alt="Alipay" /><br/>
  <sub>Like this project? <b>Buy me a coffee ☕</b></sub><br/>
  <a href="https://github.com/YuMinHui825/omnibreak">Star on GitHub</a>
</p>
