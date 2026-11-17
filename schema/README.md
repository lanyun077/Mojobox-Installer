# 薄包协议来源

`feature-pack.json` 保留 Mojobox 当前 `formatVersion: 1` Feature Pack schema。
来源为 [EAC-mojobox 的 vendored schema](https://github.com/lanyun077/EAC-mojobox/blob/main/vendor/eac/feature-pack-pack.schema.json)，原始协议来源记录在 schema 的 `$id` 中。

本插件在该结构之上仅接受根 `pack.json` 和可选根 `icon.png`；不接收 payload、非空 overrides、草稿、非精确外部组件版本。整包内核范围缺失或与当前版本不匹配时显示提醒，允许继续逐项核验；有声明时仍校验范围语法。使用该数据协议不依赖 EAC 客户端或运行时。
