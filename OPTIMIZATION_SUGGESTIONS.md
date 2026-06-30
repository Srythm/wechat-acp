# wechat-acp 代码审查与优化建议

> 审查时间：2026-06-30
> 审查范围：基于原项目 `https://github.com/formulahendry/wechat-acp` v0.8.0 的新增/修改代码
> 测试结果：`npm test` 全部通过（25/25）

---

## 一、新增/修改文件概览

| 文件 | 变更性质 | 主要内容 |
|---|---|---|
| `src/weixin/send.ts` | 修改 | 新增 `extractImagePaths`、`sendImageMessage` |
| `src/weixin/media.ts` | 修改 | `uploadToCdn` 错误信息增强（含 `x-error-code`） |
| `src/bridge.ts` | 修改 | 系统提示注入、图片路径提取与发送、ACP `image` content block 转发 |
| `src/acp/client.ts` | 修改 | 新增 `onImageFlush`、缓冲并刷新 image content block |
| `src/acp/session.ts` | 修改 | 把 `onImage` 回调接入会话管理 |
| `src/config.ts` | 修改 | 新增 `agent.systemPrompt`、`DEFAULT_SYSTEM_PROMPT` |
| `bin/wechat-acp.ts` | 修改 | CLI 新增 `--system-prompt` / `--no-system-prompt` |
| `tests/extract-images.test.ts` | 新增 | 图片路径提取单元测试 |
| `tests/client.test.ts` | 修改 | 新增 image chunk 刷新相关测试 |
| `scripts/probe-opencode-image.ts` | 新增 | 探测 opencode 是否会输出 `image` content block |
| `_ref_openclaw/` | 新增（参考） | `@tencent-weixin/openclaw-weixin` v2.4.6 解包参考代码，用于对照 CDN 上传/AES 实现 |
| `sine.png` / `sine.py` | 新增（临时） | 测试用正弦波图片及其生成脚本 |

---

## 二、关键实现路径

### 1. Agent 文本中的本地图片路径转发（主路径）
- `DEFAULT_SYSTEM_PROMPT`（`src/config.ts`）在每个用户消息前以 text content block 注入，告诉 agent：引用本地图片文件时要用 `![desc](path)`，桥接会转发为微信图片。
- `bridge.ts#enqueueMessage` 把系统提示 prepend 到 prompt。
- `send.ts#extractImagePaths` 从 agent 回复文本中提取三种形式的图片引用：
  1. Markdown `![alt](path)`
  2. `file:///path` URL
  3. 裸路径（绝对路径、`./`、`../`，但必须有图片扩展名）
- `bridge.ts#deliverReply` 先调用 `extractImagePaths`，对每张图片调用 `deliverImageFromFile` 上传到微信 CDN 并发送，再把引用从文本中移除，最后发送清理后的文本。

### 2. ACP 原生 `image` content block 转发（备用路径）
- `client.ts#sessionUpdate` 遇到 `agent_message_chunk` 且 `type === "image"` 时，先 flush 已有文本再压入 `imageBlocks`。
- `client.ts#maybeFlushImages` 在 `tool_call`、thought、最终 `flush()` 边界把图片交给 `onImageFlush`。
- `bridge.ts#sendImageReply` 把 base64 图片数据解码后走 `sendImageMessage`。

### 3. 微信图片消息上传
- `send.ts#sendImageMessage`：
  1. 生成 16 字节 AES key + 16 字节 filekey。
  2. 调 iLink `getuploadurl` 取上传 URL；`filesize` 使用 **加密后大小**（`rawSize + (16 - rawSize % 16)`，PKCS7 补齐），解决 CDN `-5102031` 错误。
  3. AES-128-ECB 加密后 POST 到 CDN，取回 `x-encrypted-param`。
  4. 发送 BOT 消息，`image_item.media.aes_key` 为 `base64(hexString)` 格式，`mid_size` 为加密大小。

---

## 三、发现的问题

### 问题 1：`extractImagePaths` 的正则在 Linux/macOS 下会漏掉 Unix 绝对路径 ⚠️

**位置**：`src/weixin/send.ts` 第 80 行

```ts
const conservativeRe = /(^|[\s(])((?:[A-Za-z]:[\\/][^\s)]+)|(?:\.\/[^\s)]+)|(?:\.\.\/[^\s)]+))/g;
```

**问题**：三个分支分别是 Windows 盘符路径、`./`、`../`，**没有匹配 Unix 绝对路径 `/home/.../img.png` 的分支**。当前测试在 Windows 上跑的是 `C:\proj\...`，所以通过了；在 Linux/macOS 上 `absolute path with image extension is extracted` 测试会失败。

**建议修复**：增加 `(?:\/[^\s)]+)` 分支，例如：

```ts
/(^|[\s(])((?:[A-Za-z]:[\\/][^\s)]+)|(?:\/[^\s)]+)|(?:\.\.?[\\/][^\s)]+))/g
```

同时 Windows 下 `.\img.png`（反斜杠）也不会被当前 `\.​/` 分支匹配，也可一并支持。

### 问题 2：`deliverImageFromFile` 里 `node:fs/promises` 的动态导入写法别扭

**位置**：`src/bridge.ts` 第 767 行

```ts
const { default: fs } = await import("node:fs/promises");
```

**问题**：虽然 ESM 下 CJS 模块的 default 就是 `module.exports`，能工作，但写法不够直观。

**建议修复**：直接 `import { readFile } from "node:fs/promises"` 或在函数内 `const { readFile } = await import("node:fs/promises")`。

### 问题 3：图片与文本的相对顺序有两套语义

**问题**：
- **本地路径转发路径**：`deliverReply` 先发送图片、再发送清理后的文本（注释说明这是为了"image-then-text"自然流）。
- **ACP image block 路径**：`client.ts` 在边界上先 `maybeFlushMessage` 再 `maybeFlushImages`，即 text-then-image。

如果同一会话同时存在两类输出，用户端看到的顺序可能不一致。

**建议修复**：统一为 agent 实际产出顺序，或在 `session.ts` 层把 text 和 image 放进同一个有序队列。

### 问题 4：裸路径正则会把末尾标点符号一并吞入

**位置**：`src/weixin/send.ts` 第 80 行

**问题**：`[^\s)]+` 会包含紧跟的标点（如 `/path/img.png.`），导致扩展名判断失败。常见场景是图片路径位于句尾。

**建议修复**：在 `resolveImagePath` 中 trim 尾部标点。

---

## 四、测试情况

```text
✔ tests 25
✔ pass 25
✔ fail 0
```

新增测试覆盖了：
- Markdown / `file://` / 裸路径提取
- Windows 与 Unix 路径解析
- 扩展名过滤、去重、顺序
- ACP image chunk 在 tool_call 边界、最终 flush、多图顺序、缺失回调等场景

---

## 五、后续建议

1. **优先修复 `extractImagePaths` 的 Unix 绝对路径正则**，否则 Linux/macOS 用户无法使用裸绝对路径。
2. 如果 `_ref_openclaw/` 只是临时参考，建议后续从仓库中移除或加入 `.gitignore`，避免误提交第三方代码。
3. `sine.png` / `sine.py` 看起来是临时测试产物，建议清理或移入 `tests/fixtures`。
