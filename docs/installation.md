# 安装 Mojobox Installer

从 [Releases](https://github.com/lanyun077/Mojobox-Installer/releases) 取得 `dsh-plugin-mojobox-<版本>.tgz` 安装包。

## 官方桌面端

1. 打开「插件 → 添加插件」。
2. 在「包名或地址」中粘贴 [README](../README.md#安装) 提供的 `.tgz` 下载地址。
3. 完成安装，按提示重启，打开「设置 → Mojobox」。

使用桌面端自带的 `dsh` 命令安装时，先启动过一次客户端，再退出客户端执行：

```bash
dsh plugin --profile desktop add https://github.com/lanyun077/Mojobox-Installer/releases/download/v0.0.1-p3.1/dsh-plugin-mojobox-0.0.1-p3.1.tgz
```

命令与客户端应使用同一个 `DSH_HOME`。

## dsh web 与自定义 Profile

```bash
dsh plugin --profile web add https://github.com/lanyun077/Mojobox-Installer/releases/download/v0.0.1-p3.1/dsh-plugin-mojobox-0.0.1-p3.1.tgz
```

将 `web` 替换为实际 Profile 名称，安装后重启对应宿主。

## 本地文件安装

下载 `.tgz` 后，在文件所在目录执行：

```bash
dsh plugin --profile web add ./dsh-plugin-mojobox-0.0.1-p3.1.tgz
```

桌面端「添加插件」也可填写文件的绝对路径。依赖安装需要网络。

## 更新与排查

| 情况 | 操作 |
| --- | --- |
| 更新安装器 | 安装新版 `.tgz`，按提示重启 |
| 下载失败 | 浏览器下载附件后使用本地文件安装 |
| 找不到 `dsh` 命令 | 使用桌面端「添加插件」，或启用桌面端自带命令 |
| 没有 Mojobox 入口 | 核对 Profile，在插件页检查加载状态后重启 |
| 搜索包名无结果 | 使用完整的 Release 下载地址安装 |
| 安装整合包出错 | 在结果页保存日志，附版本与复现步骤[反馈](https://github.com/lanyun077/Mojobox-Installer/issues) |

安装包请选择 `.tgz` 附件。使用环境与文件要求见[使用要求](compatibility.md)。
