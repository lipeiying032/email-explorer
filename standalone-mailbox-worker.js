/**
 * D1-only standalone worker (no Durable Objects).
 */

function log(action, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), action, ...meta }));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function mailboxId(request) {
  const url = new URL(request.url);
  return (url.searchParams.get("mailboxId") || request.headers.get("x-mailbox-id") || "default").trim();
}

async function init(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      mailbox_id TEXT NOT NULL,
      subject TEXT,
      sender TEXT,
      recipient TEXT,
      folder TEXT,
      body TEXT,
      snippet TEXT,
      received_at TEXT,
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (
      mailbox_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (mailbox_id, key)
    )`),
  ]);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const mbox = mailboxId(request);
    log("worker.fetch.start", { method: request.method, path: url.pathname, mailboxId: mbox });

    try {
      if (url.pathname === "/api/init" && request.method === "POST") {
        await init(env);
        return json({ ok: true });
      }

      if (url.pathname === "/api/getMessages" && request.method === "GET") {
        const rows = await env.DB.prepare(`SELECT * FROM messages WHERE mailbox_id = ? ORDER BY datetime(COALESCE(received_at, created_at)) DESC`).bind(mbox).all();
        return json({ ok: true, messages: rows.results || [] });
      }

      if (url.pathname === "/api/getSettings" && request.method === "GET") {
        const rows = await env.DB.prepare(`SELECT key, value FROM settings WHERE mailbox_id = ?`).bind(mbox).all();
        const settings = {};
        for (const r of rows.results || []) {
          try { settings[r.key] = JSON.parse(r.value); } catch { settings[r.key] = r.value; }
        }
        return json({ ok: true, settings });
      }

      if (url.pathname === "/api/saveSettings" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const settings = body.settings || {};
        const now = new Date().toISOString();
        const stmts = Object.entries(settings).map(([k, v]) => env.DB.prepare(`INSERT INTO settings (mailbox_id,key,value,updated_at) VALUES (?,?,?,?) ON CONFLICT(mailbox_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(mbox, k, JSON.stringify(v), now));
        if (stmts.length) await env.DB.batch(stmts);
        return json({ ok: true });
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      log("worker.fetch.error", { path: url.pathname, error: error instanceof Error ? error.message : String(error) });
      return json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, 500);
    }
  },
};
