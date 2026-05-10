# OmniBreak

> Linux 远程可视化调试——任意位置打断点，任意线程，任意进程。  
> 像 Xcode 一样调试 ARM64/x86 Linux。

## 是什么？

OmniBreak 是一个 VSCode 插件，用于远程 Linux 目标的可视化断点调试。连接任意 Linux 机器——嵌入式设备、机器人、云服务器、交叉编译目标——在 VSCode 里断点、看变量、查调用栈、单步执行。

代码写在一台机器上（编译机），程序跑在另一台机器上（目标机），在 VSCode 里无缝调试。

## 工作原理

```
编译机                          目标机
(源码 + 编译 + VSCode)          (程序跑在这里)
│                              │
│  ① scp 二进制 ────────────→  │  (自动，需开启 deploy)
│  ② ssh 启动 gdbserver ────→  │
│  ③ ssh 启动 GDB ──────────→  │  ← GDB 与 gdbserver 通信
│                              │
└─ VSCode UI: 断点、单步、变量
```

所有调试命令通过 GDB 在目标机上执行。本地不需要 GDB——只需要 VSCode Remote-SSH 连到编译机。

## 准备条件

### 你的机器（VSCode）

- **VSCode 1.90+** — macOS / Linux / Windows 均可
- **Remote-SSH 插件**
- **Node.js 20+** — 仅从源码构建时需要，使用插件不需要

### 编译机（源码 + 编译 + 部署）

- Linux，带 SSH 服务
- 正常构建工具链（gcc/cmake/conan 等你已经在用的）
- `scp` 和 `ssh`（Linux 预装）
- `sshpass`（可选，用 SSH 密码时才需要）

### 目标机（程序运行的地方）

```bash
sudo apt install -y gdbserver gdb-multiarch
```

就这两样。都在标准 Ubuntu/Debian 软件源里。  
`stdbuf`（coreutils 预装）用于实时刷新程序输出。

> 通常编译机和目标机是不同的机器。编译机交叉编译，目标机运行程序。OmniBreak 把产物从编译机拷到目标机，然后在目标机上调试。

## 安装

### 直接安装

```bash
code --install-extension omnibreak-0.1.0.vsix
```

### 从源码构建

```bash
git clone https://github.com/YuMinHui825/omnibreak.git
cd omnibreak
npm install
npm run compile
npm run package          # 生成 omnibreak-0.1.0.vsix
code --install-extension omnibreak-0.1.0.vsix
```

## 快速开始

### 1. 配置 SSH 到目标机

```bash
ssh-copy-id root@192.168.1.100   # 密钥登录（推荐）
ssh root@192.168.1.100 'apt install -y gdbserver gdb-multiarch'
```

### 2. 添加 launch.json

在项目里创建 `.vscode/launch.json`：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "omnibreak",
      "request": "launch",
      "name": "远程调试",
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

### 3. 按 F5

搞定。OmniBreak 自动处理剩下的——SSH 到目标机、启动 gdbserver、连接 GDB、开始调试。

## 配置模式

### 模式 1：远程调试

二进制已在目标机上。F5 直接连。

```json
{
  "type": "omnibreak",
  "request": "launch",
  "name": "远程调试",
  "targetHost": "192.168.1.100",
  "sshUser": "root",
  "binaryPath": "/opt/app/myapp",
  "sourceFileMap": { "/home/builder/project": "${workspaceFolder}" }
}
```

### 模式 2：部署 + 调试

自动 SCP 编译产物到目标机，然后调试。

```json
{
  "type": "omnibreak",
  "request": "launch",
  "name": "部署调试",
  "targetHost": "192.168.1.100",
  "sshUser": "root",
  "deploySource": "/home/builder/build/myapp",
  "binaryPath": "/opt/app/myapp",
  "autoDeploy": true,
  "sourceFileMap": { "/home/builder/project": "${workspaceFolder}" }
}
```

### 模式 3：Attach 到运行中进程

```json
{
  "type": "omnibreak",
  "request": "attach",
  "name": "附加进程",
  "targetHost": "192.168.1.100",
  "sshUser": "root",
  "processName": "myapp",
  "binaryPath": "/opt/app/myapp",
  "sourceFileMap": { "/home/builder/project": "${workspaceFolder}" }
}
```

### 模式 4：调试共享库 (.so)

```json
{
  "type": "omnibreak",
  "request": "launch",
  "name": "调试 .so",
  "targetHost": "192.168.1.100",
  "sshUser": "root",
  "binaryPath": "/opt/app/libmylib.so",
  "solibSearchPath": "/opt/app/libs",
  "sourceFileMap": { "/home/builder/project": "${workspaceFolder}" }
}
```

## 配合进程管理器（systemd/supervisor）

如果程序由 systemd/supervisor 等拉起，把启动命令改成 gdbserver 包装：

```bash
# 原来：
ExecStart=/opt/app/myapp

# 改成：
ExecStart=gdbserver :2345 /opt/app/myapp
```

OmniBreak F5 时会自动检测目标机上已有的 gdbserver，直接连上去——不需要重启。程序崩溃时，OmniBreak 截获信号、打印完整堆栈、保持 session 不关闭，给你足够时间查看。

## 崩溃调试

当 SIGSEGV/SIGABRT 等致命信号触发时，OmniBreak：

1. **停在崩溃行** — 源码高亮精准定位崩溃位置
2. **打印完整堆栈** — 从崩溃点到入口的所有栈帧
3. **保持 session 存活** — 查看变量、寄存器、调用栈，session 不会自动关闭

Debug Console 显示：

```
=== CRASH BACKTRACE ===
#0 compute at libdemo.c:9
#1 main at host.c:8
#2 __libc_start_main at libc-start.c:308
#3 _start at start.S:122
```

## Debug Console 执行 GDB 命令

在 Debug Console 输入框里以 `!` 开头，可以执行任意 GDB 命令：

```
!bt full          # 完整堆栈 + 局部变量
!info threads     # 列出所有线程
!info registers   # 查看 CPU 寄存器
!p 变量名          # 打印变量
!x/10x $sp        # 查看栈指针附近 10 个字
!disassemble      # 当前 PC 处反汇编
```

## 所有配置字段

| 字段 | 必填 | 默认值 | 说明 |
|-------|:---:|------|------|
| `targetHost` | 是 | — | 目标 Linux IP 或主机名 |
| `sshUser` | 是 | — | SSH 用户名 |
| `binaryPath` | 是 | — | 目标机上二进制/.so 路径 |
| `targetPort` | 否 | 2345 | gdbserver 端口 |
| `sshPort` | 否 | 22 | SSH 端口 |
| `sshPassword` | 否 | — | SSH 密码（不用则走密钥认证） |
| `symbolFile` | 否 | binaryPath | 单独的调试符号文件 |
| `gdbPath` | 否 | /usr/bin/gdb-multiarch | 目标机上 GDB 路径 |
| `sourceFileMap` | 否 | — | 编译路径 → 本地工作区路径映射 |
| `nonStopMode` | 否 | true | 多线程 non-stop 模式 |
| `deploySource` | 否 | — | 本地编译产物路径（自动部署用） |
| `autoDeploy` | 否 | false | F5 前自动 SCP 部署 |
| `remoteLogPath` | 否 | — | 远程日志文件实时 tail |
| `processName` | 否 | — | 要 attach 的进程名（attach 模式） |
| `pid` | 否 | — | 要 attach 的 PID（attach 模式） |
| `solibSearchPath` | 否 | — | 远程 .so 搜索路径 |

## 调试快捷键

| 操作 | 快捷键 |
|------|------|
| 继续 | F5 |
| 单步跳过 | F10 |
| 单步进入 | F11 |
| 单步跳出 | Shift+F11 |
| 停止 | Shift+F5 |

## Troubleshooting

### 设断点时提示 "No symbol table loaded"

确保断点设在匹配编译产物的源文件里。`sourceFileMap` 必须把编译时路径映射到 VSCode 工作区路径。例如 GCC 编译时用的 `/home/builder/project/main.c`，VSCode 打开的是 `${workspaceFolder}/main.c`：

```json
"sourceFileMap": { "/home/builder/project": "${workspaceFolder}" }
```

### "Connection timed out" / gdbserver 找不到

确保目标机已安装 `gdbserver` 和 `gdb-multiarch`，且防火墙允许配置的端口（默认 2345）。

### SSH 密码弹窗阻止启动

用 SSH 密钥认证（`ssh-copy-id`），或在 launch.json 里加 `"sshPassword"`（编译机需要装 `sshpass`）。

### 断点不命中

二进制必须带调试符号（编译时加 `-g`）。二进制和源码必须一致——改源码后要重新编译。

### 程序输出不在 Debug Console 显示

输出通过 `tail -f` 自动转发。如果不显示，检查目标机上是否有 `stdbuf`（`which stdbuf`）。

### Attach 提示 "Operation not permitted"

Linux ptrace 安全限制，在目标机上执行：

```bash
sudo sysctl -w kernel.yama.ptrace_scope=0
```

## License

MIT

## 作者

[shibu](https://github.com/YuMinHui825/omnibreak)
