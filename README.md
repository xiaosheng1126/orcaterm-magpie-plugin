# opencode-orcaterm-auth

OrcaTerm（腾讯云遨驰终端）内置的 AI 模型，作为 magpie / OpenCode 的 provider 插件。

装上之后，任何 agent 都能直接选 `orcaterm/glm-5.3` 这样的模型，走 OrcaTerm 的
限时免费额度。

## 模型

| id | 上游 id | 说明 |
|---|---|---|
| `glm-5.3` | `TokenHub/glm-5.3` | GLM-5.3，写代码强 |
| `glm-5.3-flash` | `TokenHub/glm-5.3-flash` | 更快 |
| `deepseek-v4-pro` | `TokenHub/deepseek-v4-pro` | 1M 上下文 |
| `deepseek-v4-flash` | `TokenHub/deepseek-v4-flash` | |
| `kimi-k3` | `TokenHub/kimi-k3` | |
| `hy3` | `Hunyuan3/hy3` | 腾讯混元 |
| `hy4-preview` | `Hunyuan3/hy4-preview` | 混元预览版 |
| `glm-5.2` | `TokenHub/glm-5.2` | |

另有 9 个 legacy 模型（`glm-4.7`、`kimi-k2`、`hunyuan-t1`、`qwen3` 等）仍可用，
但不在 OrcaTerm 的模型选择器里。

## 安装

```sh
magpie plugin add /path/to/orcaterm-magpie-plugin
magpie plugin login orcaterm      # 选 1：OrcaTerm app's sign-in
```

登录方式有两种：

1. **OrcaTerm app's sign-in**（推荐）—— 插件读本机 OrcaTerm 的登录态，
   需要先打开 OrcaTerm 并登录。
2. **OrcaTerm ot_session (manual)** —— 手动粘贴 `ot_session` cookie 的值。

## 用法

```sh
claude --model orcaterm/glm-5.3
codex exec --model orcaterm/glm-5.3 "..."
```

在 magpie 里也可以把它加进 routing group：

```sh
magpie group add my-code models=orcaterm/glm-5.3,trae-cn/glm-5.3
```

## 登录态

`ot_session` 是 JWT，过期了上游返回 HTTP 200 + `code: "10050000"`，
**上游没有刷新接口**，只能重新登录 OrcaTerm。插件会在登录时检查过期时间，
过期会直接报清楚。

插件从两个地方读登录态：

- `~/Library/Caches/com.orcaterm-desktop.app/.cookies`（`sid`）
- OrcaTerm 的 WKWebView LocalStorage（`ot_session`，UTF-16 JSON）

## 协议要点

上游不是 OpenAI 格式，插件在 `auth.loader` 里做翻译：

- 端点 `https://lightai.cloud.tencent.com/assistant/chat?name=orcaterm&mode=0&csrfCode=&sseresume=true`
- `conversationId` 必须是 `cid-<uuid>-orcaterm`
- `input.input` 是 ACP 信封（`{_format:"acp-prompt",version:1,prompt:[...]}`），不是字符串
- `user.setting.model` 要填上游全名（`TokenHub/glm-5.3`），填短名会静默返回空
- 失败是 HTTP 200 + `code` 为字符串（成功是数字 0），所以 code 读得宽松些

上游一次性返回完整答案，所以流式请求是把整段文本作为一个 chunk 发出去，
再补结束标记。

## 限制

- 上游只认 OrcaTerm 原生工具（`execute_terminal_command`、`fetch` 等），
  不能注册任意自定义 function
- 一次只产出一个工具调用
- 工具桥接由上游决定，客户端自定义工具名不会被调用

## 非官方

逆向实现，与腾讯云 / OrcaTerm 官方无关。使用前请自行确认是否符合服务条款。
