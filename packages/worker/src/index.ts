import type { Env } from "./types";

function log(action: string, meta: Record<string, unknown> = {}) {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			action,
			...meta,
		}),
	);
}

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
		},
	});
}

async function initSchema(env: Env) {
	log("db.init.start");
	await env.DB.batch([
		env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        mailbox_id TEXT NOT NULL,
        subject TEXT,
        sender TEXT,
        recipient TEXT,
        folder TEXT DEFAULT 'INBOX',
        body TEXT,
        snippet TEXT,
        read INTEGER DEFAULT 0,
        starred INTEGER DEFAULT 0,
        received_at TEXT,
        created_at TEXT NOT NULL
      )
    `),
		env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS settings (
        mailbox_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (mailbox_id, key)
      )
    `),
	]);
	log("db.init.done");
}

function mailboxIdFrom(request: Request) {
	const url = new URL(request.url);
	return (
		url.searchParams.get("mailboxId") ||
		request.headers.get("x-mailbox-id") ||
		"default"
	).trim();
}

async function getMessages(env: Env, mailboxId: string) {
	log("messages.get.start", { mailboxId });
	const result = await env.DB.prepare(
		`SELECT id, mailbox_id, subject, sender, recipient, folder, body, snippet, read, starred, received_at, created_at
     FROM messages
     WHERE mailbox_id = ?
     ORDER BY datetime(COALESCE(received_at, created_at)) DESC`,
	)
		.bind(mailboxId)
		.all();
	log("messages.get.done", {
		mailboxId,
		count: result.results?.length ?? 0,
	});
	return result.results ?? [];
}

async function saveSettings(env: Env, mailboxId: string, settings: Record<string, unknown>) {
	log("settings.save.start", {
		mailboxId,
		keys: Object.keys(settings),
	});
	const now = new Date().toISOString();
	const statements = Object.entries(settings).map(([key, value]) =>
		env.DB.prepare(
			`INSERT INTO settings (mailbox_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(mailbox_id, key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
			.bind(mailboxId, key, JSON.stringify(value), now),
	);
	if (statements.length > 0) {
		await env.DB.batch(statements);
	}
	log("settings.save.done", { mailboxId, saved: statements.length });
}

async function getSettings(env: Env, mailboxId: string) {
	log("settings.get.start", { mailboxId });
	const result = await env.DB.prepare(
		`SELECT key, value FROM settings WHERE mailbox_id = ? ORDER BY key ASC`,
	)
		.bind(mailboxId)
		.all();

	const settings: Record<string, unknown> = {};
	for (const row of (result.results ?? []) as Array<{ key: string; value: string }>) {
		try {
			settings[row.key] = JSON.parse(row.value);
		} catch {
			settings[row.key] = row.value;
		}
	}

	log("settings.get.done", {
		mailboxId,
		count: Object.keys(settings).length,
	});
	return settings;
}

async function saveMessage(env: Env, mailboxId: string, message: Record<string, unknown>) {
	const id = String(message.id || crypto.randomUUID());
	const now = new Date().toISOString();
	log("messages.save.start", { mailboxId, id });
	await env.DB.prepare(
		`INSERT INTO messages (
      id, mailbox_id, subject, sender, recipient, folder, body, snippet, read, starred, received_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mailbox_id = excluded.mailbox_id,
      subject = excluded.subject,
      sender = excluded.sender,
      recipient = excluded.recipient,
      folder = excluded.folder,
      body = excluded.body,
      snippet = excluded.snippet,
      read = excluded.read,
      starred = excluded.starred,
      received_at = excluded.received_at`,
	)
		.bind(
			id,
			mailboxId,
			message.subject ? String(message.subject) : null,
			message.sender ? String(message.sender) : null,
			message.recipient ? String(message.recipient) : null,
			message.folder ? String(message.folder) : "INBOX",
			message.body ? String(message.body) : null,
			message.snippet ? String(message.snippet) : null,
			message.read ? 1 : 0,
			message.starred ? 1 : 0,
			message.receivedAt ? String(message.receivedAt) : now,
			now,
		)
		.run();
	log("messages.save.done", { mailboxId, id });
	return { id };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const mailboxId = mailboxIdFrom(request);

		log("worker.fetch.start", {
			method: request.method,
			path: url.pathname,
			mailboxId,
		});

		try {
			if (url.pathname === "/api/init" && request.method === "POST") {
				await initSchema(env);
				return json({ ok: true, initialized: true });
			}

			if (url.pathname === "/api/getMessages" && request.method === "GET") {
				const messages = await getMessages(env, mailboxId);
				return json({ ok: true, mailboxId, messages });
			}

			if (url.pathname === "/api/saveMessage" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as {
					message?: Record<string, unknown>;
				};
				if (!body?.message || typeof body.message !== "object") {
					return json({ ok: false, error: "message is required" }, 400);
				}
				const result = await saveMessage(env, mailboxId, body.message);
				return json({ ok: true, mailboxId, ...result });
			}

			if (url.pathname === "/api/getSettings" && request.method === "GET") {
				const settings = await getSettings(env, mailboxId);
				return json({ ok: true, mailboxId, settings });
			}

			if (url.pathname === "/api/saveSettings" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as {
					settings?: Record<string, unknown>;
				};
				if (!body?.settings || typeof body.settings !== "object") {
					return json({ ok: false, error: "settings is required" }, 400);
				}
				await saveSettings(env, mailboxId, body.settings);
				return json({ ok: true, mailboxId });
			}

			if (url.pathname === "/health") {
				return json({ ok: true, service: "email-explorer-d1" });
			}

			return json(
				{
					ok: false,
					error: "Not found",
					routes: [
						"POST /api/init",
						"GET /api/getMessages?mailboxId=<id>",
						"POST /api/saveMessage?mailboxId=<id>",
						"GET /api/getSettings?mailboxId=<id>",
						"POST /api/saveSettings?mailboxId=<id>",
						"GET /health",
					],
				},
				404,
			);
		} catch (error) {
			log("worker.fetch.error", {
				path: url.pathname,
				mailboxId,
				error: error instanceof Error ? error.message : String(error),
			});
			return json(
				{ ok: false, error: error instanceof Error ? error.message : "Unknown error" },
				500,
			);
		}
	},
};
