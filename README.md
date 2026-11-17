<h1 align="center">Mojobox Installer</h1>

<p align="center">在官方 DeepSeek Harness 客户端中浏览、安装和更新 Mojobox 整合包。</p>

<p align="center">
  <a href="https://mojobox.cn/#/packs">浏览整合包</a> ·
  <a href="#使用方式">使用方式</a> ·
  <a href="docs/development.md">开发文档</a> ·
  <a href="https://github.com/lanyun077/EAC-mojobox">Mojobox 主仓库</a>
</p>

Mojobox Installer 在客户端的 **设置 → Mojobox** 提供整合包管理入口，由 Mojobox 社区维护。



## 主要功能

- **发现整合包**：展示原仓库、投稿者头像与名称、下载量和热度。
- **导入文件**：在页面内拖入或选择 Mojobox `.dshpack`／ZIP 文件。
- **按需安装和更新**：自行勾选组件，复用已安装版本，保留高版本及已有配置。
- **查看进度和结果**：显示总进度，失败项可重试，也可保存日志。
- **管理单个组件**：启用、暂停或删除；删除前提示受影响的整合包。

## 使用方式

安装器已加载后，打开 **设置 → Mojobox**：

| 页面 | 功能 |
| --- | --- |
| 首页 | 拖入文件或选择本地整合包 |
| 市场 | 浏览远端整合包，查看详情并预览安装 |
| 已安装 | 查看结果、检查更新、重试失败项和保存日志 |
| 管理 | 搜索并管理单个组件 |

安装前会展示组件清单，确认后执行。遇到失败，先查看结果或保存日志，再重试需要处理的组件。

## 版本与注意事项

- 安装器不锁定内核版本，旧版和新版均按实际接口兼容；整合包能否使用另行核验。已实测与待验收版本见兼容说明。
- 整合包或插件的内核声明有差异时会提醒，允许继续预览；最终能否安装由官版客户端判断。
- 下载量为 GitHub 附件累计下载次数，热度为近 7 日下载次数。
- 删除组件不清理其个人数据。需要恢复测试前状态时，应提前备份整个独立测试环境。

详细支持范围见[兼容说明](docs/compatibility.md)，开发、构建与验证见[开发文档](docs/development.md)。

## 反馈与参与

| 内容 | 入口 |
| --- | --- |
| 安装、更新或界面问题 | [安装器 Issues](https://github.com/lanyun077/Mojobox-Installer/issues)，附版本、复现步骤和脱敏日志 |
| 纠正整合包内容或提交资源 | [Mojobox 主仓库](https://github.com/lanyun077/EAC-mojobox#提交资源) |
| 修改安装器代码 | [开发文档](docs/development.md) · [贡献指南](CONTRIBUTING.md) |

## 许可

安装器代码使用 [MIT](LICENSE) 许可。第三方插件、整合包及素材保留各自许可与署名。
