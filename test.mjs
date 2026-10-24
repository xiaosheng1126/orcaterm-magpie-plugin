import { _internal } from "./index.mjs"

const { acpPrompt, chatBody, messagesToText, upstreamText, upstreamToolCalls, readCookies, userIDFromJWT, jwtExpiry, MODELS } = _internal

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? " -> " + extra : ""}`)
  }
}

console.log("== acpPrompt ==")
const p = JSON.parse(acpPrompt("hello", []))
ok("_format", p._format === "acp-prompt")
ok("version", p.version === 1)
ok("text", p.prompt[0].text === "hello")
ok("type", p.prompt[0].type === "text")

const p2 = JSON.parse(acpPrompt("hi", [{ image_url: { url: "data:image/png;base64,AAAA" } }]))
ok("image data uri", p2.prompt[1].type === "image" && p2.prompt[1].mimeType === "image/png")
const p3 = JSON.parse(acpPrompt("hi", [{ image_url: { url: "https://x/y.png" } }]))
ok("image url", p3.prompt[1].type === "image_url")

console.log("== chatBody ==")
const body = chatBody("cid-abc-orcaterm", "hello", [], "u1", "TokenHub/glm-5.3")
ok("conversationId", body.conversationId === "cid-abc-orcaterm")
ok("model full name", body.user.setting.model === "TokenHub/glm-5.3")
ok("input type", body.input.type === "start")
ok("input is envelope", typeof body.input.input === "string" && body.input.input.includes("acp-prompt"))
ok("stream false", body.stream === false)
ok("user id", body.user.id === "u1")

console.log("== messagesToText ==")
const m1 = messagesToText([{ role: "user", content: "hi" }])
ok("single user", m1.prompt === "hi")
const m2 = messagesToText([
  { role: "system", content: "you are helpful" },
  { role: "user", content: "q1" },
  { role: "assistant", content: "a1" },
  { role: "user", content: "q2" },
])
ok("history folded", m2.prompt.includes("System: you are helpful"), m2.prompt)
ok("last is user", m2.prompt.endsWith("User: q2"), m2.prompt)
const m3 = messagesToText([{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "https://x/y.png" } }] }])
ok("images collected", m3.images.length === 1 && m3.prompt === "look")

console.log("== upstreamText ==")
ok("taskCompletion", upstreamText({ taskCompletion: "done" }) === "done")
ok("question", upstreamText({ question: "why?" }) === "why?")
ok("thinking", upstreamText({ thinking: "hmm" }) === "hmm")
ok("empty", upstreamText({}) === "")

console.log("== upstreamToolCalls ==")
ok("no tool", upstreamToolCalls({ action: "answer" }).length === 0)
const tc = upstreamToolCalls({ action: "review", tool: { name: "execute_terminal_command", arguments: { command: "ls" } } })
ok("tool count", tc.length === 1)
ok("tool name", tc[0].function.name === "execute_terminal_command")
ok("tool args", JSON.parse(tc[0].function.arguments).command === "ls")
const tc2 = upstreamToolCalls({ action: "review", tool: { name: "x", arguments: '{"a":1}' } })
ok("string args parsed", JSON.parse(tc2[0].function.arguments).a === 1)

console.log("== jwt ==")
const fake = "h." + Buffer.from(JSON.stringify({ uid: "u42", exp: 2000000000 })).toString("base64url") + ".s"
ok("uid", userIDFromJWT(fake) === "u42")
ok("exp", jwtExpiry(fake) === 2000000000 * 1000)
ok("bad jwt", userIDFromJWT("nope") === "")

console.log("== models ==")
ok("glm-5.3 present", MODELS.some((m) => m.id === "glm-5.3" && m.upstream === "TokenHub/glm-5.3"))
ok("all free", MODELS.every((m) => m.id))

console.log("== cookies ==")
const c = readCookies()
console.log(`  (local cookie file: sid=${c.sid ? "yes" : "no"} ot=${c.ot ? "yes" : "no"})`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
