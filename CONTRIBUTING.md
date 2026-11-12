# 参与 Mojobox Installer

本仓库维护官版安装器。网站、插件收录、包清单与归档请提交到
[Mojobox 主仓库](https://github.com/lanyun077/EAC-mojobox#提交资源)。
架构与范围见 [README](README.md)、[架构说明](docs/architecture.md)及[兼容边界](docs/compatibility.md)。

## 本地验证

使用 Node.js `>=24.9.0`：

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run --ignore-scripts
git diff --check
```

修改 TypeScript 事实源 `src/`，不提交 `lib/`。测试使用临时目录、模拟宿主和本机回环服务，
不需要账号、API Key 或桌面客户端。涉及行为修改时补充对应回归，使用既有依赖和测试设施。

CI 在 Windows 与 Linux 的 Node.js 24 上执行以上检查；这只验证源码与打包，不表示对应平台客户端已支持。
CI 不安装生产整合包、不发布 npm 或 Release。

## 官版联调

真实安装必须使用独立的 Home、Profile 和桌面数据目录；保持默认用户 Profile 不变。
当前尚无已验收的安装器自身一键安装流程，不要猜测或发布未经验证的宿主安装命令。
使用官方支持的开发接入方式注册构建产物，记录实际版本、输入和配置保护核验结果。

`fixtures/` 为受控插件源码，部分故意缺少 bundle 或依赖，用于失败隔离测试。
以下命令只生成本机样本，不安装到宿主：

```bash
node scripts/prepare-fixtures.mjs
npm pack ./fixtures/p1/first --pack-destination ./artifacts --ignore-scripts
npm pack ./fixtures/p1/broken --pack-destination ./artifacts --ignore-scripts
npm pack ./fixtures/p1/last --pack-destination ./artifacts --ignore-scripts
```

随后可运行 `node scripts/fixture-registry.mjs` 提供 P1 注册表，或在停止它后运行
`node scripts/prepare-update-fixtures.mjs` 生成更新样本并提供 P2 注册表。
两者均绑定 `127.0.0.1:19487`，不能同时运行，也不能当作生产来源。
注册表切换只针对独立测试环境，测试结束后恢复；不要修改日常 Profile 或全局 npm 注册表。
需要恢复初态时，退出客户端后还原整个测试 Profile；缓存产物可能仍被 pnpm 引用，不应单独清理。

## 提交与发布

1. 从最新 `main` 建分支，保持修改集中；协议变化同时核对主仓规范与本仓消费者。
2. 执行上方验证，确认没有生成物、个人路径、凭据、完整 Profile 或本机报告。
3. 提交 PR，说明目的、实际行为、协议与兼容影响、已执行验证、未验证项和回退方式。
4. 等待 CI 与维护者审核。推送／合并只是源码变更，不等于客户端生效或正式上线。

`private: true` 保持有效。正式发行需要单独确认版本、目标官版、安装器自身安装与升级验证、
插件包文件清单和回退说明；本仓当前没有自动发布流程。

## 故障反馈

提供宿主版本、安装器版本、包 ID／版本、复现步骤、预期与实际行为，以及设置页保存的脱敏日志。
标明是否真实安装、模拟服务或仅加载检查；加载成功不能替代业务工具与配置迁移验证。
日志写入失败时可复制诊断。不要提交账号、Key、完整 Profile、聊天内容或未检查的桌面调试记录。
