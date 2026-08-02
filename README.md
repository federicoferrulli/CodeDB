<p align="center">
  <img src="public/logo.png" alt="CodeDB Logo" width="128" />
</p>


# CodeDB

CodeDB was born taking inspiration from modern software, with the vision of being the tool that anyone can use in their unique workflow—human developers and AI agents alike.

It is a **multi-database** web-based application: explore databases, collections, and tables, view documents/rows in a spreadsheet-like grid, run custom queries, and edit data in real time.
Supports **MongoDB**, **MySQL**, and **PostgreSQL** via a **Strategy Pattern** architecture. All browser-to-backend communication runs seamlessly over **Socket.IO**.

*(Read this document in Italian: [README_IT.md](README_IT.md))*

## Tech Stack

- **Backend:** Node.js, Express, Socket.IO
  - MongoDB: native `mongodb` driver + `bson` (EJSON)
  - MySQL: `mysql2` (connection pool)
  - PostgreSQL: `pg` (connection pool)
  - Optional SSH tunneling via `ssh2`
- **Frontend:** Vanilla HTML/CSS/JS (no framework, no build step required)

## Getting Started

```bash
npm install
npm start          # or: npm run dev (watch mode with automatic reload)
```

Open <http://localhost:3030> (port configurable via the `PORT` environment variable).
The connection setup screen will appear. Select the **database type** (MongoDB, MySQL, or PostgreSQL) and enter the host/port/credentials or a full connection string (MongoDB).

### Desktop Launcher & PWA

The launcher opens your browser (or PWA app) if the server is already active; otherwise, it starts the server **in the background**:
The console window closes immediately after launch, and logs are written to `codedb.log`. The browser opens as soon as the server port responds, and the **Master Password** to unlock encrypted credentials is requested directly in the UI.
To stop the server: `CodeDB.cmd stop` / `./codedb.sh stop`.
If you launch a second instance on the same port, the server exits with a clear error message (use `PORT=<another_port>`).

- **Windows** — Double-click **`CodeDB.cmd`**; run `npm run shortcut` to create **CodeDB** shortcuts (`public/codedb.ico`) on your Desktop and Start Menu. Shortcuts point to `cmd.exe /c ...` allowing them to be pinned to the Taskbar or Start Menu.
- **Linux/macOS** — Run `./codedb.sh`; run `npm run shortcut-unix` on Linux to create a **CodeDB** menu entry (`~/.local/share/applications`, icon `public/codedb.png`). On macOS, the script displays instructions for Dock setup or Automator app creation.

Icons are procedurally generated via `node tools/genera-icona.js`.

### Desktop App (Electron) & Packaging

CodeDB supports native desktop execution and multi-platform packaging via Electron:

```bash
npm run electron:start  # Launch the desktop application with Electron
npm run electron:icons  # Regenerate procedural icons (.ico and .png)
npm run dist:win        # Create Windows executable & ZIP archive (in dist/CodeDB-win32-x64)
npm run dist:mac        # Create macOS desktop build (in dist/CodeDB-darwin-x64)
npm run dist:linux      # Create Linux desktop build & ZIP archive (in dist/CodeDB-linux-x64)
```

### End-to-End Tests

Requires the **server running on :3030** and local database instances listening on default ports.
Tests create and clean up the test databases (`gui_mongodb_e2e` / `gui_mysql_e2e`).

```bash
node test/e2e.js           # MongoDB on localhost:27017
node test/e2e-mysql.js     # Local MySQL (root, empty password; port env MYSQL_PORT, default 3306)
node test/e2e-mcp.js       # MCP gateway test on MongoDB
node test/e2e-mcp-mysql.js # MCP gateway test on MySQL (env MYSQL_PORT/MYSQL_PASSWORD)
node test/e2e-backup.js       # Backup CLI test on MongoDB (does not require running server)
node test/e2e-backup-mysql.js # Backup CLI test on MySQL (env MYSQL_PORT/MYSQL_PASSWORD)
```

### Backup and Restore

Dedicated CLI tool (does not require the server to be running), supporting both MongoDB and MySQL. Reuses saved connections from `connections.ini` (read-only) and SSH tunnels:

```bash
npm run backup -- backup  --conn local-mongo --db shop --type full
npm run backup -- backup  --conn local-mongo --db shop --type incremental --since-field updatedAt
npm run backup -- restore --conn local-mongo --from backups/local-mongo_shop/<id> --target-db shop_copy
npm run backup -- list
npm run backup -- verify  --from backups/local-mongo_shop/<id>
npm run backup -- help    # Full usage guide
```

- **Types:** `full`, `incremental` (changes since last backup), `differential` (changes since last full). During restoration, backup chains are resolved automatically. Note: Deleted documents are not captured in incremental/differential backups.
- **Format:** A directory per backup containing `manifest.json` (SHA-256 checksums), gzip-compressed Extended JSON NDJSON data (`--no-compress` to disable), indices (MongoDB), and `CREATE TABLE` DDLs (MySQL). Streaming dump and restore, suitable for large databases.
- **Cloud Storage:** Optional `--storage s3://bucket/prefix` (or `gs://`, `azure://`). Provider SDKs are loaded on demand and credentials use standard provider mechanisms.
- **Logging & Notifications:** Activity logged in `backups/backup.log`; optional Slack notification upon completion via `--slack-webhook <url>` or `SLACK_WEBHOOK_URL`.
- **Selective Restore:** `--collections a,b` limits restore; `--drop` drops and recreates target collections/tables.
- Backups are also available via **MCP** using `backup_database`, `list_backups`, and `restore_backup` tools (restore requires `readOnly=false` and human double-confirmation).

## Features

| Feature | Details |
| --- | --- |
| Multi-database | Support for MongoDB, MySQL, and PostgreSQL, selectable in the connection form |
| Connection Tabs | Open multiple database connections simultaneously (VS Code style), with isolated DB sessions per tab |
| Collection/Table Tabs | Open each collection/table in its own secondary tab with isolated query snapshots |
| Saved Connections | Left sidebar grouped by folders; context menu to open, test, edit, or delete |
| Import/Export Connections | Export and import full `.ini` files (including encrypted secrets) |
| SSH Tunneling | Connect via SSH (password or private key + passphrase), available in Parameters mode |
| DB & Collection Tree | Left tree view showing document/row counts |
| Grid View | Columns dynamically created from keys (MongoDB) or table columns (SQL) |
| `find` / WHERE Queries | Toolbar filter and sorting (JSON/EJSON for Mongo, WHERE clause + `ORDER BY` for MySQL/Postgres) |
| `aggregate` / Raw SQL | Aggregation pipelines (Mongo) or free-form SQL execution (MySQL/PostgreSQL) |
| ⚡ Query & Aggregate Engine | 3-section layout (Schema Browser, Editor, Results), SQL/MQL support, dual view (Table / JSON Tree), and Virtual JOINs |
| 🔀 Cross-DB Virtual JOINs | In-memory data joining across MySQL tables and MongoDB collections in a single query |
| 📚 Snippet Library | Ready-to-use templates (JOIN, GROUP BY, $lookup, $unwind) and export results to CSV/JSON/SQL |
| Execution Plan | `explain` (Mongo) / `EXPLAIN` (MySQL/Postgres) for current query |
| Query History | Persistent query execution history per collection |
| Sorting / Pagination | Click header to sort; bottom pagination bar (25/50/100/200 items per page) |
| Inline Cell Editing | Double-click cell to edit value inline |
| Row Editing | Full row JSON editor modal (✎ icon) |
| Insert Document/Row | Quick insert modal ("+ Document") |
| Deletion | Single row delete (✕ icon) or bulk delete on multiple selection |
| Cell Selection | Excel-like cell selection, multi-format copy (TSV/JSON/CSV/Markdown/SQL), paste, and CSV export |
| Import/Export Collection | Export to EJSON/CSV/SQL INSERT; batch import with progress bar and error reporting |
| Full DB Import/Export | Right-click database to export into self-contained `.codedb.json` file and import into target database |
| DB & Collection Management | Right-click tree menu: create, rename, drop databases and collections |
| Column Management (SQL) | Add, alter, or drop columns (DDL) |
| Collection Details | "Details" tab with statistics, indexes, and schema/column definitions |
| UML Diagram & 3D Graph | "3D Graph" tab featuring interactive 3D spatial visualizer (Three.js), shortest path (BFS), dependency matrix, schema health audit, PII/GDPR scanner, and empty table filter |
| Live Updates | MongoDB change streams (LIVE badge); automatic schema tree refreshing |
| Responsive Layout | Sidebar drawer for viewports ≤900px, touch/orientation support, and safe-area insets |
| AI Agent MCP Gateway | Streamable HTTP `/mcp` endpoint: database exploration, queries, BFS pathing, dependency tree, PII scanning, health audits, `graph://` resource, and prompts — see `docs/MCP.md` |
| Backup & Restore | CLI `npm run backup` (full/incremental/differential, gzip + SHA-256, cloud S3/GCS/Azure, Slack notifications) & MCP backup tools |

### Notes & Key Principles

- **Multi-database engine:** MongoDB uses EJSON and `ObjectId`; MySQL/PostgreSQL expose a virtual `_id` representing the primary key `{ col: val }` (or fallback to full row).
- **Session Isolation:** Each tab maintains its own server session (dedicated database client/pool + SSH tunnel, max 8 per socket).
- **Real-time Updates:** MongoDB real-time updates require Replica Sets or MongoDB Atlas. Standalone MongoDB gracefully degrades to manual refresh (⟳).
- **EJSON Support:** MongoDB filters accept Extended JSON, e.g. `{ "_id": { "$oid": "..." } }`. 24-character hex strings in `_id` are automatically converted to `ObjectId`.
- **Encrypted Credentials:** Saved connections live in `connections.ini` encrypted with AES-256-GCM via a Vault Master Passphrase. Secrets are never exposed to the browser.
- **MongoDB Database Renaming:** Renaming copies collections to the new database (`$out` cross-database) and drops the original (requires MongoDB ≥ 4.4).

## Documentation

- `docs/MCP.md` — Guide to setting up and using the MCP server with AI clients (Claude Code, Claude Desktop, Cursor...).
- `CLAUDE.md` / `AGENT.md` — Architectural guidance for coding agents.
- `strategy_db.md` — Design blueprint for multi-database strategies.
- `strategy_mcp.md` — MCP integration blueprint & roadmap.
- [CONTRIBUTING.md](CONTRIBUTING.md) — Guidelines for contributing to CodeDB.
- [SECURITY.md](SECURITY.md) — Security policy and vulnerability reporting guidelines.

## AI Transparency (EU AI Act Compliance)

In compliance with the transparency requirements of the EU AI Act, we disclose that portions of this software's codebase and documentation were generated, assisted, or implemented using Artificial Intelligence (AI) systems. Users should be aware that while the AI outputs are reviewed, they may not be entirely free of errors or biases.

## License

Copyright (c) 2026 Federico Ferrulli.

Distributed under the **GNU AGPL v3 (GNU Affero General Public License)**. See [LICENSE.md](LICENSE.md) for full terms.
