# 安装 Mojobox Installer

发行包放在 [GitHub Releases](https://github.com/lanyun077/Mojobox-Installer/releases)，附件名为 `dsh-plugin-mojobox-<版本>.tgz`。
这是安装器插件的预构建包；GitHub 自动生成的 Source code ZIP／tar.gz 是源码，不能替代此附件。

## 官方桌面端

1. 打开客户端的「插件」页面，选择「添加插件」。
2. 在「包名或地址」中粘贴 README 提供的 Release `.tgz` 下载地址。
3. 按客户端提示确认安装、必要时重启，再打开「设置 → Mojobox」。

通过完整地址安装，不需要插件已被市场搜索收录，也不需要另装 Node.js 或命令行工具。

如果已经启用桌面端自带的 `dsh` 命令，也可以先完全退出桌面端，再执行：

```bash
dsh plugin --profile desktop add https://github.com/lanyun077/Mojobox-Installer/releases/download/v0.0.1-p3.1/dsh-plugin-mojobox-0.0.1-p3.1.tgz
```

桌面端需先启动过一次以初始化 Profile。命令应来自目标桌面端；隔离环境还需使用同一 `DSH_HOME`。

## dsh web 和自定义 Profile

```bash
dsh plugin --profile web add https://github.com/lanyun077/Mojobox-Installer/releases/download/v0.0.1-p3.1/dsh-plugin-mojobox-0.0.1-p3.1.tgz
```

把 `web` 换成实际 Profile 名称即可安装到自定义环境，然后重启对应宿主。
宿主需要提供网页设置页、插件管理和认证请求接口；仅命令行或 TUI 环境没有 Mojobox 图形入口。

## 下载后本地安装

先下载 Release 的 `.tgz` 附件，在文件所在目录执行：

```bash
dsh plugin --profile web add ./dsh-plugin-mojobox-0.0.1-p3.1.tgz
```

桌面端「添加插件」也可填写该文件的绝对路径。
这能避开安装时直接读取 GitHub 附件，但运行依赖仍需从 npm 注册表获取，不是完整离线安装。

## 更新与排查

- 更新安装器：用相同入口安装新版 `.tgz`，无需先删除旧版。保留原 Profile，按客户端提示重启。
- 终端找不到 `dsh`：桌面端可使用图形安装，或先启用其自带命令；普通 CLI 用户检查原有 DSH 命令是否可用。
- 下载失败：先用浏览器下载附件，再本地安装；依赖下载失败时查看官版安装日志和注册表设置。
- 没有 Mojobox 入口：确认装入的是当前宿主使用的 Profile，按提示重启，并在官版插件页检查加载状态。
- 包名搜索无结果：目前通过 Release 地址分发，尚未发布 npm，不能仅输入 `dsh-plugin-mojobox` 安装。

预构建包安装时不执行本项目的源码编译脚本；宿主仍会核验依赖、权限和插件状态。
已验证版本与未覆盖范围见[兼容说明](compatibility.md)，反馈请附宿主版本、安装地址及脱敏日志。
