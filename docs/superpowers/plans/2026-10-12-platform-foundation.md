# Multi-Game Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a separately runnable, headless PostgreSQL-backed `/v2` service with organizer-owned games, game-scoped players, configurable one-choice-question rounds, durable idempotent submission, and recoverable settlement, while preserving the existing application.

**Architecture:** Add a parallel `src/platform/` runtime; do not convert or overwrite the old SQLite database. Put `game_id` on every game-owned row, enforce composite foreign keys, and require a game scope in each repository operation. Use bounded asynchronous `pg` pools, transaction helpers, explicit server receipt times, and a separate local archive of the old database. This phase is an independently testable API foundation, not a claim that the final 10,000-in-one-second capacity or pixel UI has shipped.

**Tech Stack:** Node.js 24.x, native HTTP, `pg` 8.23.1, local PostgreSQL, Node test runner; old Node `node:sqlite` is used only to archive and run the old application.

**Spec:** `docs/superpowers/specs/2026-10-12-general-quiz-platform-design.md`

## Global Constraints

- Keep the old `src/server/`, `public/`, `data/`, legacy tests, and old start command operational in this phase; do not import the old activity into PostgreSQL.
- Build a blank platform: no activity-specific title, teams, grades, question counts, time limits, prize defaults, or visual assets in new code.
- Participants are scoped to one game; organizer access is checked on every management operation. No publicly supplied `playerId` or `gameId` bypasses the session.
- Send a success receipt only **after** a PostgreSQL transaction commits. A valid request received before the deadline can finish writing afterward; a new request received afterward is late. Retry the same key/content safely.
- Do not assert 10,000-player capacity in this phase. The final gate is 5 games × 2,000 players, 10,000 submissions initiated within 1 second, all durable receipts within 5 seconds through the actual public entry on the target computer.
- Existing `.gitignore` edits and `.codex/` files belong to someone else. Never stage, revert, or overwrite them.
- Database test commands must fail if `TEST_DATABASE_URL` is missing or does not target a database named `quiz_platform_test`; skipping tests is not a passing PostgreSQL test.

## Review Focus

1. **Guessed IDs from another game:** Task 4 and Task 7 tests attempt to read/start/submit another game's records; all are rejected without disclosing data.
2. **Two starts or submissions racing:** Task 6 and Task 7 tests issue simultaneous calls; one start wins, and one request key produces one persisted receipt.
3. **Deadline and slow database:** Task 7 tests a request admitted just before expiry but committed after it, and a new request admitted exactly at expiry; only the first can count.
4. **Malformed or oversized JSON:** Task 3 and Task 7 test invalid JSON, bodies above 64 KiB, foreign question IDs, and invalid option indices; no answer is persisted.
5. **Database failure during write:** Task 2 and Task 7 tests force rollback or terminate the transaction, check connection release and absence of a success receipt.

---

## File Map

- `scripts/archive-legacy.mjs`: one-way SQLite backup and archive manifest; never initializes the old application database.
- `src/platform/db/{pool,migrate}.mjs`, `src/platform/db/migrations/001_foundation.sql`: local PostgreSQL connection limit, transaction helper, idempotent schema setup, composite tenant keys and indexes.
- `src/platform/http/{app,errors}.mjs`: separate bounded HTTP API shell, origin/CSRF/cookie policy, server-side request-completion timestamp, route dispatch.
- `src/platform/auth/{password,sessions}.mjs`, `src/platform/organizers/{repository,routes}.mjs`: nonblocking password verification, organizer login, membership and session handling.
- `src/platform/games/{repository,routes}.mjs`: blank games and owner-scoped read/write.
- `src/platform/players/{repository,routes}.mjs`: per-game player registration, login, game-specific cookies and recovery contract.
- `src/platform/quiz/{repository,routes,scoring}.mjs`: versioned headless round setup, manual start, player questions, durable submissions, settlement.
- `src/platform/main.mjs`, `scripts/platform-{bootstrap,migrate}.mjs`: separate runtime, migration/startup, first platform administrator.
- `tests/platform/{helpers,archive,db,http,organizers,games,players,rounds,submissions,integration}.test.mjs`: real isolated PostgreSQL schemas and targeted regression tests.
- `docs/platform-local-runbook.md`, `package.json`, `package-lock.json`, `.github/workflows/platform-tests.yml`: local setup, new scripts/dependency, dedicated PostgreSQL CI service.

### Task 1: Archive the legacy data without importing it

**Files:** Create `scripts/archive-legacy.mjs`, `tests/platform/archive.test.mjs`; reuse read-only `scripts/backup-check.mjs`.

**Interfaces:** `archiveLegacy({ source, archiveDir }): Promise<{snapshot,manifest,sha256,counts}>`; CLI `node scripts/archive-legacy.mjs data/game.sqlite "$HOME/Documents/quiz-legacy-archive-2026-10-12"`.

- [ ] **Step 1: Write failing test.** Make a temporary SQLite fixture, write a row after WAL is enabled, and call `archiveLegacy`. Assert `inspectBackup(snapshot).players === 1`, original file unchanged, `sha256` matches archived bytes, and archiveDir inside the repository is rejected.

```js
const result = await archiveLegacy({ source: fixture.path, archiveDir: externalDir });
assert.equal(inspectBackup(result.snapshot).players, 1);
assert.equal(createHash("sha256").update(readFileSync(result.snapshot)).digest("hex"), result.sha256);
await assert.rejects(archiveLegacy({ source: fixture.path, archiveDir: projectRoot }), /仓库外/);
```

- [ ] **Step 2: Run test red.** `node --test tests/platform/archive.test.mjs` must fail because the module/function is absent.
- [ ] **Step 3: Implement.** Open source with `new DatabaseSync(source, {readOnly:true})`; use `await backup(db, tempPath)` rather than copying the main SQLite file, inspect the snapshot, compute SHA-256, write a restrictive manifest with counts and file hash, and atomically rename the temp snapshot into a newly created `0700` directory outside the project. Reject existing destination and symlinks, never print player records.

```js
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, temporary); } finally { db.close(); }
const counts = inspectBackup(temporary);
const sha256 = createHash("sha256").update(readFileSync(temporary)).digest("hex");
renameSync(temporary, snapshot);
writeFileSync(manifest, JSON.stringify({ sha256, counts }), { mode: 0o600, flag: "wx" });
```

- [ ] **Step 4: Run test green and check private permissions.** `node --test tests/platform/archive.test.mjs`; inspect `statSync(snapshot).mode & 0o077` and the source hash before/after.
- [ ] **Step 5: Commit only the two files.** `git add scripts/archive-legacy.mjs tests/platform/archive.test.mjs && git commit -m "feat: archive legacy sqlite outside platform"`.

### Task 2: Establish PostgreSQL migrations and bounded transactions

**Files:** Create `src/platform/db/pool.mjs`, `src/platform/db/migrate.mjs`, `src/platform/db/migrations/001_foundation.sql`, `tests/platform/helpers.mjs`, `tests/platform/db.test.mjs`; modify `package.json`, create `package-lock.json`.

**Interfaces:** `createPlatformPool({ connectionString, max=16 }): Pool`; `withTransaction(pool, operation): Promise<T>` where `operation(client)` returns `T`; `migrate(pool): Promise<void>`; `newPlatformFixture(): Promise<{pool,close}>` uses `TEST_DATABASE_URL` and a fresh random PostgreSQL schema.

- [ ] **Step 1: Write failing tests.** Test two consecutive migrations are idempotent, a deliberately thrown transaction leaves no inserted row, and the connection is available afterward. Assert cross-game composite references fail even when guessed UUIDs exist in another game.

```js
await migrate(pool);
await migrate(pool);
await assert.rejects(withTransaction(pool, async (client) => {
  await client.query("INSERT INTO organizers(id,login,password_hash) VALUES($1,$2,$3)",
    [randomUUID(), "rollback-test", "hash"]);
  throw new Error("abort");
}), /abort/);
assert.equal((await pool.query("SELECT count(*)::int AS n FROM organizers WHERE login='rollback-test'")).rows[0].n, 0);
await assert.rejects(pool.query(
  "INSERT INTO questions(game_id,id,round_id,position,kind,prompt,options_json,correct_option,points) VALUES($1,$2,$3,1,'choice','Q','[\"A\",\"B\"]',0,7)",
  [gameB.id, randomUUID(), roundFromGameA.id]
), (error) => error.code === "23503");
```

- [ ] **Step 2: Run test red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/db.test.mjs`; absence of PostgreSQL is a setup failure, not a skip.
- [ ] **Step 3: Implement pool, migration and fixture.** Add `pg@8.23.1` and `test:platform` as `node --test tests/platform/*.test.mjs`. Make `migrate` acquire a transaction-scoped advisory lock, create `schema_migrations`, apply numbered SQL once, then commit. Fixture validates parsed database name `quiz_platform_test`, creates schema `test_<hex>` and configures its pool search path, drops it on close. Initial SQL tables: `organizers`, `organizer_sessions`, `games`, `game_members`, `game_versions`, `players`, `player_sessions`, `rounds`, `questions`, `submissions`, `round_scores`, `audit_events`. Use UUID IDs, `game_id` on all game rows, composite foreign keys `(game_id, id)`, scoped unique keys for player credentials, `(game_id, player_id, round_id, request_key)`, and indexed `(game_id, round_id, revision)`/publication queries; global game slugs have their own unique key. The migration has **no seed rows**.

```js
export async function withTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
```

```sql
CREATE TABLE organizers (
  id uuid PRIMARY KEY, login text NOT NULL UNIQUE,
  password_hash text NOT NULL, platform_admin boolean NOT NULL DEFAULT false
);
CREATE TABLE games (
  id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, title text NOT NULL,
  owner_id uuid NOT NULL REFERENCES organizers(id), status text NOT NULL DEFAULT 'draft'
);
CREATE TABLE rounds (
  game_id uuid NOT NULL REFERENCES games(id), id uuid NOT NULL, position integer NOT NULL,
  title text NOT NULL, duration_ms integer NOT NULL, status text NOT NULL DEFAULT 'prepared',
  started_at bigint, deadline_at bigint, published_at bigint, config_version integer NOT NULL,
  PRIMARY KEY(game_id,id), UNIQUE(game_id,position)
);
CREATE TABLE questions (
  game_id uuid NOT NULL, id uuid NOT NULL, round_id uuid NOT NULL, position integer NOT NULL,
  kind text NOT NULL, prompt text NOT NULL, options_json jsonb NOT NULL,
  correct_option integer NOT NULL, points integer NOT NULL,
  PRIMARY KEY(game_id,id), UNIQUE(game_id,round_id,position),
  FOREIGN KEY(game_id,round_id) REFERENCES rounds(game_id,id)
);
CREATE UNIQUE INDEX only_one_open_round_per_game ON rounds(game_id) WHERE status='open';
```

The remaining tables use the same composite-FK pattern: `game_members(game_id,organizer_id,role)`; `game_versions(game_id,version,config_json)`; `players(game_id,id,display_name,login_code,password_hash)`; `player_sessions(token_hash,game_id,player_id,created_at,revoked_at)`; `organizer_sessions(token_hash,organizer_id,expires_at)`; `submissions(game_id,id,player_id,round_id,request_key,answers_json,revision,submitted_at)`; `round_scores(game_id,player_id,round_id,points,detail_json)`; `audit_events(id,game_id,actor_id,kind,target_id,occurred_at,details_json)`. Add scoped foreign keys on every player/round reference, `UNIQUE(game_id,login_code)`, `UNIQUE(game_id,player_id,round_id,request_key)` and `UNIQUE(game_id,player_id,round_id,revision)`. In production SQL use `CHECK` constraints for statuses, roles, positive duration and nonnegative points.

- [ ] **Step 4: Run tests green and inspect schema.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:platform`; assert `SELECT count(*) FROM games` is zero in a fresh schema, not four default rounds.
- [ ] **Step 5: Commit.** `git add package.json package-lock.json src/platform/db tests/platform/helpers.mjs tests/platform/db.test.mjs && git commit -m "feat: add isolated postgres platform schema"`.

### Task 3: HTTP boundary and organizer authentication

**Files:** Create `src/platform/http/app.mjs`, `src/platform/http/errors.mjs`, `src/platform/auth/password.mjs`, `src/platform/auth/sessions.mjs`, `src/platform/organizers/repository.mjs`, `src/platform/organizers/routes.mjs`, `tests/platform/http.test.mjs`, `tests/platform/organizers.test.mjs`.

**Interfaces:** `buildPlatformApp({pool, clock=Date.now, publicOrigin}): {listen,close,route}`; route handler receives `{req,body,params,receivedAt,pool}`; `hashPassword(password): Promise<string>` and `verifyPassword(password,hash): Promise<boolean>` use asynchronous `scrypt`; `createOrganizer(pool,{login,password,platformAdmin=false}): Promise<organizer>`; `requireOrganizer(pool,req): Promise<organizer>`; `registerOrganizerRoutes(app): void`. Endpoints `POST /v2/auth/login`, `POST /v2/auth/logout`, `POST /v2/organizers` (platform-admin only).

- [ ] **Step 1: Write failing HTTP and auth tests.** Register a POST echo route; reject malformed JSON, >64 KiB, missing custom action header, and cross-site Origin before executing handler. For organizer login, verify secure HttpOnly SameSite cookie, wrong password 401, player cookie never authenticates organizer, and logout revokes session. A platform administrator can provision a new organizer; an ordinary organizer cannot.

```js
const bad = await fetch(base + "/v2/auth/login", {
  method: "POST", headers: { origin: "https://attacker.invalid", "x-quiz-action": "1" },
  body: JSON.stringify({ login: "owner", password: "wrong" })
});
assert.equal(bad.status, 403);
assert.equal((await pool.query("SELECT count(*)::int AS n FROM organizer_sessions")).rows[0].n, 0);
```

- [ ] **Step 2: Run tests red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/http.test.mjs tests/platform/organizers.test.mjs` fails for missing exports.
- [ ] **Step 3: Implement separate HTTP shell and auth.** Count streamed bytes without repeated `Buffer.concat`; capture `receivedAt=clock()` after the complete body, before pool acquisition. Require the exact configured HTTPS Origin for unsafe public requests, enforce `x-quiz-action: 1`, parse only JSON, return controlled 400/403/413/500. Organizer password hashes use promisified `scrypt`; store only token hashes. Throttle wrong-login attempts by login identifier and source address; session cookies are Secure/HttpOnly/SameSite=Strict in public HTTPS mode, never set by untrusted proxy headers. Require explicit local-only mode for HTTP development.

```js
let bytes = 0;
for await (const chunk of req) {
  bytes += chunk.length;
  if (bytes > 65_536) throw httpError(413, "请求过大");
  chunks.push(chunk);
}
const receivedAt = clock();
const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
```

- [ ] **Step 4: Run tests green.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/http.test.mjs tests/platform/organizers.test.mjs`; verify organizer login does not block an unrelated request during password hashing.
- [ ] **Step 5: Commit.** `git add src/platform/http src/platform/auth src/platform/organizers tests/platform/http.test.mjs tests/platform/organizers.test.mjs && git commit -m "feat: isolate platform http and organizer identity"`.

### Task 4: Create games with tenant-scoped organizer access

**Files:** Create `src/platform/games/repository.mjs`, `src/platform/games/routes.mjs`, `tests/platform/games.test.mjs`; modify `src/platform/http/app.mjs` only to register game routes.

**Interfaces:** `createGame(pool,organizerId,{slug,title}): Promise<game>`; `getGameForMember(pool,gameId,organizerId): Promise<game>`; `requireGameRole(pool,gameId,organizerId,roles): Promise<void>`; `registerGameRoutes(app): void`. Expose `POST /v2/games`, `GET /v2/games`, `GET /v2/games/:gameId` for organizer sessions.

- [ ] **Step 1: Write failing tests.** Two organizers create games. Assert a fresh game is `draft` with no rounds/questions/players; list contains only member games; second organizer cannot GET or mutate the first by UUID. Reject duplicate or unsafe slug; verify duplicate membership and owner creation are atomic.

```js
const a = await createGame(pool, alice.id, { slug: "science-night", title: "Science Night" });
await assert.rejects(getGameForMember(pool, a.id, bob.id), (e) => e.status === 404);
assert.equal((await pool.query("SELECT count(*)::int AS n FROM game_members WHERE game_id=$1", [a.id])).rows[0].n, 1);
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/games.test.mjs`.
- [ ] **Step 3: Implement game repository and routes.** `createGame` inserts game, owner membership and empty `game_versions` entry in one transaction; all reads join `game_members` with both IDs. Slug is immutable, lowercase ASCII `[a-z0-9-]{3,48}` and globally unique for join links; title is trimmed and length-limited; return 404 for unscoped guessed IDs. Record game creation in the audit table. No default activity, round or score configuration.

```js
return withTransaction(pool, async (client) => {
  const game = (await client.query(
    "INSERT INTO games(id,slug,title,status,owner_id) VALUES($1,$2,$3,'draft',$4) RETURNING *",
    [randomUUID(), slug, title, organizerId])).rows[0];
  await client.query("INSERT INTO game_members(game_id,organizer_id,role) VALUES($1,$2,'owner')",
    [game.id, organizerId]);
  return game;
});
```

- [ ] **Step 4: Run green.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/games.test.mjs`, including HTTP permission checks, not just direct repository tests.
- [ ] **Step 5: Commit.** `git add src/platform/games src/platform/http/app.mjs tests/platform/games.test.mjs && git commit -m "feat: create isolated organizer-owned games"`.

### Task 5: Game-specific player registration and sessions

**Files:** Create `src/platform/players/repository.mjs`, `src/platform/players/routes.mjs`, `tests/platform/players.test.mjs`; modify `src/platform/http/app.mjs` to register player routes.

**Interfaces:** `registerPlayer(pool,gameId,{displayName,password}): Promise<{playerId,loginCode,sessionToken}>`; `requirePlayerForGame(pool,req,gameId): Promise<playerId>`; `registerPlayerRoutes(app)`. Endpoints `POST /v2/games/:slug/players`, `POST /v2/games/:slug/login`, `POST /v2/games/:slug/logout`, `GET /v2/games/:slug/me`.

- [ ] **Step 1: Write failing tests.** Two games allow the same display name with separate UUIDs, login codes and scores. A valid game A cookie cannot read game B's `/me` or submit there; switching browser tabs preserves both game sessions. Password is 10–128 chars and never returned or stored in plaintext; logout revokes just the selected game's session.

```js
const first = await registerPlayer(pool, gameA.id, { displayName: "Player", password: "secure-password-1" });
const second = await registerPlayer(pool, gameB.id, { displayName: "Player", password: "secure-password-2" });
assert.notEqual(first.playerId, second.playerId);
await assert.rejects(requirePlayerForGame(pool, requestWithCookie(first, gameA), gameB.id),
  (e) => e.status === 401);
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/players.test.mjs`.
- [ ] **Step 3: Implement.** Registration requires a published/joinable game, display name, password; generate random game-scoped login code and a hashed session token. Use a game-specific cookie name derived from immutable slug so one browser may join more than one game, while a request to another game never authenticates with the wrong cookie. Use async password work and bounded failed-login limits; recovery via operator-issued one-time token can be added with the complete organizer UI in the next plan, so do not claim it works yet.

```js
const hash = await hashPassword(password);
const token = randomBytes(32).toString("base64url");
await client.query(`INSERT INTO player_sessions(token_hash,game_id,player_id,created_at)
  VALUES($1,$2,$3,$4)`, [digest(token), gameId, playerId, now]);
return { playerId, loginCode, sessionToken: token };
```

- [ ] **Step 4: Run green.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/players.test.mjs`, including both cookies in the same browser header and an invalid/expired token.
- [ ] **Step 5: Commit.** `git add src/platform/players src/platform/http/app.mjs tests/platform/players.test.mjs && git commit -m "feat: add game-scoped player identity"`.

### Task 6: Headless configurable round and question lifecycle

**Files:** Create `src/platform/quiz/repository.mjs`, `src/platform/quiz/routes.mjs`, `tests/platform/rounds.test.mjs`; modify `src/platform/http/app.mjs` to register quiz routes.

**Interfaces:** `createRound(pool,gameId,organizerId,{position,title,durationMs,questions}): Promise<round>`; `publishGame(pool,gameId,organizerId): Promise<game>`; `startRound(pool,gameId,roundId,organizerId,now): Promise<round>`; `getPublicRound(pool,gameId,roundId): Promise<{round,questions}>`. Endpoints `POST /v2/games/:gameId/rounds`, `POST /v2/games/:gameId/publish`, `POST /v2/games/:gameId/rounds/:roundId/start` (member-only), `GET /v2/games/:slug/rounds/:roundId` (public). In this foundation phase `questions` accept `kind:"choice"`, 2–6 options, `correctOption`, integer `points`; Task 7 consumes the stored rule version.

- [ ] **Step 1: Write failing tests.** Games A and B have different round counts, question counts, durations, titles and points; neither inherits four rounds or 300 seconds. Cannot publish an empty game, edit a started round or start another game's round. Two concurrent start attempts produce exactly one start timestamp; player GET before opening hides answers and unpublished questions.

```js
const one = await createRound(pool, gameA.id, ownerA.id, {
  position: 1, title: "Quiz", durationMs: 90_000,
  questions: [{ position: 1, kind: "choice", prompt: "2+2?", options: ["3","4"],
    correctOption: 1, points: 7 }]
});
const [a,b] = await Promise.allSettled([
  startRound(pool, gameA.id, one.id, ownerA.id, 1000),
  startRound(pool, gameA.id, one.id, ownerA.id, 1000)
]);
assert.equal([a,b].filter((x) => x.status === "fulfilled").length, 1);
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/rounds.test.mjs`.
- [ ] **Step 3: Implement validated question setup, publishing and transaction-safe start.** Round creation and question insertion share one transaction; duration is integer milliseconds within explicit 30 seconds–60 minutes, positions unique and contiguous. Every query includes `game_id`; `UPDATE` with `status='prepared'` and `RETURNING` guards duplicate starts, a database partial unique index prevents two `open` rounds per game, and `deadline_at = now + duration_ms`. Snapshot/config version is fixed at start. Publishing requires at least one complete round. Record create, publish and start as scoped audit events.

```js
const started = await client.query(`UPDATE rounds SET status='open',started_at=$3,deadline_at=$3+duration_ms
  WHERE game_id=$1 AND id=$2 AND status='prepared' RETURNING *`, [gameId, roundId, now]);
if (!started.rowCount) throw httpError(409, "轮次已开启或不存在");
```

- [ ] **Step 4: Run green.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/rounds.test.mjs`; verify HTTP routes too, including no `correctOption` before publication.
- [ ] **Step 5: Commit.** `git add src/platform/quiz src/platform/http/app.mjs tests/platform/rounds.test.mjs && git commit -m "feat: add configurable headless game rounds"`.

### Task 7: Durable, idempotent submissions and recoverable settlement

**Files:** Modify `src/platform/quiz/repository.mjs`, `src/platform/quiz/routes.mjs`, `src/platform/http/app.mjs`; create `src/platform/quiz/scoring.mjs`, `tests/platform/submissions.test.mjs`, `tests/platform/integration.test.mjs`.

**Interfaces:** `submitAnswers(pool,{gameId,playerId,roundId,answers,requestKey,receivedAt}): Promise<{id,revision,submittedAt}>`; `settleDueRounds(pool,now): Promise<roundId[]>`; `scoreChoice(question,answer): number`. Endpoints `POST /v2/games/:slug/rounds/:roundId/submit`, `GET /v2/games/:slug/rounds/:roundId/my`, `GET /v2/games/:slug/standings`.

- [ ] **Step 1: Write failing integration tests.** Across five games, accept independent submissions with identical keys; retry same key/content after deadline returns same receipt; same key/different answers conflicts; invalid question/option rejected; a game A cookie cannot post to game B. Simulate slow pool access after a predeadline `receivedAt`, then exact-deadline arrival; only the earlier request is accepted. Crash/rollback injection produces no receipt, no row, and a reusable pool connection. Two concurrent same-player submissions get distinct increasing revisions and final score matches latest valid revision.

```js
const first = await submitAnswers(pool, { gameId, playerId, roundId,
  answers: { [questionId]: 1 }, requestKey: "same", receivedAt: deadline - 1 });
assert.deepEqual(await submitAnswers(pool, { gameId, playerId, roundId,
  answers: { [questionId]: 1 }, requestKey: "same", receivedAt: deadline + 1 }), first);
await assert.rejects(submitAnswers(pool, { gameId, playerId, roundId,
  answers: { [questionId]: 0 }, requestKey: "same", receivedAt: deadline + 1 }), /冲突/);
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/submissions.test.mjs tests/platform/integration.test.mjs`.
- [ ] **Step 3: Implement submit transaction.** Authenticate session and validate known question IDs and option indices server-side. Lock the `(game_id,player_id)` row to serialize that player's revisions, look up idempotency first, then validate recorded server `receivedAt` against the stored deadline and require `status='open'` or an admitted-but-draining round. `identicalOrConflict(row, answers)` returns `{id,revision,submittedAt}` only if `isDeepStrictEqual(row.answers_json, answers)`; otherwise it throws HTTP 409. Use `INSERT ... RETURNING` and commit before responding; `jsonb` comparison ignores input object-key order. Do not score or rebuild standings on the request path.

```js
function identicalOrConflict(row, answers) {
  if (!isDeepStrictEqual(row.answers_json, answers)) throw httpError(409, "提交标识冲突");
  return { id: row.id, revision: row.revision, submittedAt: Number(row.submitted_at) };
}
export function scoreChoice(question, answer) {
  return answer === question.correct_option ? question.points : 0;
}
return withTransaction(pool, async (client) => {
  await client.query("SELECT id FROM players WHERE game_id=$1 AND id=$2 FOR UPDATE", [gameId, playerId]);
  const old = await client.query(`SELECT id,revision,submitted_at,answers_json FROM submissions
    WHERE game_id=$1 AND player_id=$2 AND round_id=$3 AND request_key=$4`,
    [gameId, playerId, roundId, requestKey]);
  if (old.rowCount) return identicalOrConflict(old.rows[0], answers);
  const round = await client.query("SELECT status,deadline_at FROM rounds WHERE game_id=$1 AND id=$2",
    [gameId, roundId]);
  if (!round.rowCount || !["open", "settling"].includes(round.rows[0].status)
      || receivedAt >= Number(round.rows[0].deadline_at)) throw httpError(409, "已截止");
  const questions = await client.query("SELECT id,options_json FROM questions WHERE game_id=$1 AND round_id=$2",
    [gameId, roundId]);
  const allowed = new Map(questions.rows.map((q) => [q.id, q.options_json]));
  for (const [id, option] of Object.entries(answers)) {
    if (!allowed.has(id) || !Number.isInteger(option)
        || option < 0 || option >= allowed.get(id).length) throw httpError(400, "答卷无效");
  }
  const revision = (await client.query(`SELECT COALESCE(MAX(revision),0)+1 AS next FROM submissions
    WHERE game_id=$1 AND player_id=$2 AND round_id=$3`, [gameId, playerId, roundId])).rows[0].next;
  const saved = await client.query(`INSERT INTO submissions
    (id,game_id,player_id,round_id,request_key,answers_json,revision,submitted_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id,revision,submitted_at`,
    [randomUUID(), gameId, playerId, roundId, requestKey, JSON.stringify(answers), revision, receivedAt]);
  return saved.rows[0];
});
```

- [ ] **Step 4: Implement settlement after admission drains.** The first runtime has one process: track predeadline requests admitted before waiting for a DB connection, and do not publish a due round while those requests are pending. After cutoff no *new* admissions enter this counter; publish only after all committed/failed. Run scoring in a transaction that locks a due round row with `FOR UPDATE SKIP LOCKED`, reads the last revision per player, writes scores and marks published. Repeated settlement after restart is idempotent. A later multi-worker phase must replace the in-process drain coordination with a cross-worker admission barrier before enabling multiple workers. The HTTP route supplies its own `receivedAt`; never accept a timestamp from JSON.

```sql
SELECT DISTINCT ON (player_id) player_id, answers_json
FROM submissions WHERE game_id=$1 AND round_id=$2
ORDER BY player_id, revision DESC;
```

- [ ] **Step 5: Run green and failure cases.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/submissions.test.mjs tests/platform/integration.test.mjs`; inspect unique score keys and publish state after a restart with a freshly opened pool.
- [ ] **Step 6: Commit.** `git add src/platform/quiz src/platform/http/app.mjs tests/platform/submissions.test.mjs tests/platform/integration.test.mjs && git commit -m "feat: persist scoped receipts and recover settlement"`.

### Task 8: Separate runtime, database CI and a safe local runbook

**Files:** Create `src/platform/main.mjs`, `scripts/platform-bootstrap.mjs`, `scripts/platform-migrate.mjs`, `docs/platform-local-runbook.md`, `.github/workflows/platform-tests.yml`; modify `package.json`, `tests/platform/integration.test.mjs`.

**Interfaces:** `npm run migrate:platform`, `npm run start:platform`, `npm run test:platform`; bootstrap CLI creates the first platform administrator through `createOrganizer`, reading password from terminal without echo. `/v2/health` checks PostgreSQL with `SELECT 1`.

- [ ] **Step 1: Write failing startup test.** Start the new app against a fresh test schema; health is 200 with DB available, 503 after pool shutdown, no default games; an organizer can create a game, publish a choice round, two players join, submit, settle and read only their game's scores. Verify the old `npm start` still targets the old app.

```js
assert.equal((await fetch(base + "/v2/health")).status, 200);
assert.deepEqual((await (await fetch(base + "/v2/games", { headers: { cookie: ownerCookie } })).json()).games, []);
await pool.end();
assert.equal((await fetch(base + "/v2/health")).status, 503);
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/integration.test.mjs` before adding runtime/health.
- [ ] **Step 3: Implement startup and documentation.** Require `DATABASE_URL`, run migrations then start the platform listener. Bind loopback by default; public bind requires explicit HTTPS proxy/Origin and organizer credentials, not a guessed tunnel Host. Bootstrap reads hidden password and refuses duplicate platform-admin creation. Runbook gives local PostgreSQL creation, migration, backup/restore (`pg_dump`/`pg_restore`), archive invocation, two separate data directories, no-free-tunnel-capacity-guarantee warning, and stage-2/3/4 boundaries. CI provisions PostgreSQL with `POSTGRES_DB=quiz_platform_test`, sets `TEST_DATABASE_URL`, runs old tests, platform tests, syntax check including `src/platform`, and build; a missing local database causes `test:platform` to fail rather than skip.

```js
const pool = createPlatformPool({ connectionString: process.env.DATABASE_URL, max: 16 });
await migrate(pool);
const app = buildPlatformApp({ pool, publicOrigin: process.env.PUBLIC_ORIGIN });
await app.listen(Number(process.env.PORT ?? 4183), process.env.HOST ?? "127.0.0.1");
```

- [ ] **Step 4: Verify.** Run `npm test`, `TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:platform`, `npm run check`, `npm run build`, and CI equivalent. Separately run `node scripts/archive-legacy.mjs data/game.sqlite "$HOME/Documents/quiz-legacy-archive-2026-10-12"`, verify manifest hash and `inspectBackup` output, and record archive path privately; do not delete source `data/`.
- [ ] **Step 5: Commit only phase-1 files.** `git add src/platform/main.mjs scripts/platform-bootstrap.mjs scripts/platform-migrate.mjs docs/platform-local-runbook.md .github/workflows/platform-tests.yml package.json tests/platform/integration.test.mjs && git commit -m "feat: run isolated multi-game platform foundation"`.

## Phase Exit and Next Plans

The new `/v2` headless API and untouched legacy app are both testable; only the archived SQLite snapshot is retained outside the new product. Stage 2 requires a **separate** plan for arbitrary organizer form fields, four question types, editable versions and player UI. Stage 3 requires a separate plan for optional audited lotteries, NES.css/Fusion Pixel Chinese UI, licenses and full legacy-brand cleanup. Stage 4 requires a separate plan for cross-worker admission coordination, event-driven state, distributed load tests over the actual public entry, backups and quantified 5-second acceptance. No exit criterion in this phase calls the product a finished generic UI or a verified 10,000-player deployment.
