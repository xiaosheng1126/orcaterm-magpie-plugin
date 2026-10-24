// OrcaTerm's built-in AI models as a magpie/OpenCode provider.
//
// OrcaTerm (Tencent Cloud's terminal) talks to Tencent's lightai backend.
// This plugin speaks that protocol directly, so any agent can pick
// orcaterm/glm-5.3 and get the same free-tier models the OrcaTerm app shows.
//
// Protocol facts (from the real client, verified 2026-09-12):
//   - endpoint: https://lightai.cloud.tencent.com/assistant/chat
//   - auth:     two cookies, `sid` (lightai) and `ot_session` (orcaterm)
//   - the request body is NOT a plain prompt: `input.input` is an ACP
//     envelope, and `conversationId` must be `cid-<uuid>-<product>`.
//     Get either wrong and the upstream answers with a self-introduction
//     instead of your prompt.
//   - the upstream model id goes in `user.setting.model` and must be the
//     full name (`TokenHub/glm-5.3`), not the short one the picker shows.
//   - a failure comes back as HTTP 200 with `code: "10050000"` (a string,
//     while success is the number 0), so the code is read leniently.
//
// The sign-in has no refresh endpoint upstream: `ot_session` is a JWT that
// simply expires. When it does, sign in to the OrcaTerm app again.

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"

const UPSTREAM = "https://lightai.cloud.tencent.com"
const PRODUCT = "orcaterm"
const ORIGIN = "http://tauri.localhost"
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const AUTH_EXPIRED_CODE = 10050000

// The models OrcaTerm's picker offers. All eight are free for a limited
// time. The nine legacy ones still answer but are no longer listed.
const MODELS = [
  { id: "glm-5.3", upstream: "TokenHub/glm-5.3", name: "GLM-5.3", ctx: 128000, out: 32768 },
  { id: "glm-5.3-flash", upstream: "TokenHub/glm-5.3-flash", name: "GLM-5.3-Flash", ctx: 128000, out: 32768 },
  { id: "deepseek-v4-pro", upstream: "TokenHub/deepseek-v4-pro", name: "DeepSeek-V4-Pro", ctx: 128000, out: 32768 },
  { id: "deepseek-v4-flash", upstream: "TokenHub/deepseek-v4-flash", name: "DeepSeek-V4-Flash", ctx: 128000, out: 32768 },
  { id: "kimi-k3", upstream: "TokenHub/kimi-k3", name: "Kimi-K3", ctx: 128000, out: 32768 },
  { id: "hy3", upstream: "Hunyuan3/hy3", name: "Hy3", ctx: 128000, out: 32768 },
  { id: "hy4-preview", upstream: "Hunyuan3/hy4-preview", name: "Hy4-preview", ctx: 128000, out: 32768 },
  { id: "glm-5.2", upstream: "TokenHub/glm-5.2", name: "GLM-5.2", ctx: 128000, out: 32768 },
]

const LEGACY = [
  { id: "deepseek-chat-latest", upstream: "deepseek-chat-latest", name: "DeepSeek Chat Latest" },
  { id: "glm-4.7", upstream: "glm-4.7", name: "GLM-4.7" },
  { id: "kimi-k2", upstream: "kimi-k2", name: "Kimi-K2" },
  { id: "kimi-k2.5", upstream: "kimi-k2.5", name: "Kimi-K2.5" },
  { id: "kimi-k2-thinking", upstream: "kimi-k2-thinking", name: "Kimi-K2-Thinking" },
  { id: "kimi-k2.5-thinking", upstream: "kimi-k2.5-thinking", name: "Kimi-K2.5-Thinking" },
  { id: "hunyuan-t1", upstream: "hunyuan-t1", name: "Hunyuan-T1" },
  { id: "hunyuan-turbos", upstream: "hunyuan-turbos", name: "Hunyuan-Turbos" },
  { id: "qwen3", upstream: "qwen3", name: "Qwen3" },
]

const ALL = [...MODELS, ...LEGACY]
const byId = new Map(ALL.map((m) => [m.id, m]))
const byUpstream = new Map(ALL.map((m) => [m.upstream, m]))

// ---- credentials -----------------------------------------------------------

// cookieFiles are where the OrcaTerm app keeps its sign-in, per platform.
function cookieFiles() {
  const home = homedir()
  return [
    join(home, "Library", "Caches", "com.orcaterm-desktop.app", ".cookies"),
    join(home, ".config", "com.orcaterm-desktop.app", ".cookies"),
    join(home, "AppData", "Local", "com.orcaterm-desktop.app", ".cookies"),
  ]
}

function domainOf(item) {
  const d = item?.domain
  if (d && typeof d === "object") return d.HostOnly || d.Suffix || ""
  return typeof d === "string" ? d : ""
}

function firstKV(raw) {
  if (typeof raw !== "string") return { k: "", v: "" }
  let s = raw
  const i = s.indexOf(";")
  if (i >= 0) s = s.slice(0, i)
  s = s.trim()
  const eq = s.indexOf("=")
  if (eq < 0) return { k: "", v: "" }
  return { k: s.slice(0, eq).trim(), v: s.slice(eq + 1).trim() }
}

// readCookies finds the two cookies the upstream needs. `sid` comes from
// lightai, `ot_session` from orcaterm; both are required.
function readCookies() {
  for (const path of cookieFiles()) {
    if (!existsSync(path)) continue
    try {
      const arr = JSON.parse(readFileSync(path, "utf8"))
      let sid = ""
      let ot = ""
      for (const item of arr) {
        const dom = domainOf(item)
        const { k, v } = firstKV(item?.raw_cookie)
        if (!k || !v) continue
        if (dom.includes("lightai.cloud.tencent.com") && k === "sid") sid = v
        if (dom.includes("orcaterm.cloud.tencent.com") && k === "ot_session") ot = v
      }
      if (sid && ot) return { sid, ot }
    } catch {
      // try the next path
    }
  }
  return { sid: "", ot: "" }
}

// webkitStorageDirs are where the WKWebView keeps the page's localStorage.
// The layout nests the origin hash twice, so the tree is walked.
function webkitStorageDirs() {
  const home = homedir()
  const roots = [
    join(home, "Library", "WebKit", "com.orcaterm.app", "WebsiteData", "Default"),
    join(home, "Library", "Containers", "com.orcaterm.app", "Data", "Library", "WebKit", "WebsiteData", "Default"),
  ]
  const out = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const p = join(dir, entry.name)
      if (entry.name === "LocalStorage") {
        const db = join(p, "localstorage.sqlite3")
        if (existsSync(db)) out.push(db)
        continue
      }
      walk(p, depth + 1)
    }
  }
  for (const root of roots) {
    if (existsSync(root)) walk(root, 0)
  }
  return out
}

// readWebkitCookies pulls the cookies the OrcaTerm page keeps in the
// WebView's localStorage. The app writes them as UTF-16 JSON under the
// `__tauri_cookies__` key, so the bytes are decoded before parsing.
function readWebkitCookies() {
  for (const db of webkitStorageDirs()) {
    let hex
    try {
      hex = execFileSync("sqlite3", [db, "select hex(value) from ItemTable where key='__tauri_cookies__';"], {
        encoding: "utf8",
        timeout: 5000,
      }).trim()
    } catch {
      continue
    }
    if (!hex) continue
    try {
      const bytes = Buffer.from(hex, "hex")
      const text = bytes.includes(0) ? bytes.toString("utf16le") : bytes.toString("utf8")
      const data = JSON.parse(text)
      const found = {}
      const walk = (o) => {
        if (!o || typeof o !== "object") return
        if (Array.isArray(o)) {
          for (const i of o) walk(i)
          return
        }
        if (typeof o.name === "string" && typeof o.value === "string") found[o.name] = o.value
        for (const v of Object.values(o)) walk(v)
      }
      walk(data)
      if (found.ot_session) return found
    } catch {
      // try the next database
    }
  }
  return {}
}

// userIDFromJWT reads the user id out of the ot_session JWT. The signature
// is not checked: it only ever identifies the account to the upstream.
function userIDFromJWT(token) {
  const parts = token.split(".")
  if (parts.length < 2) return ""
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    return String(payload.uid || payload.userId || payload.sub || "")
  } catch {
    return ""
  }
}

function jwtExpiry(token) {
  const parts = token.split(".")
  if (parts.length < 2) return 0
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    return Number(payload.exp || 0) * 1000
  } catch {
    return 0
  }
}

// ---- protocol --------------------------------------------------------------

function uuid() {
  return globalThis.crypto?.randomUUID?.() ?? "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// acpPrompt is the envelope the upstream expects inside `input.input`.
function acpPrompt(text, images) {
  const prompt = [{ type: "text", text }]
  for (const img of images) {
    const url = img.image_url?.url || ""
    const m = /^data:([^;]+);base64,(.*)$/.exec(url)
    if (m) prompt.push({ type: "image", data: m[2], mimeType: m[1] })
    else prompt.push({ type: "image_url", image_url: { url } })
  }
  return JSON.stringify({ _format: "acp-prompt", version: 1, prompt })
}

// chatBody is the upstream request. Two things are load-bearing: the
// conversationId shape and the nested ACP envelope.
function chatBody(conversationId, text, images, userId, upstreamModel) {
  const empty = []
  return {
    conversationId,
    user: {
      id: userId,
      setting: {
        mcpServers: [],
        uiServers: [],
        tools: empty,
        approvedTools: empty,
        approvedMCPTools: empty,
        enableAutoSubtaskExecution: false,
        env: empty,
        model: upstreamModel,
        modelDesc: {},
        hideToolMessage: true,
        isNormalToolMessageIgnored: true,
        shouldHideDirectOutputToolReview: true,
      },
    },
    input: {
      type: "start",
      input: acpPrompt(text, images),
      id: uuid(),
      emphasisPrompt: "",
      files: empty,
    },
    stream: false,
  }
}

// messagesToText flattens an OpenAI chat request into one prompt. The
// upstream takes a single prompt per turn, so the history is folded in.
function messagesToText(messages) {
  if (!Array.isArray(messages)) return ""
  const parts = []
  for (const m of messages) {
    const role = m?.role || "user"
    let text = ""
    const c = m?.content
    if (typeof c === "string") text = c
    else if (Array.isArray(c)) {
      const imgs = []
      for (const part of c) {
        if (part?.type === "text" && typeof part.text === "string") text += part.text
        else if (part?.type === "image_url") imgs.push(part)
      }
      if (imgs.length) {
        parts.push({ role, text, images: imgs })
        continue
      }
    }
    if (text) parts.push({ role, text })
  }
  if (!parts.length) return ""
  const last = parts[parts.length - 1]
  const images = last.images || []
  const history = parts
    .slice(0, -1)
    .map((p) => `${p.role === "user" ? "User" : p.role === "assistant" ? "Assistant" : "System"}: ${p.text}`)
    .join("\n\n")
  const prompt = history ? `${history}\n\nUser: ${last.text}` : last.text
  return { prompt, images }
}

// upstreamText pulls the answer out of the upstream's response.
// `data.action` is "completion" for a finished answer, "review" when it
// wants a tool to run, and "ask" when it asks a question back.
function upstreamText(data) {
  if (!data) return ""
  if (typeof data.taskCompletion === "string" && data.taskCompletion) return data.taskCompletion
  if (typeof data.question === "string" && data.question) return data.question
  if (typeof data.thinking === "string" && data.thinking) return data.thinking
  return ""
}

function upstreamToolCalls(data) {
  if (!data || data.action !== "review" || !data.tool) return []
  const t = data.tool
  const name = t.name || t.toolName || ""
  if (!name) return []
  let args = t.arguments || t.input || t.params || {}
  if (typeof args === "string") {
    try {
      args = JSON.parse(args)
    } catch {
      args = { value: args }
    }
  }
  return [{ id: `call_${uuid().replace(/-/g, "").slice(0, 16)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }]
}

// ---- plugin ----------------------------------------------------------------

export const OrcaTermAuthPlugin = async ({ client }) => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider["orcaterm"] ??= {
      name: "OrcaTerm",
      npm: "@ai-sdk/openai-compatible",
      api: UPSTREAM,
      models: Object.fromEntries(
        MODELS.map((m) => [
          m.id,
          {
            name: m.name,
            limit: { context: m.ctx, output: m.out },
            reasoning: true,
            tool_call: true,
            free: true,
            cost: { input: 0, output: 0, cache_read: 0 },
          },
        ]),
      ),
    }
  },

  provider: {
    id: "orcaterm",
    async models(provider) {
      return provider.models
    },
  },

  auth: {
    provider: "orcaterm",
    methods: [
      {
        // The OrcaTerm app keeps its sign-in locally; there is no OAuth
        // endpoint to send the user to. This method reads that sign-in
        // and stores a marker, so the account shows as signed in.
        type: "oauth",
        label: "OrcaTerm app's sign-in",
        async authorize() {
          const webkit = readWebkitCookies()
          const fromFile = readCookies()
          const ot = webkit.ot_session || fromFile.ot
          if (!ot) {
            return {
              type: "failed",
              error:
                "OrcaTerm isn't signed in. Open the OrcaTerm app, sign in, then try again.",
            }
          }
          const exp = jwtExpiry(ot)
          if (exp && Date.now() > exp) {
            return {
              type: "failed",
              error: "OrcaTerm's sign-in has expired. Sign in to the OrcaTerm app again.",
            }
          }
          const uid = userIDFromJWT(ot)
          return {
            type: "success",
            key: ot,
            metadata: { uid, expires: exp, source: "orcaterm-app" },
            // magpie calls this after the sign-in; there is no browser
            // round-trip here, so it just confirms the account.
            async callback() {
              return { type: "success", key: ot, metadata: { uid, expires: exp } }
            },
          }
        },
      },
      {
        type: "api",
        label: "OrcaTerm ot_session (manual)",
        placeholder: "eyJhbGciOi...",
      },
    ],
    async loader(getAuth) {
      const auth = await getAuth()
      const manual =
        auth?.type === "api"
          ? String(auth.key || "").trim()
          : auth?.type === "oauth"
            ? String(auth.key || "").trim()
            : ""
      const fromFile = readCookies()
      const webkit = readWebkitCookies()
      const ot = manual || webkit.ot_session || fromFile.ot
      const sid = fromFile.sid
      if (!ot) {
        throw new Error(
          "OrcaTerm isn't signed in. Open the OrcaTerm app and sign in, or paste the ot_session cookie value.",
        )
      }
      if (!sid) {
        // The upstream only needs ot_session; the lightai `sid` is a
        // readiness marker the real client also carries, but the request
        // itself goes without it.
      }
      const userId = userIDFromJWT(ot)
      const exp = jwtExpiry(ot)
      if (exp && Date.now() > exp) {
        throw new Error("OrcaTerm's ot_session has expired. Sign in to the OrcaTerm app again.")
      }

      return {
        baseURL: UPSTREAM,
        apiKey: "",
        async fetch(input, init) {
          const req = input instanceof Request ? input : null
          const url = req ? req.url : String(input)
          const headers = new Headers(init?.headers ?? req?.headers)
          headers.delete("authorization")
          headers.delete("x-api-key")
          headers.delete("content-length")

          // the upstream model id: the full name, not the short one
          let bodyText = init?.body
          if (bodyText === undefined && req) bodyText = await req.clone().text()
          let payload = {}
          try {
            payload = JSON.parse(typeof bodyText === "string" ? bodyText : "")
          } catch {
            payload = {}
          }
          const asked = String(payload.model || "")
          const model = byId.get(asked) ?? byUpstream.get(asked)
          if (!model) {
            throw new Error(`OrcaTerm has no model "${asked}". Known: ${ALL.map((m) => m.id).join(", ")}`)
          }

          const { prompt, images } = messagesToText(payload.messages)
          if (!prompt) throw new Error("OrcaTerm needs at least one message with text")

          const upstreamBody = chatBody(
            `cid-${uuid()}-${PRODUCT}`,
            prompt,
            images,
            userId,
            model.upstream,
          )

          headers.set("Content-Type", "application/json")
          headers.set("Authorization", "Bearer " + ot)
          headers.set("X-Product", PRODUCT)
          headers.set("X-Seq-Id", uuid())
          headers.set("X-Csrfcode", "")
          headers.set("X-Referer", ORIGIN + "/")
          headers.set("Origin", ORIGIN)
          headers.set("User-Agent", USER_AGENT)
          headers.set("Accept", "application/json")
          const cookie = [
            `ot_session=${ot}`,
            "userAccountLoginMethod=oauth",
            "userAccountType=wechat",
          ]
          if (userId) cookie.push(`userId=${userId}`)
          headers.set("Cookie", cookie.join("; "))

          const target =
            UPSTREAM +
            `/assistant/chat?name=${PRODUCT}&mode=0&csrfCode=&sseresume=true`

          const res = await fetch(target, {
            method: "POST",
            headers,
            body: JSON.stringify(upstreamBody),
          })

          const raw = await res.text()
          if (!res.ok) {
            throw new Error(`OrcaTerm upstream: HTTP ${res.status} ${raw.slice(0, 300)}`)
          }
          let parsed
          try {
            parsed = JSON.parse(raw)
          } catch {
            throw new Error(`OrcaTerm upstream: not JSON: ${raw.slice(0, 300)}`)
          }
          // the code is a number on success and a string on failure
          const code = Number(parsed?.code ?? 0)
          if (code !== 0) {
            if (code === AUTH_EXPIRED_CODE) {
              throw new Error("OrcaTerm's sign-in expired. Sign in to the OrcaTerm app again.")
            }
            throw new Error(`OrcaTerm upstream: code ${code} ${parsed?.message || ""}`)
          }

          const data = parsed?.data
          const text = upstreamText(data)
          const toolCalls = upstreamToolCalls(data)
          if (!text && !toolCalls.length) {
            throw new Error("OrcaTerm upstream returned an empty answer")
          }

          const message = { role: "assistant", content: text || null }
          if (toolCalls.length) message.tool_calls = toolCalls

          const id = `chatcmpl-${uuid().replace(/-/g, "")}`
          const created = Math.floor(Date.now() / 1000)
          const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

          // The upstream answers in one piece, so a streaming client gets
          // the whole text as one chunk and then the end marker. The
          // gateway expects SSE when the agent asked to stream.
          if (payload.stream) {
            const chunk = (delta, finish) => ({
              id,
              object: "chat.completion.chunk",
              created,
              model: model.id,
              choices: [{ index: 0, delta, finish_reason: finish ?? null }],
            })
            const parts = []
            parts.push(`data: ${JSON.stringify(chunk({ role: "assistant", content: text || "" }))}\n\n`)
            if (toolCalls.length) {
              for (const tc of toolCalls) {
                parts.push(`data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, id: tc.id, type: "function", function: tc.function }] }))}\n\n`)
              }
              parts.push(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`)
            } else {
              parts.push(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`)
            }
            if (payload.stream_options?.include_usage) {
              parts.push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: model.id, choices: [], usage })}\n\n`)
            }
            parts.push("data: [DONE]\n\n")
            return new Response(parts.join(""), {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              },
            })
          }

          const out = {
            id,
            object: "chat.completion",
            created,
            model: model.id,
            choices: [
              {
                index: 0,
                message,
                finish_reason: toolCalls.length ? "tool_calls" : "stop",
              },
            ],
            usage,
          }
          return new Response(JSON.stringify(out), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        },
      }
    },
  },
})

export const _internal = { acpPrompt, chatBody, messagesToText, upstreamText, upstreamToolCalls, readCookies, readWebkitCookies, userIDFromJWT, jwtExpiry, MODELS, LEGACY }
