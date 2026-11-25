# pi-high-level

在你指定的 Pi 回复后面追加一块高层总结框图。框图是会话里的自定义记录，只在界面显示，不会送回模型。

## 触发方式

1. **快捷键 `Ctrl+Shift+H`**
   - Agent 正在流式运行时按一下：为当前回复挂载/取消高层总结（底部状态栏显示 `hl: armed`）。
   - Agent 空闲时按一下：直接总结当前分支最近一条回复（已存在框图时不会重复叠框）。
2. **句尾标记 `+hl`**：在提示末尾写 `+hl`（或最后单独一行 `+hl`），扩展会先去掉标记再发送给模型，本轮真正结算后在回答下方插入框图（支持 `steer` / `followUp` 排队消息）。
3. **斜杠命令 `/hl`**：
   - `/hl`：为最近一条回复补一块总结框图（防重复）。
   - `/hl refresh`：强制重新生成最近一条回复的总结框图。
   - `/hl <你的提示>`：发送该提示并在回复后生成框图。
   - `/hl model [auto | current | provider/id]`：单独配置轻量总结模型（如 `auto` 优先选已认证的 `haiku` / `flash` / `mini`，找不到自动回退 `ctx.model`）。
   - `/hl auto [on | off | <N>c | <N>l]`：开启长回复自动兜底总结（默认阈值 `>=1200` 字符或 `>=28` 行）。
   - `/hl timeout <秒>`：设置总结请求超时时间（默认 `18s`，支持 `Esc` 随时打断）。
   - `/hl prompt`：查看当前总结提示。`/hl prompt file <路径>` 改用一份本地文件；`/hl prompt reset` 回到内置提示。
   - `/hl status`：查看当前模型、自动阈值、超时和总结提示。

总结提示文件是纯文本。写了 `{{question}}`、`{{answer}}` 时，分别换成本轮问题和回答；两个都没写时，文件内容后面仍会附上 `<question>` 和 `<answer>`。问题最多 1200 字，回答最多 16000 字，提示文件本身最多使用开头 8000 字。路径写在 `~/.pi/agent/pi-high-level.json` 的 `promptFile`。

卡片默认最多折叠展示 5 行，按 `Ctrl+O` 可展开查看完整要点及模型、耗时、原文长度等元数据；两三句话的简短回复会自动跳过总结。配置保存在 `~/.pi/agent/pi-high-level.json`，也可通过 `--hl-model`、`--hl-auto` 临时覆盖。

## 安装与试用

```bash
# 单次会话试用
pi -e ./pi-high-level

# 装进个人配置
pi install ./pi-high-level
```
