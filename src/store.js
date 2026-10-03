import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATABASE_NAME = "hookscope.sqlite";

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class CaptureStore {
  constructor(config) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.filePath = path.join(config.dataDir, DATABASE_NAME);
    this.db = new DatabaseSync(this.filePath);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;",
    );
    const maxPages = Math.floor(config.maxDbBytes / 4096);
    const pageLimit = this.db
      .prepare(`PRAGMA max_page_count = ${maxPages}`)
      .get().max_page_count;
    if (pageLimit > maxPages) {
      this.db.close();
      throw new Error(
        `Existing database needs ${pageLimit * 4096} bytes of page space, above HOOKSCOPE_MAX_DB_BYTES.`,
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        received_at TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        raw_query TEXT NOT NULL,
        query_json TEXT NOT NULL,
        headers_json TEXT NOT NULL,
        content_type TEXT NOT NULL,
        body BLOB NOT NULL,
        body_size INTEGER NOT NULL,
        replay_json TEXT
      );
      CREATE INDEX IF NOT EXISTS captures_received_at ON captures(received_at DESC);
      CREATE INDEX IF NOT EXISTS captures_endpoint ON captures(endpoint, received_at DESC);
    `);
    this.maxCaptures = config.maxCaptures;
    this.insertStatement = this.db.prepare(`
      INSERT INTO captures (id, endpoint, received_at, method, path, raw_query, query_json, headers_json, content_type, body, body_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.pruneStatement = this.db.prepare(`
      DELETE FROM captures WHERE id IN (
        SELECT id FROM captures ORDER BY received_at DESC, rowid DESC LIMIT -1 OFFSET ?
      )
    `);
    this.pruneStatement.run(this.maxCaptures);
  }

  insert(capture) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.pruneStatement.run(Math.max(0, this.maxCaptures - 1));
      this.insertStatement.run(
        capture.id,
        capture.endpoint,
        capture.receivedAt,
        capture.method,
        capture.path,
        capture.rawQuery,
        JSON.stringify(capture.query),
        JSON.stringify(capture.headers),
        capture.contentType,
        capture.body,
        capture.body.byteLength,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list({ endpoint = "", method = "", query = "", limit = 50 } = {}) {
    const rows = this.db
      .prepare(
        `
      SELECT id, endpoint, received_at, method, path, raw_query, query_json, content_type, body_size, replay_json
      FROM captures ORDER BY received_at DESC, rowid DESC LIMIT ?
    `,
      )
      .all(this.maxCaptures);
    const normalizedQuery = query.toLowerCase();
    return rows
      .filter((row) => {
        if (endpoint && row.endpoint !== endpoint) return false;
        if (method && row.method !== method) return false;
        if (normalizedQuery) {
          const haystack = [row.endpoint, row.method, row.path, row.raw_query]
            .join("\n")
            .toLowerCase();
          if (!haystack.includes(normalizedQuery)) return false;
        }
        return true;
      })
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        endpoint: row.endpoint,
        receivedAt: row.received_at,
        method: row.method,
        path: row.path,
        rawQuery: row.raw_query,
        query: parseJson(row.query_json, []),
        contentType: row.content_type,
        bodySize: row.body_size,
        replay: parseJson(row.replay_json, null),
      }));
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM captures WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: row.id,
      endpoint: row.endpoint,
      receivedAt: row.received_at,
      method: row.method,
      path: row.path,
      rawQuery: row.raw_query,
      query: parseJson(row.query_json, []),
      headers: parseJson(row.headers_json, []),
      contentType: row.content_type,
      body: Buffer.from(row.body),
      bodySize: row.body_size,
      replay: parseJson(row.replay_json, null),
    };
  }

  delete(id) {
    return (
      this.db.prepare("DELETE FROM captures WHERE id = ?").run(id).changes > 0
    );
  }

  saveReplay(id, replay) {
    return (
      this.db
        .prepare("UPDATE captures SET replay_json = ? WHERE id = ?")
        .run(JSON.stringify(replay), id).changes > 0
    );
  }

  close() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.db.close();
  }
}
