# Contributing to CodeDB

First off, thank you for taking the time to contribute! 🎉 CodeDB is an open-source, DBeaver-like multi-database GUI and MCP platform, and we welcome contributions of all kinds — bug fixes, new database strategies, UI enhancements, documentation, and tests.

---

## Table of Contents

- [Before You Start](#before-you-start)
  - [1. Open an Issue First](#1-open-an-issue-first)
  - [2. Code & Language Conventions](#2-code--language-conventions)
- [Repository Layout](#repository-layout)
- [Development Workflow](#development-workflow)
  - [1. Setup Local Environment](#1-setup-local-environment)
  - [2. Available Scripts](#2-available-scripts)
  - [3. Running Tests](#3-running-tests)
- [Architecture & Key Conventions](#architecture--key-conventions)
  - [Socket.IO Transport & State](#socketio-transport--state)
  - [Extended JSON (EJSON) Handling](#extended-json-ejson-handling)
  - [Strategy Pattern for Databases](#strategy-pattern-for-databases)
- [Submitting a Pull Request](#submitting-a-pull-request)

---

## Before You Start

### 1. Open an Issue First

**Always open an issue before opening a pull request.** This allows us to discuss the proposed changes, avoid duplicate effort, and align on design decisions before you invest significant time into coding.

- Search [existing issues](https://github.com/federicoferrulli/CodeDB/issues) first to see if your bug or idea already exists.
- If it doesn't, open a new **Bug Report** or **Feature Request**.
- Link your pull request to the corresponding issue using `Closes #<issue-number>`.

### 2. Code & Language Conventions

- **UI Language:** All UI text, user-facing error messages, and primary code documentation/comments are in **Italian**. Please maintain consistency.
- **Vanilla Frontend:** The web client (`public/`) is built with modern vanilla JavaScript and CSS — no external frontend framework or compilation steps are required.
- **Commit Messages:** Follow [Conventional Commits](https://www.conventionalcommits.org/) format (e.g. `feat: add postgres connection support`, `fix: handle null dates in grid`, `docs: update setup instructions`).

---

## Repository Layout

Below is a map of the primary components and directories in the repository:

| Component / Path | Description | Key Tech / Files |
| ---------------- | ----------- | ---------------- |
| `server.js` | Main backend server & Socket.IO handler | Node.js, Express, Socket.IO |
| `public/` | Web frontend application (vanilla JS & CSS) | `main.js`, `tabs.js`, `grid.js`, `dbtree.js`, `style.css` |
| `db/` | Database Strategy Pattern & engines | `DbStrategy.js`, `MongoDbStrategy.js`, `MySqlStrategy.js`, `PostgreSqlStrategy.js`, `VirtualJoinEngine.js` |
| `mcp/` | Model Context Protocol (MCP) gateway | `McpGateway.js` (Streamable HTTP `/mcp`) |
| `backup/` | CLI & engine for backup/restore | `cli.js`, `connect.js`, `connstore.js` |
| `electron-main.js` | Desktop app wrapper | Electron |
| `bin/codedb.js` | Executable CLI wrapper | Node.js |
| `test/` | End-to-end and unit test suites | `unit.js`, `e2e.js`, `e2e-mysql.js`, `e2e-mcp.js`, `e2e-query-engine.js`, `e2e-backup.js` |
| `tools/` | Utility scripts (icons, shortcuts, build scripts) | `build-desktop.mjs`, `genera-icona.js` |

---

## Development Workflow

### 1. Setup Local Environment

1. **Fork** the repository and **clone** your fork:
   ```bash
   git clone https://github.com/<your-username>/gui-mongodb.git
   cd gui-mongodb
   ```
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Start the development server** (with automatic restart on changes via `node --watch`):
   ```bash
   npm run dev
   ```
   The application will be accessible at `http://localhost:3030`.

### 2. Available Scripts

| Script | Command / Description |
| ------ | --------------------- |
| `npm start` | Start the server on `http://localhost:3030` |
| `npm run dev` | Start the server in watch mode (`node --watch server.js`) |
| `npm run electron:start` | Start the desktop Electron app (embedded server + window) |
| `npm run electron:icons` | Regenerate app icons (`public/codedb.ico`, `build/icon.ico`) |
| `npm run dist:win` | Package the Windows executable (`dist/`) using `@electron/packager` |
| `npm run dist:mac` | Package the macOS application (`dist/`) |
| `npm run dist:linux` | Package the Linux AppImage (`dist/`) |
| `npm run shortcut` | Create CodeDB shortcuts on Windows Desktop and Start Menu |
| `npm run backup` | Access the CLI backup/restore tool |

### 3. Running Tests

Tests are standalone scripts using standard Node.js `assert`. E2E tests require a running server (`http://localhost:3030`) and local database instances (e.g., MongoDB at `localhost:27017` or MySQL at `localhost:3306`).

```bash
# Run unit tests
npm test

# Run MongoDB end-to-end tests
node test/e2e.js

# Run MySQL end-to-end tests
node test/e2e-mysql.js

# Run MCP gateway end-to-end tests
node test/e2e-mcp.js
node test/e2e-mcp-mysql.js

# Run Query Engine & Virtual JOINs tests
node test/e2e-query-engine.js

# Run Backup CLI tests (server not required)
node test/e2e-backup.js
node test/e2e-backup-mysql.js

# Run Full Database export/import tests
node test/e2e-dbexport.js
```

---

## Architecture & Key Conventions

### Socket.IO Transport & State

- Almost all communication between frontend and backend flows through **Socket.IO** (with acknowledgment callbacks).
- Every event response follows the payload contract: `{ ok: true, ... }` or `{ ok: false, error: "..." }`.
- Backend database sessions are held per tab using a `tabId` key within `server.js` (`Map<tabId, session>`). Frontend requests inject `tabId` automatically via `emit()` in `utils.js`.

### Extended JSON (EJSON) Handling

- Data exchanged between server and client utilizes **Extended JSON (EJSON)** to preserve types (`$oid`, `$date`, `$numberLong`, etc.).
- The server parses incoming payloads with `EJSON.parse(...)` and serializes responses with `EJSON.serialize(..., { relaxed: true })`.
- Frontend grid components render and parse these EJSON types seamlessly. Any pull request touching data flow must preserve EJSON formatting across both client and server.

### Strategy Pattern for Databases

- Database integration relies on `DbStrategy.js`.
- Specialized implementations live in `MongoDbStrategy.js`, `MySqlStrategy.js`, and `PostgreSqlStrategy.js`.
- If adding a new database engine or extending capabilities, extend `DbStrategy.js` and register the engine in `DbFactory.js`.

---

## Submitting a Pull Request

1. Create a feature branch from `develop`:
   ```bash
   git checkout -b feature/my-feature-name
   ```
2. Write clean, self-documented code and add appropriate test coverage.
3. Ensure all relevant unit and E2E tests pass.
4. Commit your changes using Conventional Commit standards:
   ```bash
   git commit -m "feat description of new capability"
   ```
5. Push to your fork and submit a **Pull Request** targeting the `develop` branch.
6. Link the issue in your PR description: `Closes #<issue-number>`.

Thank you for helping make **CodeDB** better! 🚀
