<p align="center"><img src="resources/omnibreak.png" width="128" alt="OmniBreak" /></p>

# OmniBreak

> Linux 远程可视化调试——任意位置打断点，任意线程，任意进程。  
> 像 Xcode 一样调试 ARM64/x86 Linux。无需 launch.json，无需远程 agent。只要 SSH。

## 是什么？

OmniBreak 是一个 VSCode 插件，用于远程 Linux 目标的可视化断点调试。代码在你机器上写，程序跑在远程 Linux 上（机器人、嵌入式设备、云服务器），在 VSCode 里断点、看变量、查调用栈、单步执行。

**不需要 launch.json。** 所有配置通过可视化侧边栏完成。

## 工作原理

```
你的 Mac / PC                   远程 Linux 目标机
(VSCode + OmniBreak)            (程序跑在这里)
│                                │
│  侧边栏：添加设备 ────────────→ SSH 连接 + 心跳监控
│  配置目标 + 部署文件 ──────────→ SCP 传文件、执行启动命令
│  点击 "Debug" ───────────────→ 每进程独立 gdbserver
│  VSCode 调试视图 ────────────→ GDB ↔ gdbserver ↔ 二进制
│                                │
└─ printf 输出 ─────────────────→ 侧边栏远程日志实时 tail
```

所有调试通过 GDB 在目标机上执行。本地不需要 GDB。零外部依赖——纯 Node.js `ssh2` 库。

## 准备条件

### 远程目标机

```bash
sudo apt install -y gdbserver gdb-multiarch
```

就这两样。都在标准 Ubuntu/Debian 软件源里。

### 你的机器（VSCode）

- **VSCode 1.90+** — macOS / Linux / Windows 均可
- **Node.js 20+** — 仅从源码构建时需要

## 安装

### 直接安装

```bash
code --install-extension omnibreak-0.2.0-beta.vsix
```

### 从源码构建

```bash
git clone https://github.com/YuMinHui825/omnibreak.git
cd omnibreak
npm install
npm run compile
npm run package
code --install-extension omnibreak-0.2.0-beta.vsix
```

## 快速开始

### 1. 打开 OmniBreak 侧边栏

点击 VSCode 活动栏的 OmniBreak 图标。

### 2. 添加设备

点击 **+ Add Device**，填写远程目标机的 IP、SSH 用户和密码。凭据通过 VSCode SecretStorage 加密存储（macOS Keychain / 系统 keyring）。

### 3. 配置调试目标

选中设备后，添加 **Debug targets**——每个要调试的进程一个。填写：
- **Process name** — 进程名，如 `host`
- **Binary path** — 二进制路径，如 `/tmp/example/build/host`
- **Start command** — 启动命令，如 `/tmp/example/build/host`（调试前自动启动）
- **Env vars** — 环境变量，每行 `KEY=VALUE`（可选）

可选配置 **Deploy files** 将本地编译产物 SCP 到目标机，以及 **Remote logs** 实时 tail 远程日志文件。

### 4. 点 Connect，再点 Debug

点 **Connect** 测试 SSH 连接。连接成功后点 **Debug**。OmniBreak 自动处理后续——SSH 到目标机、启动 gdbserver（每进程一个）、创建 VSCode 调试会话，开始调试。

## 侧边栏标签页

| 标签 | 说明 |
|-----|-------------|
| **Config** | 设备管理、部署文件、调试目标、远程日志路径 |
| **Stats** | CPU / 内存 / GPU 监控（Phase 2） |
| **Leaks** | 内存泄漏检测（Phase 3） |
| **Logs** | 实时日志查看，每个远程日志文件一个子页面 |

## 功能特性

- **多进程并行调试** — 同时调试 N 个进程，各自独立断点和 DAP 会话
- **一键重启 + attach** — 配置启动命令，OmniBreak 自动重启服务并挂载
- **部署管线** — 调试前 SCP 本地二进制到目标机，支持 chmod
- **远程日志 tail** — 添加远程日志路径，Logs 标签页实时查看
- **连接心跳** — 每 5 秒监控 SSH 连接，断连即刻检测
- **凭据加密** — SSH 和 sudo 密码存储在 VSCode SecretStorage 中
- **崩溃调试** — SIGSEGV/SIGABRT 自动打印完整堆栈，调试会话保持活跃
- **GDB 命令** — Debug Console 中输入 `!` 执行任意 GDB 命令
- **SSH 密钥或密码认证** — 两种方式都支持，按设备配置

## Troubleshooting

### "Connection timed out" / gdbserver 找不到

确保目标机已安装 `gdbserver` 和 `gdb-multiarch`，且端口 2345 可达。

### 断点不命中

二进制必须带调试符号（编译时加 `-g`）。二进制和源码必须一致——改源码后要重新编译。

### Attach 提示 "Operation not permitted"

Linux ptrace 安全限制，在目标机上执行：

```bash
sudo sysctl -w kernel.yama.ptrace_scope=0
```

### 程序输出不显示

程序 printf 输出写在 gdbserver 的 stdout 里。在 Config 标签页的 **Remote logs** 中添加日志路径（如 `/tmp/omnibreak-gdb-host.log`），然后在 Logs 标签页查看。

## License

MIT

## 作者

[shibu](https://github.com/YuMinHui825)
