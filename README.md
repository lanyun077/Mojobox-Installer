<h1 align="center">Mojobox Installer</h1>

<p align="center">在官方 DeepSeek Harness 客户端中浏览、安装和更新 Mojobox 整合包。</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#使用方式">使用方式</a> ·
  <a href="docs/development.md">开发文档</a> ·
  <a href="https://github.com/lanyun077/EAC-mojobox">Mojobox 主仓库</a>
</p>

## 主要功能

- 按功能包、外观包浏览，查看来源、投稿者、下载量和热度。
- 拖入 Mojobox `.dshpack`／ZIP 文件安装。
- 选择需要安装或更新的组件，保留已有配置。
- 查看总进度、重试失败项和保存日志。
- 启用、暂停或删除单个组件。

## 安装

**官方桌面端：** 打开「插件 → 添加插件」，在「包名或地址」中粘贴：

```text
https://github.com/lanyun077/Mojobox-Installer/releases/download/v0.0.1-p3.1/dsh-plugin-mojobox-0.0.1-p3.1.tgz
```

**dsh web：** 在终端执行：

```bash
dsh plugin --profile web add https://github.com/lanyun077/Mojobox-Installer/releases/download/v0.0.1-p3.1/dsh-plugin-mojobox-0.0.1-p3.1.tgz
```

自定义 Profile 请将 `web` 换成实际名称。安装后按客户端提示重启，打开 **设置 → Mojobox**。

[本地文件安装与常见问题](docs/installation.md) · [下载其他版本](https://github.com/lanyun077/Mojobox-Installer/releases)

## 使用方式

| 页面 | 操作 |
| --- | --- |
| 首页 | 拖入文件，或选择本地整合包 |
| 市场 | 选择功能包或外观包，查看详情并预览安装 |
| 已安装 | 检查更新、查看结果、重试失败项和保存日志 |
| 管理 | 搜索组件，启用、暂停或删除 |

预览后勾选组件并确认安装。安装完成后查看结果，有问题时保存日志并重试失败项。
下载量是 GitHub 附件累计下载次数，热度是近七日下载次数。

## 反馈与开发

- [安装器 Issues](https://github.com/lanyun077/Mojobox-Installer/issues)：附宿主版本、安装器版本、复现步骤和脱敏日志。
- [Mojobox 主仓库](https://github.com/lanyun077/EAC-mojobox#提交资源)：提交整合包或纠正资源信息。
- [开发文档](docs/development.md) · [贡献指南](CONTRIBUTING.md) · [使用要求](docs/compatibility.md)

## 许可

安装器代码采用 [MIT](LICENSE)。第三方插件、整合包和素材遵循各自的许可与署名。
