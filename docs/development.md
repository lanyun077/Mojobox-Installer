# Mojobox Installer 开发文档

本仓库维护官方客户端的安装器。[Mojobox 主仓库](https://github.com/lanyun077/EAC-mojobox)维护网站、资源收录和整合包内容。
安装器读取目录、组织安装计划与反馈结果；实际依赖安装和插件加载交给官方宿主。

## 构建与检查

要求 Node.js **24.9.0 或更新版本**，无需账号或 API Key。

```bash
git clone https://github.com/lanyun077/Mojobox-Installer.git
cd Mojobox-Installer
npm ci
npm run typecheck
npm test
npm pack --dry-run --ignore-scripts
git diff --check
```

`npm test` 先构建，再运行 Node 内置测试。测试使用临时目录、模拟宿主和本机服务，不安装生产插件。
单独构建用 `npm run build`；生成预构建发行包用 `npm run pack:release`，产物位于 `artifacts/`。`lib/` 是构建输出，不提交。

CI 在 Windows 和 Linux 的 Node.js 24 上执行上述检查；Linux CI 通过不代表 Linux 官版客户端已适配。
仓库保留 `private: true`，推送代码不会自动发布 npm 包或客户端版本。
用户安装入口见[安装说明](installation.md)，发布包的制作与上传见[发行说明](releasing.md)。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `src/client.ts` | 设置页、市场卡片、进度、组件管理与日志入口 |
| `src/index.ts` | 当前 Profile 接线与宿主请求路由 |
| `src/catalog.ts` | 远端目录、展示数据、缓存、更新识别与归档核验 |
| `src/manager.ts` | 安装计划、选择执行、失败恢复和配置保护 |
| `src/artifacts.ts`、`src/feature-pack.ts` | npm 产物和薄包的身份、摘要与输入校验 |
| `src/contracts.ts` | 实际使用的宿主接口类型 |
| `schema/` | 主仓薄包格式的 Schema 副本与来源 |
| `test/`、`fixtures/` | 自动化回归与受控测试组件 |
| `scripts/` | 构建和测试工具 |
| `cordis.patch.yml` | 官方宿主的插件注册入口 |
| `docs/`、`.github/workflows/` | 项目文档与 CI |

模块职责、路由及数据目录详见[架构说明](architecture.md)。

## 兼容与安装约定

- 安装器版本为 `0.0.1-p3.1`，不声明无依据的 `engines.dsh` 上下界；加载兼容与整合包兼容分开判断，明确接口不兼容时再限制对应功能或版本。
- 设置页使用 `0.2.1-rc.5` 已有的 `useRemoteAccess` 权限 Hook，不依赖较新版才提供的 `remoteAccess.whenAccess`。无权限时显示说明，不挂载管理页面；宿主路由认证保持不变。
- 整包或插件的内核范围缺失、不匹配时提示，允许继续逐项核验；官版的兼容拒绝和构建审批仍生效，不修改第三方声明。
- 新增和更新由用户勾选确认；复用同版本、保留高版本及已有停用状态，不自动降级或接管未知来源。
- 归档身份、摘要、精确组件版本和依赖关系仍校验。明确冲突会阻止执行；恢复可确认的普通失败只影响相关组件，结果不明时暂停写入。
- 更新交由官方 `installBundle` 原位执行，不先删除旧版，并核对配置变化。删除仅针对用户确认的单个组件，不清理插件私有数据。

完整边界、已有验收和未验证项见[兼容说明](compatibility.md)。自动化覆盖旧版权限接口、跨内核路由与整合包预览；
源码接口核对和版本门禁通过，不等于对应客户端已经完成真实启动和安装验收。

## 目录与统计来源

| 内容 | 来源 |
| --- | --- |
| 整合包目录 | `https://mojobox.cn/generated/catalog.json` |
| 首次投稿者 | 同站 `generated/contributors.json`，来自主仓合并 PR |
| 下载量与热度 | 同站 `generated/rankings.json`，分别使用累计与近 7 日 GitHub 附件下载次数 |
| 整合包文件 | 与包 ID、版本绑定的主仓 GitHub Release 附件；保留既有同站及 Pages 下载链接 |

投稿者与统计在目录可用后后台加载，失败不阻塞安装。未知统计不记为零，投稿者不从包作者名称猜测。
显示原仓库使用目录声明的 HTTPS 地址；头像按 GitHub 数字用户 ID 加载，失败时显示名称首字母。
下载后核对大小、SHA-256 和包内声明；安装器不接受客户端传入的任意下载 URL。

供给契约与格式来源见[架构说明](architecture.md#协议与兼容)和 [Schema 来源](../schema/README.md)。

## 客户端联调与提交

真实安装使用独立 Home、Profile 和桌面数据目录。恢复初态应在客户端退出后还原整个测试 Profile；
仅删除安装记录不能恢复配置，缓存产物也可能仍被已安装插件引用。

测试组件、模拟注册表、官版接入和提交检查统一见[贡献指南](../CONTRIBUTING.md)。
源码通过检查不代表发布或上线；不同客户端与升级流程的验收范围见[兼容说明](compatibility.md)。

## 继续阅读

- [架构说明](architecture.md)：模块、安装链路、路由、协议与数据目录。
- [兼容说明](compatibility.md)：支持范围、版本修复及验收边界。
- [贡献指南](../CONTRIBUTING.md)：本地检查、测试样本、官版联调和反馈要求。
- [主仓收录规范](https://github.com/lanyun077/EAC-mojobox/blob/main/docs/intake.md)：整合包制作与投稿。
