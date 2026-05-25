/**
 * Run two persistent sessions in parallel, each driving a different surface,
 * sharing zero state with the other. Demonstrates the "2+ agents at a time"
 * use case.
 *
 *   BROWSER_USE_API_KEY=... bun examples/multi-agent-debug.ts
 */
const KEY = process.env.BROWSER_USE_API_KEY!;
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";

const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

async function ensure(name: string) {
  const existing = await fetch(`${BASE}/sessions/${name}`, { headers: auth });
  if (existing.status === 200) return;
  await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name, persistent: true }),
  });
}

async function navigate(name: string, url: string) {
  return fetch(`${BASE}/sessions/${name}/navigate`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ url }),
  }).then((r) => r.json());
}

async function screenshot(name: string, file: string) {
  const res = await fetch(`${BASE}/sessions/${name}/screenshot?fullPage=true`, { headers: auth });
  const buf = new Uint8Array(await res.arrayBuffer());
  await Bun.write(file, buf);
}

await Promise.all([ensure("agent-a"), ensure("agent-b")]);
const [a, b] = await Promise.all([
  navigate("agent-a", "https://trybloom.so/"),
  navigate("agent-b", "https://trybloom.so/pricing/"),
]);
console.log("agent-a", a);
console.log("agent-b", b);
await Promise.all([
  screenshot("agent-a", "/tmp/agent-a.png"),
  screenshot("agent-b", "/tmp/agent-b.png"),
]);

// Wipe agent-a state without losing the session.
await fetch(`${BASE}/sessions/agent-a/purge`, { method: "POST", headers: auth });
console.log("purged agent-a; agent-b is untouched");
