/**
 * 用户操作指南（请先阅读）
 * 1) 在 Cloudflare Dashboard -> Workers & Pages -> Create application -> Create Worker，新建一个独立 Worker。
 * 2) 将本文件完整粘贴到 Worker 编辑器并保存。
 * 3) 在 Worker Settings -> Variables / Bindings 中添加 Durable Object 绑定：
 *    - Variable name: MAILBOX_DO
 *    - Class name: MailboxDO
 * 4) 兼容性日期（Compatibility date）建议设置为较新日期（例如 2024-09-23 或更新）。
 * 5) 若需从主项目通过 HTTP 调用本 Worker：
 *    - POST /rpc/ensureDefaultAdmins?mailbox=<mailboxKey>
 *    - GET  /rpc/getFolders?mailbox=<mailboxKey>
 *    - GET  /rpc/getSettings?mailbox=<mailboxKey>
 *    - POST /rpc/saveSettings?mailbox=<mailboxKey>
 *    - GET  /rpc/getMessages?mailbox=<mailboxKey>
 *
 * wrangler.toml 迁移配置（启用 SQLite Durable Object 存储）示例：
 * [[migrations]]
 * tag = "v1"
 * new_sqlite_classes = ["MailboxDO"]
 */

function log(action, meta = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      action,
      ...meta,
    })
  );
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
    status: init.status || 200,
  });
}

function normalizeMailboxKey(input) {
  return (input || "default").trim().toLowerCase();
}

export class MailboxDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;

    log("do.constructor", {
      durableObjectId: this.ctx.id.toString(),
    });

    this.ctx.blockConcurrencyWhile(async () => {
      await this.initSchema();
    });
  }

  async initSchema() {
    log("do.initSchema.start", {
      durableObjectId: this.ctx.id.toString(),
    });

    const sql = this.ctx.storage.sql;

    sql.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        email TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )
    `);

    sql.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        subject TEXT,
        from_email TEXT,
        to_email TEXT,
        folder TEXT DEFAULT 'INBOX',
        snippet TEXT,
        received_at TEXT,
        raw_json TEXT
      )
    `);

    const existingFolders = [...sql.exec(`SELECT name FROM folders LIMIT 1`)];
    if (existingFolders.length === 0) {
      const now = new Date().toISOString();
      const defaults = [
        ["INBOX", "system", now],
        ["SENT", "system", now],
        ["DRAFTS", "system", now],
        ["TRASH", "system", now],
      ];

      for (const [name, type, createdAt] of defaults) {
        sql.exec(
          `INSERT OR IGNORE INTO folders (name, type, created_at) VALUES (?, ?, ?)`,
          name,
          type,
          createdAt
        );
      }
    }

    log("do.initSchema.done", {
      durableObjectId: this.ctx.id.toString(),
    });
  }

  async ensureDefaultAdmins(admins = []) {
    log("do.ensureDefaultAdmins.start", {
      durableObjectId: this.ctx.id.toString(),
      inputCount: Array.isArray(admins) ? admins.length : -1,
    });

    if (!Array.isArray(admins)) {
      return {
        ok: false,
        error: "admins must be an array",
      };
    }

    const sql = this.ctx.storage.sql;
    const now = new Date().toISOString();
    let inserted = 0;

    for (const emailRaw of admins) {
      const email = String(emailRaw || "").trim().toLowerCase();
      if (!email) continue;

      sql.exec(`INSERT OR IGNORE INTO admins (email, created_at) VALUES (?, ?)`, email, now);
      const check = [...sql.exec(`SELECT email FROM admins WHERE email = ?`, email)];
      if (check.length > 0) inserted += 1;
    }

    const allAdmins = [...sql.exec(`SELECT email, created_at FROM admins ORDER BY created_at ASC`)].map(
      (row) => ({
        email: row.email,
        createdAt: row.created_at,
      })
    );

    const result = {
      ok: true,
      inserted,
      admins: allAdmins,
    };

    log("do.ensureDefaultAdmins.done", {
      durableObjectId: this.ctx.id.toString(),
      totalAdmins: allAdmins.length,
    });

    return result;
  }

  async getFolders() {
    log("do.getFolders.start", {
      durableObjectId: this.ctx.id.toString(),
    });

    const rows = [...this.ctx.storage.sql.exec(`SELECT id, name, type, created_at FROM folders ORDER BY id ASC`)];
    const folders = rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      createdAt: row.created_at,
    }));

    log("do.getFolders.done", {
      durableObjectId: this.ctx.id.toString(),
      folderCount: folders.length,
    });

    return { ok: true, folders };
  }

  async getSettings() {
    log("do.getSettings.start", {
      durableObjectId: this.ctx.id.toString(),
    });

    const rows = [...this.ctx.storage.sql.exec(`SELECT key, value FROM settings`)];
    const settings = {};
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch {
        settings[row.key] = row.value;
      }
    }

    log("do.getSettings.done", {
      durableObjectId: this.ctx.id.toString(),
      settingCount: rows.length,
    });

    return { ok: true, settings };
  }

  async saveSettings(settings = {}) {
    log("do.saveSettings.start", {
      durableObjectId: this.ctx.id.toString(),
      keys: settings && typeof settings === "object" ? Object.keys(settings) : [],
    });

    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return { ok: false, error: "settings must be a plain object" };
    }

    const sql = this.ctx.storage.sql;
    const now = new Date().toISOString();

    for (const [key, value] of Object.entries(settings)) {
      sql.exec(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        JSON.stringify(value),
        now
      );
    }

    const result = await this.getSettings();

    log("do.saveSettings.done", {
      durableObjectId: this.ctx.id.toString(),
      savedKeyCount: Object.keys(settings).length,
    });

    return result;
  }

  async getMessages() {
    log("do.getMessages.start", {
      durableObjectId: this.ctx.id.toString(),
    });

    const rows = [...
      this.ctx.storage.sql.exec(`
        SELECT id, subject, from_email, to_email, folder, snippet, received_at
        FROM messages
        ORDER BY datetime(received_at) DESC
      `),
    ];

    const messages = rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      from: row.from_email,
      to: row.to_email,
      folder: row.folder,
      snippet: row.snippet,
      receivedAt: row.received_at,
    }));

    log("do.getMessages.done", {
      durableObjectId: this.ctx.id.toString(),
      messageCount: messages.length,
    });

    return { ok: true, messages };
  }

  async fetch(request) {
    const url = new URL(request.url);

    log("do.fetch.start", {
      durableObjectId: this.ctx.id.toString(),
      method: request.method,
      pathname: url.pathname,
    });

    try {
      if (request.method === "POST" && url.pathname === "/rpc/ensureDefaultAdmins") {
        const body = await request.json().catch(() => ({}));
        const result = await this.ensureDefaultAdmins(body.admins || []);
        return json(result, { status: result.ok ? 200 : 400 });
      }

      if (request.method === "GET" && url.pathname === "/rpc/getFolders") {
        return json(await this.getFolders());
      }

      if (request.method === "GET" && url.pathname === "/rpc/getSettings") {
        return json(await this.getSettings());
      }

      if (request.method === "POST" && url.pathname === "/rpc/saveSettings") {
        const body = await request.json().catch(() => ({}));
        const result = await this.saveSettings(body.settings || body);
        return json(result, { status: result.ok ? 200 : 400 });
      }

      if (request.method === "GET" && url.pathname === "/rpc/getMessages") {
        return json(await this.getMessages());
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "MailboxDO", durableObjectId: this.ctx.id.toString() });
      }

      return json(
        {
          ok: false,
          error: "Not found",
          hint: "Use /rpc/ensureDefaultAdmins, /rpc/getFolders, /rpc/getSettings, /rpc/saveSettings, /rpc/getMessages",
        },
        { status: 404 }
      );
    } catch (error) {
      log("do.fetch.error", {
        durableObjectId: this.ctx.id.toString(),
        error: error instanceof Error ? error.message : String(error),
      });

      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 }
      );
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const mailboxKey = normalizeMailboxKey(
      url.searchParams.get("mailbox") ||
        request.headers.get("x-mailbox") ||
        request.headers.get("x-mailbox-key") ||
        "default"
    );

    log("worker.fetch.start", {
      method: request.method,
      pathname: url.pathname,
      mailboxKey,
    });

    try {
      if (!env.MAILBOX_DO) {
        return json(
          {
            ok: false,
            error: "Missing MAILBOX_DO binding",
            hint: "Please bind Durable Object namespace MAILBOX_DO to class MailboxDO",
          },
          { status: 500 }
        );
      }

      const id = env.MAILBOX_DO.idFromName(mailboxKey);
      const stub = env.MAILBOX_DO.get(id);

      if (url.pathname === "/health") {
        const doRes = await stub.fetch("https://do.internal/health");
        return new Response(doRes.body, {
          status: doRes.status,
          headers: doRes.headers,
        });
      }

      const rpcPaths = new Set([
        "/rpc/ensureDefaultAdmins",
        "/rpc/getFolders",
        "/rpc/getSettings",
        "/rpc/saveSettings",
        "/rpc/getMessages",
      ]);

      if (rpcPaths.has(url.pathname)) {
        const forwardUrl = new URL(`https://do.internal${url.pathname}`);
        const forwarded = new Request(forwardUrl.toString(), request);
        return await stub.fetch(forwarded);
      }

      return json(
        {
          ok: false,
          error: "Unknown route",
          availableRoutes: [
            "GET /health",
            "POST /rpc/ensureDefaultAdmins?mailbox=<mailboxKey>",
            "GET /rpc/getFolders?mailbox=<mailboxKey>",
            "GET /rpc/getSettings?mailbox=<mailboxKey>",
            "POST /rpc/saveSettings?mailbox=<mailboxKey>",
            "GET /rpc/getMessages?mailbox=<mailboxKey>",
          ],
        },
        { status: 404 }
      );
    } catch (error) {
      log("worker.fetch.error", {
        pathname: url.pathname,
        mailboxKey,
        error: error instanceof Error ? error.message : String(error),
      });

      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 }
      );
    }
  },
};
