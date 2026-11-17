# 制作预构建发行包

通过 GitHub Release 分发 `.tgz`，保留 `private: true`，无需 npm 发布账号。
普通源码推送与合并不会发布版本。

## 构建与校验

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run --ignore-scripts
git diff --check
npm run pack:release
```

`pack:release` 先构建当前源码，再生成 `artifacts/dsh-plugin-mojobox-<版本>.tgz`。
包内包含 `lib/`、注册 patch、Schema、README、许可证和包元数据，不包含源码、测试或本机报告。
包内不携带 `node_modules`；宿主安装时仍需解析运行依赖。

## 发布到 GitHub

1. 在独立测试环境安装本次 `.tgz`，核对 Profile 注册、配置保留、重启加载及设置页入口。
2. 确认源码已推送、对应提交 CI 通过。新版本先同步 `package.json` 与 lockfile 的版本，再更新用户安装链接和验证记录。
3. 在 GitHub 创建 Release，tag 使用 `v<包版本>`，明确选择本次验证的提交，上传 `.tgz` 附件。
4. 开发预览勾选「Set as a pre-release」。说明安装方式、实际验证范围及升级注意事项后发布。
5. 验证公开附件可下载，且 README 中的完整安装地址与本次附件一致。

不覆盖已发布的同版本附件；修复后递增版本并重新验证。回退使用之前的 Release，保留原 Profile 与用户配置。
网页一键唤起、市场包名搜索和 npm 发布需要另行接入，当前不作为 Release 安装的前提。
