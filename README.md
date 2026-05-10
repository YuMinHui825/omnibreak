# OmniBreak

> Visual remote debugging for Linux — break anywhere, any thread, any process.  
> Like Xcode for ARM64/x86 Linux.

## What is OmniBreak?

OmniBreak is a VSCode extension that gives you visual breakpoint debugging for remote Linux targets. You write code on a build machine, the binary runs on a target machine (robot, embedded device, cloud server), and you debug seamlessly in VSCode — full breakpoints, variable inspection, call stacks, thread control.

## How it works

```
Build Machine                  Target Machine
(VSCode + source + binary)     (binary runs here)
│                              │
│  ① scp binary ────────────→  │  (auto, if deploy enabled)
│  ② ssh start gdbserver ───→  │
│  ③ ssh start GDB ─────────→  │  ← GDB talks to gdbserver
│                              │
└─ VSCode UI: breakpoints, step, variables
```

All debugging commands run through GDB on the target. No GDB needed on your local machine — just VSCode Remote-SSH to the build machine.

## Prerequisites

### Your Machine (where VSCode runs)

- **VSCode 1.90+** — macOS, Linux, or Windows
- **Remote-SSH extension** ([marketplace](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh))
- **Node.js 20+** — only if building the `.vsix` from source; not needed to use the extension

### Build Machine (where source code + compile + deploy happen)

- Linux with SSH server
- Standard build toolchain (gcc/cmake/conan/etc) — whatever you already use
- `scp` and `ssh` available (pre-installed on any Linux)
- `sshpass` (optional, only if using SSH password instead of key)

### Target Machine (where the binary runs)

```bash
sudo apt install -y gdbserver gdb-multiarch
```

That's it. Both packages are in standard Ubuntu/Debian repos.  
`stdbuf` (part of coreutils, pre-installed) is used by OmniBreak to flush program output in real-time.

> Typically the build machine and target machine are different. The build machine cross-compiles; the target machine runs the program. OmniBreak copies the binary from build → target, then debugs on the target.

## Install

### Download & Install

```bash
code --install-extension omnibreak-0.1.0.vsix
```

### Build from Source

```bash
git clone https://github.com/YuMinHui825/omnibreak.git
cd omnibreak
npm install
npm run compile
npm run package          # generates omnibreak-0.1.0.vsix
code --install-extension omnibreak-0.1.0.vsix
```

## Quick Start

### 1. SSH to target

```bash
ssh-copy-id root@192.168.1.100   # set up key auth (recommended)
ssh root@192.168.1.100 'apt install -y gdbserver gdb-multiarch'
```

### 2. Add launch.json

Create `.vscode/launch.json` in your project:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "omnibreak",
      "request": "launch",
      "name": "OmniBreak: Remote Debug",
      "targetHost": "192.168.1.100",
      "targetPort": 2345,
      "sshUser": "root",
      "sshPort": 22,
      "binaryPath": "/opt/app/myapp",
      "gdbPath": "/usr/bin/gdb-multiarch",
      "nonStopMode": true,
      "sourceFileMap": {
        "/home/builder/project": "${workspaceFolder}"
      }
    }
  ]
}
```

### 3. Press F5

That's it. OmniBreak handles the rest — SSH to target, start gdbserver, connect GDB, and you're debugging.

## Configuration Modes

### Mode 1: Remote Debug

Binary is already on the target. Press F5.

```json
{
  "type": "omnibreak",
  "request": "launch",
  "name": "Remote Debug",
  "targetHost": "192.168.1.100",
  "sshUser": "root",
  "binaryPath": "/opt/app/myapp",
  "sourceFileMap": { "/home/builder/project": "${workspaceFolder}" }
}
```

### Mode 2: Deploy & Debug

Auto SCP your compiled binary to target, then debug.

```json
{
  "type": "omnibreak",
  "request": "launch",
  "name": "Deploy & Debug",
  "targetHost": "192.168.1.100",
  "sshUser": "root",
  "deploySource": "/home/builder/build/myapp",
  "binaryPath": "/opt/app/myapp",
  "autoDeploy": true,
  "sourceFileMap": { "/home/builder/project": "${workspaceFolder}" }
}
```

### Mode 3: Attach to Running Process

```json
{
  "type": "omnibreak",
  "request": "attach",
  "name": "Attach",
  "targetHost": "192.168.1.100",
  "sshUser": "root",
  "processName": "myapp",
  "binaryPath": "/opt/app/myapp",
  "sourceFileMap": { "/home/builder/project": "${workspaceFolder}" }
}
```

### Mode 4: Debug a Shared Library (.so)

```json
{
  "type": "omnibreak",
  "request": "attach",
  "name": "Debug .so",
  "targetHost": "192.168.1.100",
  "sshUser": "root",
  "processName": "host-app",
  "binaryPath": "/opt/app/libmylib.so",
  "solibSearchPath": "/opt/app/libs",
  "sourceFileMap": { "/home/builder/project": "${workspaceFolder}" }
}
```

## All Fields

| Field | Required | Default | Description |
|-------|:---:|------|------|
| `targetHost` | Yes | — | Target Linux IP or hostname |
| `sshUser` | Yes | — | SSH username for target |
| `binaryPath` | Yes | — | Path to binary on target machine |
| `targetPort` | No | 2345 | gdbserver port on target |
| `sshPort` | No | 22 | SSH port on target |
| `sshPassword` | No | — | SSH password (omit to use key auth) |
| `symbolFile` | No | binaryPath | Separate debug symbol file |
| `gdbPath` | No | /usr/bin/gdb-multiarch | GDB path on target |
| `sourceFileMap` | No | — | Compile-time path → local workspace |
| `nonStopMode` | No | true | Multi-thread non-stop debugging |
| `deploySource` | No | — | Local binary path (for auto-deploy) |
| `autoDeploy` | No | false | SCP before debug |
| `remoteLogPath` | No | — | Tail a remote log file in Debug Console |
| `processName` | No | — | Process to attach to (attach mode) |
| `pid` | No | — | PID to attach to (attach mode) |
| `solibSearchPath` | No | — | Remote .so search path |

## Debug Controls

| Action | Key |
|------|------|
| Continue | F5 |
| Step Over | F10 |
| Step Into | F11 |
| Step Out | Shift+F11 |
| Stop | Shift+F5 |

## Using with a Process Launcher (systemd/supervisor)

If your program is started by a launcher (systemd, supervisor, custom script), change the launch command to wrap your binary with `gdbserver`:

```bash
# Before:
ExecStart=/opt/app/myapp

# After:
ExecStart=gdbserver :2345 /opt/app/myapp
```

OmniBreak automatically detects that gdbserver is already running on the target and connects directly — no restart needed. When the program crashes, OmniBreak catches the signal, displays a full backtrace, and keeps the session alive for inspection.

## Crash Debugging

When a SIGSEGV, SIGABRT, or any fatal signal hits, OmniBreak:

1. **Stops at the crash line** — source highlighted at the exact crash location
2. **Prints full backtrace** — all stack frames from crash point to entry
3. **Keeps session alive** — inspect variables, registers, and call stack without the session closing

The Debug Console shows:

```
=== CRASH BACKTRACE ===
#0 compute at libdemo.c:9
#1 main at host.c:8
#2 __libc_start_main at libc-start.c:308
#3 _start at start.S:122
```

## GDB Commands via Debug Console

Type `!` followed by any GDB command in the Debug Console input:

```
!bt full          # Full backtrace with local variables
!info threads     # List all threads
!info registers   # Dump CPU registers
!p variable_name  # Print a variable
!x/10x $sp        # Examine 10 words at stack pointer
!disassemble      # Show assembly at current PC
```

## Debugging a Shared Library (.so)

1. Compile your `.so` with `-g` (debug symbols)
2. Deploy the `.so` to the target machine
3. The host program that loads your `.so` is started by gdbserver (or launcher)
4. Configure `launch.json` with `binaryPath` pointing to your `.so` file
5. Set breakpoints in your `.so` source code — they work once the library is loaded
6. Optionally set `solibSearchPath` to help GDB find shared libraries

Example:

```json
{
  "type": "omnibreak",
  "request": "launch",
  "name": "Debug my .so",
  "targetHost": "192.168.1.100",
  "sshUser": "root",
  "binaryPath": "/opt/app/libmylib.so",
  "solibSearchPath": "/opt/app/libs",
  "sourceFileMap": { "/home/builder/project": "${workspaceFolder}" }
}
```

## Troubleshooting

### "No symbol table loaded" when setting breakpoints

Set breakpoints in the source file that matches your compiled binary. The `sourceFileMap` must map the compile-time source path to your VSCode workspace path. Example: if GCC compiled from `/home/builder/project/main.c`, and VSCode opens `${workspaceFolder}/main.c`, then:

```json
"sourceFileMap": { "/home/builder/project": "${workspaceFolder}" }
```

### "Connection timed out" / gdbserver not found

Ensure `gdbserver` and `gdb-multiarch` are installed on the target, and the target's firewall allows the configured port (default 2345).

### SSH password prompt blocks launch

Use SSH key auth (`ssh-copy-id`) or add `"sshPassword"` to the launch config (requires `sshpass` on the build machine).

### Breakpoints not hitting

The binary must be compiled with debug symbols (`-g` flag). Binary and source must match — recompile after any source changes.

### Program output not showing in Debug Console

Output should appear automatically via `tail -f`. If not, check that `stdbuf` is available on the target (`which stdbuf`).

## License

MIT

## Author

[shibu](https://github.com/YuMinHui825/omnibreak)
