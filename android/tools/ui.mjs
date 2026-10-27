// Tiny adb UI driver for driving the DSH Remote app inside the emulator.
// Usage:
//   node tools/ui.mjs dump                 → list nodes (text / content-desc / bounds / clickable)
//   node tools/ui.mjs tap "登录"            → tap first node whose text or desc matches (substring, case-insensitive)
//   node tools/ui.mjs type "owner"         → adb input text into focused field (spaces via %s)
//   node tools/ui.mjs key back             → input keyevent (back/home/enter/escape...)
//   node tools/ui.mjs shot shots/01.png    → screencap to file
//   node tools/ui.mjs sleep 2              → wait seconds
//   node tools/ui.mjs focus "密码"          → tap + clear + type value (focus <regex> <value>)
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const ADB =
  process.env.ADB ||
  (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    ? `${process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT}${process.platform === 'win32' ? '\\' : '/'}platform-tools${process.platform === 'win32' ? '\\' : '/'}adb${process.platform === 'win32' ? '.exe' : ''}`
    : 'adb')
const KEYMAP = { back: 4, home: 3, enter: 66, escape: 111, tab: 61, delete: 67 }

function sh(...args) {
  return execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}

function dumpXml() {
  sh('shell', 'uiautomator', 'dump', '/sdcard/ui.xml')
  return sh('shell', 'cat', '/sdcard/ui.xml')
}

function parse(xml) {
  const nodes = []
  const re = /<node\b([^>]*?)\/?>/g
  let m
  while ((m = re.exec(xml))) {
    const attrs = m[1]
    const get = (name) => {
      const mm = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
      return mm ? mm[1] : ''
    }
    const bounds = get('bounds')
    const bm = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(bounds)
    if (!bm) continue
    const [x1, y1, x2, y2] = bm.slice(1).map(Number)
    nodes.push({
      text: get('text'),
      desc: get('content-desc'),
      clickable: get('clickable') === 'true',
      focused: get('focused') === 'true',
      cls: get('class'),
      x: Math.round((x1 + x2) / 2),
      y: Math.round((y1 + y2) / 2),
      x1, y1, x2, y2,
    })
  }
  return nodes
}

function find(nodes, pattern) {
  const p = pattern.toLowerCase()
  const hit = nodes.find(
    (n) =>
      (n.text && n.text.toLowerCase().includes(p)) ||
      (n.desc && n.desc.toLowerCase().includes(p))
  )
  if (!hit) throw new Error(`no node matching "${pattern}"`)
  return hit
}

function tapAt(x, y) {
  sh('shell', 'input', 'tap', String(x), String(y))
}

function typeText(text) {
  // sh() 用单引号包参数：去掉会破坏 shell 引用的字符
  const escaped = text
    .replace(/['"`$\\]/g, '')
    .replace(/ /g, '%s')
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
  sh('shell', 'input', 'text', escaped)
}

const [cmd, a1, a2] = process.argv.slice(2)
if (!cmd) {
  console.log('usage: dump|tap|type|key|shot|sleep|focus')
  process.exit(1)
}

try {
  if (cmd === 'dump') {
    const nodes = parse(dumpXml())
    for (const n of nodes) {
      if (!n.text && !n.desc) continue
      console.log(`${n.clickable ? '[c]' : '   '} ${String(n.x).padStart(4)},${String(n.y).padStart(4)}  text="${n.text}"  desc="${n.desc}"`)
    }
  } else if (cmd === 'tap') {
    const n = find(parse(dumpXml()), a1)
    tapAt(n.x, n.y)
    console.log(`tapped "${a1}" at ${n.x},${n.y}`)
  } else if (cmd === 'type') {
    typeText(a1)
    console.log('typed')
  } else if (cmd === 'focus') {
    const n = find(parse(dumpXml()), a1)
    tapAt(n.x, n.y)
    sh('shell', 'input', 'keyevent', '123') // move caret to end
    for (let i = 0; i < 40; i++) sh('shell', 'input', 'keyevent', '67') // clear
    typeText(a2)
    console.log(`focused "${a1}" and typed`)
  } else if (cmd === 'key') {
    const code = KEYMAP[a1] ?? Number(a1)
    sh('shell', 'input', 'keyevent', String(code))
    console.log(`key ${a1}`)
  } else if (cmd === 'shot') {
    // exec-out screencap returns black frames on this headless swiftshader setup;
    // writing to /sdcard and pulling works.
    sh('shell', 'screencap', '-p', '/sdcard/dsh_shot.png')
    const tmp = 'D:\\tmp\\dsh_shot.png'
    sh('pull', '/sdcard/dsh_shot.png', tmp)
    const png = readFileSync(tmp)
    mkdirSync(dirname(a1), { recursive: true })
    writeFileSync(a1, png)
    console.log(`saved ${a1} (${png.length} bytes)`)
  } else if (cmd === 'sleep') {
    sh('shell', 'sleep', String(a1))
  } else {
    console.log('unknown command', cmd)
    process.exit(1)
  }
} catch (e) {
  console.error('ERR:', e.message)
  process.exit(1)
}
