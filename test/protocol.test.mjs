import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, ".."), server = path.join(root, "dist/server.js");
const digest = p => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const parent = path.resolve(root, ".."), sibling = path.join(parent, "sibling/sentinel"), sentinel = path.join(parent, "parent-sentinel");
const before = [sibling, sentinel].map(digest), groups = new Set(), suiteTimer = setTimeout(() => process.exit(124), 20_000);
const init = v => ({ jsonrpc: "2.0", id: "init-1", method: "initialize", params: {
  protocolVersion: v, capabilities: {}, clientInfo: { name: "harness", version: "1" } } });
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gone(pid, tmp) {
  assert.equal(fs.existsSync(tmp), false); assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
  assert.equal(fs.existsSync(`/proc/${pid}`), false);
}
async function run(input, end = true, signal, deadline = 1800, command = [process.execPath, server]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "savia-mcp-"));
  const child = spawn(command[0], command.slice(1), { cwd: root, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, TMPDIR: tmp } });
  const out = [], err = []; child.stdout.on("data", x => out.push(Buffer.from(x))); child.stderr.on("data", x => err.push(Buffer.from(x)));
  const exit = new Promise((ok, no) => { const timer = setTimeout(() => no(Error("deadline")), deadline);
    child.once("exit", (code, sig) => { clearTimeout(timer); ok({ code, sig }); }); });
  for (const x of input) child.stdin.write(Buffer.isBuffer(x) ? x : Buffer.from(`${JSON.stringify(x)}\n`));
  if (signal) { await sleep(250); process.kill(-child.pid, signal); } else if (end) child.stdin.end();
  let status;
  try { status = await exit; } catch (e) { process.kill(-child.pid, "SIGTERM"); await sleep(100); try { process.kill(-child.pid, "SIGKILL"); } catch {} await sleep(50); status = e; }
  const children = fs.existsSync(`/proc/${child.pid}/task/${child.pid}/children`) ? fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim() : "";
  fs.rmSync(tmp, { recursive: true, force: true }); await gone(child.pid, tmp);
  return { status, stdout: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(out)),
    stderr: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(err)), children };
}
const json = r => r.stdout.trim().split("\n").filter(Boolean).map(x => JSON.parse(x));
function pass(id, name) { groups.add(id); console.log(`${id} ${name} RED→GREEN PASS`); }

async function full(round) {
  assert.equal(root, path.join(parent, "savia-mcp")); pass("SC-01", "Authorized child boundary");
  assert.deepEqual([sibling, sentinel].map(digest), before); assert.equal(fs.existsSync(path.join(parent, ".git")), false); pass("SC-02", "Forbidden mutation");
  let r = await run([init("2025-11-25"), initialized, { jsonrpc: "2.0", id: "ping-2", method: "ping" }]); let m = json(r);
  assert.deepEqual(m[0].result.serverInfo, { name: "savia-mcp", version: "0.1.0" }); assert.deepEqual(m[1].result, {}); pass("SC-03", "Successful lifecycle");
  const spaced = fs.mkdtempSync(path.join(root, "encoded space-")); fs.mkdirSync(path.join(spaced, "dist")); fs.copyFileSync(server, path.join(spaced, "dist/server.js")); fs.copyFileSync(path.join(root, "package.json"), path.join(spaced, "package.json"));
  r = await run([init("2025-11-25")], true, undefined, 1800, [process.execPath, path.join(spaced, "dist/server.js")]); assert.deepEqual(json(r)[0].result.serverInfo, { name:"savia-mcp", version:"0.1.0" }); fs.rmSync(spaced,{recursive:true}); assert.equal(fs.existsSync(spaced),false);
  r = await run([init("2099-01-01")]); assert.equal(json(r)[0].result.protocolVersion, "2025-11-25"); pass("SC-04", "Incompatible version fallback");
  r = await run([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, init("2025-11-25"), init("2025-11-25")]); assert.deepEqual(json(r).map(x => x.error?.code), [-32600, undefined, -32600]); pass("SC-05", "Invalid lifecycle order");
  assert.deepEqual(m[0].result.capabilities, {}); pass("SC-06", "Empty advertisement");
  r = await run([init("2025-11-25"), initialized, ...[["tools/list","tools-3"],["resources/list","resources-4"],["prompts/list","prompts-5"]].map(([method,id]) => ({ jsonrpc:"2.0",id,method }))]); assert.deepEqual(json(r).slice(1).map(x => x.error.code), [-32601,-32601,-32601]); pass("SC-07", "Unsupported lists");
  assert.ok(json(r).length === r.stdout.trim().split("\n").length); pass("SC-08", "Clean protocol stream");
  assert.equal(r.stderr, ""); pass("SC-09", "Contamination absent");
  r = await run([Buffer.from([255,10]), Buffer.from("{bad\n"), { jsonrpc:"2.0",id:9,method:"ping" }]); assert.deepEqual(json(r).map(x => x.error?.code ?? 0), [-32700,-32700,0]); pass("SC-10", "Malformed recovery");
  r = await run([{jsonrpc:"1.0",id:1,method:"ping"},{jsonrpc:"2.0",id:null,method:"ping"},{jsonrpc:"2.0",id:2,method:"ping",params:{x:1}}]); assert.deepEqual(json(r).map(x => x.error.code),[-32600,-32600,-32602]); pass("SC-11", "Invalid request forms");
  r = await run([init("2025-11-25"),initialized,{jsonrpc:"2.0",id:3,method:"unknown"},{jsonrpc:"2.0",method:"unknown"}]); assert.equal(json(r).at(-1).error.code,-32601); pass("SC-12", "Method and notification handling");
  r = await run([]); assert.deepEqual(r.status,{code:0,sig:null}); pass("SC-13", "EOF");
  for (const [signal,code] of [["SIGINT",130],["SIGTERM",143]]) { r=await run([],false,signal); assert.deepEqual(r.status,{code,sig:null}); } pass("SC-14", "Signals");
  r = await run([],false,undefined,80,[process.execPath,"-e","setInterval(()=>{},1000)"]); assert.equal(r.status.message,"deadline"); pass("SC-15", "Hung cleanup");
  r = await run([],true,undefined,1800,[process.execPath,path.join(root,"scripts/audit.mjs")]); assert.deepEqual(r.status,{code:0,sig:null}); const audit=JSON.parse(r.stdout); assert.equal(audit.audit,"static-clean"); pass("SC-16", "Forbidden dependency or effect");
  assert.deepEqual([sibling,sentinel].map(digest),before); pass("SC-17", `Repeatable harness round ${round}`);
  assert.ok(audit.authoredLines <= 340); pass("SC-18", "Budget and claim limits");
}
await full(1); await full(2); clearTimeout(suiteTimer);
assert.equal(groups.size,18); assert.deepEqual([sibling,sentinel].map(digest),before);
console.log(JSON.stringify({ rounds:2, scenarios:18, residue:false }));
