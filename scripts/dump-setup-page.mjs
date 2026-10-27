import { writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
process.env.DSH_PROFILE_DIR = mkdtempSync(join(tmpdir(), "setup-"))
const lib = (f) => new URL(`../dsh-plugin/lib/${f}`, import.meta.url).href
const { loadConfig } = await import(lib("config.js"))
const { registerSetup } = await import(lib("setup.js"))
const routes = []
const web = { register: (r) => routes.push(r) }
const cfg = loadConfig({})
registerSetup({ get: (k) => (k === "webServer" ? web : undefined) }, { cfg, log: { info(){}, warn(){}, error(){} }, client: { restart(){} } })
const http = await import("node:http")
const server = http.createServer(async (req, res) => {
  const r = routes.find(x => x.path === req.url.split("?")[0])
  if (r) return r.handler(req, res)
  res.writeHead(404); res.end()
})
await new Promise(r => server.listen(0, "127.0.0.1", r))
const page = await (await fetch(`http://127.0.0.1:${server.address().port}/remote-control`)).text()
writeFileSync(join(tmpdir(), "dsh-remote-setup-page.html"), page)
server.close()
console.log("ok", page.length)
