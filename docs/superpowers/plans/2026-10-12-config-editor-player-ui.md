# Generic Game Editor and Player UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an organizer create, edit, preview and publish a blank four-type quiz in the browser, then let players register, submit, recover their accounts and see confirmed results from the same `/v2` origin.

**Architecture:** Extend the existing PostgreSQL platform with additive migrations, game-scoped versioned draft services, a single rule validator/scorer and protected/public API projections. Serve a separate browser-ES-module application from the platform service; use NES.css and a self-hosted Chinese pixel font for the base visual language without changing the legacy app.

**Tech Stack:** Node.js >=24.19.0 <25, PostgreSQL 17, `pg` 8.23.1, native HTTP, browser ES modules, NES.css 2.3.0, Fusion Pixel Font 2026.09.25 (12px proportional zh-Hans WOFF2), Node test runner, Playwright 1.64.0 for browser acceptance.

**Spec:** `docs/superpowers/specs/2026-10-12-config-editor-player-ui-design.md`

## Global Constraints

- Work on `feature/generic-config-ui` from merged `origin/main`; leave the original checkout's dirty `.gitignore` and `.codex/` untouched. Keep `npm start`, old `public/`/`src/server/`, existing PostgreSQL data, and all stage-one tests working.
- Published game configuration is immutable; only audited operator membership changes and question void/re-score are allowed after publishing. Organizer start remains the **only** start trigger.
- Every game-owned SQL query/write, recovery code, draft, answer, score and member operation is scoped by `game_id`. Never expose answers before publication, private registration fields on a public response, or another game's data.
- Per round: 1–100 questions; per game: 1–20 rounds; duration 30,000–3,600,000 ms; points 0–10,000; custom registration fields at most 12. Exact/length answers at most 120 Unicode code points. The entire valid answer JSON including IDs must fit the 64 KiB request cap.
- Only an authenticated game owner may send an editor round request up to 1 MiB; all other API bodies stay capped at 64 KiB. Validate server-side rather than trusting browser input.
- Return a successful submission receipt only after database commit. Retry the same `requestKey` and unchanged content; draft persistence never scores. Do not claim the fourth-stage 10,000-in-one-second/5-second acceptance target in this PR.
- New pages, CSS, questions and copy must contain no legacy activity brand. Use a Chinese-capable pixel font for short UI text and a readable Chinese fallback for long text; keep MIT and OFL license notices.
- New PostgreSQL tests use `TEST_DATABASE_URL` pointing to `quiz_platform_test`, with isolated schemas. Browser tests use a fresh schema and never the real `quiz_platform` database.

## Review Focus

1. **Conflicting writes and publication:** Tasks 3–4 test two editors with the same version, repeat publish, and a late edit; only one version/publish succeeds, with no partially changed questions.
2. **Hostile quiz payloads:** Tasks 1–2 and 6 test unauthorized 1 MiB bodies, 64 KiB answer cap, duplicate multiselect indices, overlong Chinese/emoji text and answer-rule validation; malformed data has no score or success receipt.
3. **Privacy and game isolation:** Tasks 6–8 test guessed player/question/recovery IDs across games and public state/standings before and after publication; no private profile, draft, answer, or unreleased key escapes.
4. **Network ambiguity on shared devices:** Tasks 6 and 11 test timeout then same-key retry, switch-account cleanup, server draft vs confirmed revision and refresh after deadline; only persisted submissions claim success.
5. **Legacy migration and font failure:** Tasks 1, 9 and 12 test preexisting stage-one choice questions/answers, old app routes, no seeded platform content, browser with font requests blocked and mobile Chinese input; core play remains usable.

---

## File Map

- `src/platform/db/migrations/004_config_editor.sql`, `src/platform/db/migrate.mjs`: additive questions/rules/profile/draft/recovery/void schema and old-choice backfill.
- `src/platform/quiz/rules.mjs`, `src/platform/quiz/scoring.mjs`: pure normalized rule and answer validation, four automatic scoring modes and round payload budget.
- `src/platform/games/{editor,members}.mjs`, `src/platform/games/{repository,routes}.mjs`, `src/platform/quiz/{editor,repository,routes}.mjs`: versioned draft transaction, owner/member checks, publish freeze and organizer read model.
- `src/platform/players/{profile,recovery,drafts}.mjs`, `src/platform/players/{repository,routes}.mjs`: validated custom registration, login recovery, drafts; password/session logic stays shared and game-scoped.
- `src/platform/quiz/{corrections,state}.mjs` and routes: public and protected projections, void/re-score, no current answers in public state.
- `src/platform/http/{app,errors}.mjs`: authenticated large editor-body exception, structured 409 details and safe static route support; `src/platform/main.mjs` keeps the same `/v2` runtime.
- `public/platform/{index,organizer,player}.html`, `public/platform/js/{api,organizer,editor,player,submission}.mjs`, `public/platform/css/{theme,layout}.css`, `public/platform/fonts/`, `public/platform/licenses/`: new blank organizer/player UI, NES components and Chinese font.
- `scripts/build-platform.mjs`, `.gitignore`, `package.json`, `package-lock.json`: a separate immutable-assets build that leaves the legacy `npm run build` untouched.
- `tests/platform/{migration,rules,editor,publication,profile,answers,drafts,members,recovery,corrections,state,assets,release}.test.mjs`, `tests/browser/{helpers,organizer,player}.test.mjs`, `scripts/verify-platform.mjs`, `docs/platform-local-runbook.md`, `.github/workflows/platform-tests.yml`: red/green unit and real-PostgreSQL tests, browser flow and deployment documentation.

### Task 1: Additive PostgreSQL migration and scoped body budgets

**Files:** Create `src/platform/db/migrations/004_config_editor.sql`, `tests/platform/migration.test.mjs`; modify `src/platform/db/migrate.mjs`, `src/platform/http/app.mjs`, `tests/platform/http.test.mjs`.

**Interfaces:** Migration adds `games.current_version`, `games.published_version`, `players.profile_json`, `questions.answer_rule_json`, `drafts`, `recovery_codes`, and `voided_questions`. `buildPlatformApp` continues to accept the same options. Only `PUT /v2/games/:gameId/rounds/:roundId` and `POST /v2/games/:gameId/rounds` can exceed 64 KiB after `requireOrganizer` + `requireGameRole(...,["owner"])`.

- [ ] **Step 1: Write failing tests.** With `newPlatformFixture({migrateSchema:false})`, create `schema_migrations`, apply the checked-in SQL for versions 001–003 manually in order and record those versions. Seed an old choice game/round/submission, then run `migrate(pool)` (now including 004) twice and assert IDs/answers/scores survive, old correct index appears in `answer_rule_json`, and new tables exist. POST a 70 KiB body to the owner round endpoint and another API: owner reaches the handler; anonymous/operator/other endpoints get 401/404/413 before large body parsing. A body over 1 MiB is rejected even for owner.

```js
const largePost = (cookie, path, count) => fetch(base + path, {
  method:"POST",headers:{origin:"https://quiz.example","x-quiz-action":"1",
    "content-type":"application/json",...(cookie ? {cookie} : {})},
  body:JSON.stringify({title:"x".repeat(count)})
});
const row = (await pool.query("SELECT kind,answer_rule_json FROM questions WHERE id=$1", [oldQuestionId])).rows[0];
assert.deepEqual(row.answer_rule_json, { correctOption: 1 });
assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions WHERE id=$1", [oldSubmissionId])).rows[0].n, 1);
assert.equal((await largePost(ownerCookie, "/v2/games/" + gameId + "/rounds", 70_000)).status, 400);
assert.equal((await largePost(null, "/v2/games/" + gameId + "/rounds", 70_000)).status, 401);
assert.equal((await largePost(ownerCookie, "/v2/auth/login", 70_000)).status, 413);
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/migration.test.mjs tests/platform/http.test.mjs`; expect missing columns or owner request 413.
- [ ] **Step 3: Implement migration and HTTP boundary.** Drop the existing `questions_kind_check` and options JSON check, make `options_json` and `correct_option` nullable, add a four-kind CHECK and `answer_rule_json jsonb`; backfill `jsonb_build_object('correctOption',correct_option)` for old choices. Set `games.published_version=1` for previously published games, `current_version=1` for existing drafts, and preserve all old question/submission IDs. Add composite game FKs/unique indexes for drafts, recovery and voids; `recovery_codes` uses `code_hash` consistently. At HTTP boundary, inspect the matched method/path and authenticate owner **before** allowing up to `1_048_576` bytes; default stays `65_536`. Preserve the complete-body `receivedAt` used by submissions.

```js
const editorRound = req.method === "PUT" && /^\/v2\/games\/[0-9a-fA-F-]{36}\/rounds\/[0-9a-fA-F-]{36}$/.test(url.pathname)
  || req.method === "POST" && /^\/v2\/games\/[0-9a-fA-F-]{36}\/rounds$/.test(url.pathname);
if (editorRound) {
  const actor = await requireOrganizer(pool, req);
  await requireGameRole(pool, url.pathname.split("/")[3], actor.id, ["owner"]);
}
const maxBytes = editorRound ? 1_048_576 : 65_536;
```

```sql
ALTER TABLE games ADD COLUMN current_version integer NOT NULL DEFAULT 1;
ALTER TABLE games ADD COLUMN published_version integer;
UPDATE games SET published_version=1 WHERE status='published';
ALTER TABLE players ADD COLUMN profile_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE questions DROP CONSTRAINT questions_kind_check;
ALTER TABLE questions DROP CONSTRAINT questions_options_json_check;
ALTER TABLE questions ALTER COLUMN options_json DROP NOT NULL;
ALTER TABLE questions ALTER COLUMN correct_option DROP NOT NULL;
ALTER TABLE questions ADD COLUMN answer_rule_json jsonb;
UPDATE questions SET answer_rule_json=jsonb_build_object('correctOption',correct_option);
ALTER TABLE questions ALTER COLUMN answer_rule_json SET NOT NULL;
ALTER TABLE questions ADD CONSTRAINT questions_kind_check
  CHECK (kind IN ('choice','multiple','exact','length'));
CREATE TABLE drafts (
  game_id uuid NOT NULL, player_id uuid NOT NULL, round_id uuid NOT NULL,
  answers_json jsonb NOT NULL, saved_at bigint NOT NULL,
  PRIMARY KEY(game_id,player_id,round_id),
  FOREIGN KEY(game_id,player_id) REFERENCES players(game_id,id),
  FOREIGN KEY(game_id,round_id) REFERENCES rounds(game_id,id)
);
CREATE TABLE recovery_codes (
  code_hash text PRIMARY KEY, game_id uuid NOT NULL, player_id uuid NOT NULL,
  expires_at bigint NOT NULL, used_at bigint,
  FOREIGN KEY(game_id,player_id) REFERENCES players(game_id,id)
);
CREATE TABLE voided_questions (
  game_id uuid NOT NULL, question_id uuid NOT NULL, reason text NOT NULL,
  actor_id uuid NOT NULL REFERENCES organizers(id), created_at bigint NOT NULL,
  PRIMARY KEY(game_id,question_id),
  FOREIGN KEY(game_id,question_id) REFERENCES questions(game_id,id)
);
```

- [ ] **Step 4: Run green.** Same targeted tests; `npm test` and existing platform tests must remain green. Verify duplicate migration applies no changes.
- [ ] **Step 5: Commit.** `git add src/platform/db src/platform/http/app.mjs tests/platform/migration.test.mjs tests/platform/http.test.mjs && git commit -m "feat: migrate configurable quiz data safely"`.

### Task 2: Pure four-type rule validation and scoring

**Files:** Create `src/platform/quiz/rules.mjs`, `tests/platform/rules.test.mjs`; modify `src/platform/quiz/scoring.mjs`.

**Interfaces:** `validateQuestion(input): ValidQuestion` (with `kind,prompt,position,points,options?,answerRule`), `validateAnswer(question,value): void`, `scoreAnswer(question,value,voided=false): number`, `maxAnswerBytes(questions): number`. Input `answerRule` is `{correctOption}`, `{correctOptions}`, `{accepted}`, or `{minLength,maxLength}` respectively; a legacy choice input with top-level `correctOption` is converted to `answerRule` before validation.

- [ ] **Step 1: Write failing table-driven tests.** Manually assert choice 7/0, multiselect exact set regardless order 7/0, `NFKC` plus ASCII case/outer-space exact answer 7/0 (inner spaces significant), length 5/120 accepted and 4/121 rejected, astral emoji counted as one code point, empty returns 0, invalid duplicate/out-of-range indices get 400 **with a field path**, and `maxAnswerBytes` rejects a worst-case >64 KiB round.

```js
assert.equal(scoreAnswer({kind:"multiple",points:7,answerRule:{correctOptions:[0,2]}}, [2,0]), 7);
assert.throws(() => validateAnswer({kind:"multiple",options:["A","B","C"]}, [0,0]), /重复/);
assert.equal(scoreAnswer({kind:"exact",points:7,answerRule:{accepted:["ＡBC"]}}, " abc "), 7);
assert.equal(scoreAnswer({kind:"exact",points:7,answerRule:{accepted:["A B"]}}, "AB"), 0);
assert.equal(Array.from("😀").length, 1);
```

- [ ] **Step 2: Run red.** `node --test tests/platform/rules.test.mjs`; expect missing exports.
- [ ] **Step 3: Implement pure functions.** `NFKC` before `trim`, fold ASCII `A-Z` only, do not collapse internal spaces. Multi answers are unique sorted integer sets; exact accepts 1–10 unique normalized nonempty strings; length bounds 1–120; all prompts/options/points are bounded. Invalid configuration/answers raise an HTTP 400 with a stable path such as `questions[2].options` rather than a SQL error. Bound each text answer by **6 bytes per possible code point** in JSON (C0 controls can escape as `\\u0000`, which exceeds their UTF-8 size), plus quoted UUID keys, separators and request-key overhead; reject a round whose conservative maximum reaches 65,536 bytes. Never use `eval`, regex provided by organizers, or subjective AI scoring.

```js
export const normalizeExact = (value) =>
  value.normalize("NFKC").trim().replace(/[A-Z]/g, (char) => char.toLowerCase());
function matchesRule(question, value) {
  if (question.kind === "choice") return value === question.answerRule.correctOption;
  if (question.kind === "multiple") {
    const chosen = [...value].sort((a,b) => a-b);
    return chosen.length === question.answerRule.correctOptions.length
      && chosen.every((index,i) => index === question.answerRule.correctOptions[i]);
  }
  return question.answerRule.accepted.map(normalizeExact).includes(normalizeExact(value));
}
export function scoreAnswer(question, value, voided = false) {
  if (voided || value === undefined || value === null || value === "") return 0;
  if (question.kind === "length") {
    const count = Array.from(value.trim()).length;
    return count >= question.answerRule.minLength && count <= question.answerRule.maxLength
      ? question.points : 0;
  }
  return matchesRule(question, value) ? question.points : 0;
}
```

- [ ] **Step 4: Run green.** `node --test tests/platform/rules.test.mjs`, then existing stage-one `tests/platform/submissions.test.mjs`.
- [ ] **Step 5: Commit.** `git add src/platform/quiz/rules.mjs src/platform/quiz/scoring.mjs tests/platform/rules.test.mjs && git commit -m "feat: validate and score four quiz types"`.

### Task 3: Versioned game-details and registration-schema draft

**Files:** Create `src/platform/games/editor.mjs`, `tests/platform/editor.test.mjs`; modify `src/platform/games/routes.mjs`, `src/platform/games/repository.mjs`, `src/platform/http/errors.mjs`, `src/platform/http/app.mjs`.

**Interfaces:** `getEditor(pool,gameId,organizerId): Promise<{game,version,role,description,fields,leaderboard,rounds}>`; `saveDetails(pool,gameId,organizerId,{expectedVersion,title,description,fields,leaderboard}): Promise<{version}>`; `writeVersionSnapshot(client,gameId,nextVersion,now,detailsOverride?): Promise<void>` reconstructs a complete normalized snapshot from relational games/rounds/questions and optionally the new details. Routes `GET /v2/games/:gameId/editor`, `PATCH /v2/games/:gameId/details`.

- [ ] **Step 1: Write failing tests.** A new empty game returns version 1, blank fields and zero rounds. Two owner sessions editing with the same `expectedVersion:1` yield one version 2 and one 409 carrying `currentVersion:2`; no partial title/profile change. A test-inserted operator and another game's owner cannot edit; old published stage-one game is readable but immutable. Reject duplicate field keys, >12 fields, invalid select options, unknown keys and overlong text.

```js
const edits = await Promise.allSettled([
  saveDetails(pool, game.id, owner.id, {expectedVersion:1,title:"First",description:"",fields:[],leaderboard:true}),
  saveDetails(pool, game.id, owner.id, {expectedVersion:1,title:"Second",description:"",fields:[],leaderboard:true})
]);
assert.equal(edits.filter((result) => result.status === "fulfilled").length, 1);
assert.equal((await getEditor(pool, game.id, owner.id)).version, 2);
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/editor.test.mjs`; expect missing editor module/routes.
- [ ] **Step 3: Implement row-locked optimistic save.** Check `owner` and `status='draft'`; lock `games` row, compare version, validate fields and public option, update title, store normalized config and full relational snapshot in `game_versions`, increment `games.current_version`, audit old/new version. Extend `httpError(status,message,details={})` and the HTTP error serializer so 409 includes `currentVersion` without leaking SQL. `GET /editor` returns a read model from relational rows, preserving old stage-one games with an empty first config snapshot.

```js
export function httpError(status, message, details = {}) {
  return Object.assign(new Error(message), {status, details});
}
// In the central HTTP catch block:
const payload = error.status ? {error:error.message,...error.details} : {error:"服务暂不可用"};
return withTransaction(pool, async (client) => {
  const game = (await client.query("SELECT status,current_version FROM games WHERE id=$1 FOR UPDATE", [gameId])).rows[0];
  if (game.status !== "draft") throw httpError(409, "游戏已发布");
  if (game.current_version !== expectedVersion)
    throw httpError(409, "草稿版本冲突", {currentVersion:game.current_version});
  await client.query("UPDATE games SET title=$2,current_version=current_version+1 WHERE id=$1", [gameId, title]);
  await writeVersionSnapshot(client, gameId, expectedVersion + 1, now,
    {title,description,fields,leaderboard});
  return {version:expectedVersion + 1};
});
```

- [ ] **Step 4: Run green.** Target tests and cross-game `tests/platform/games.test.mjs`; inspect audit and snapshot contents, not only HTTP status.
- [ ] **Step 5: Commit.** `git add src/platform/games src/platform/http/errors.mjs src/platform/http/app.mjs tests/platform/editor.test.mjs && git commit -m "feat: save versioned game details and fields"`.

### Task 4: Round editor, preview and atomic publish

**Files:** Create `src/platform/quiz/editor.mjs`, `tests/platform/publication.test.mjs`; modify `src/platform/quiz/repository.mjs`, `src/platform/quiz/routes.mjs`, `src/platform/games/editor.mjs`.

**Interfaces:** `saveRound(pool,gameId,organizerId,{roundId?,expectedVersion,position,title,durationMs,questions}): Promise<{id,version}>`; `deleteRound(pool,gameId,roundId,organizerId,expectedVersion): Promise<{version}>`; `reorderRounds(pool,gameId,organizerId,{expectedVersion,roundIds}): Promise<{version}>`; `publishFrozen(pool,gameId,organizerId): Promise<{gameId,slug,version,status}>`; `getEditor` from Task 3 returns complete answers for owner but no public route does. Routes `DELETE /v2/games/:gameId/rounds/:roundId` and `PATCH /v2/games/:gameId/rounds/order` take the same version token. Existing `createRound` and `publishGame` direct APIs remain compatible with stage-one tests.

- [ ] **Step 1: Write failing tests.** Create/edit/delete/reorder draft rounds with contiguous positions, 1–20 rounds and 1–100 questions; old request version loses with no partial answer changes. Preview endpoint owner sees answers; unauthenticated or operator cannot fetch edit data. Two simultaneous publish calls produce one frozen version, later edit gets 409, repeat publish returns same result. An old published choice game remains readable and playable without a rewrite. Test a 100-text-question round whose worst-case answer body exceeds 64 KiB cannot publish.

```js
const round = await saveRound(pool, game.id, owner.id, {
  expectedVersion:1, position:1, title:"Round", durationMs:90_000,
  questions:[{position:1,kind:"exact",prompt:"Name?",points:7,answerRule:{accepted:["Ada"]}}]
});
assert.equal(round.version, 2);
assert.equal((await publishFrozen(pool, game.id, owner.id)).status, "published");
await assert.rejects(saveRound(pool, game.id, owner.id, {
  roundId:round.id,expectedVersion:2,position:1,title:"Changed",durationMs:90_000,
  questions:[{position:1,kind:"exact",prompt:"Changed?",points:7,answerRule:{accepted:["Ada"]}}]
}),
  (error) => error.status === 409);
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/publication.test.mjs`.
- [ ] **Step 3: Implement transactional edits.** Reuse the game-row lock and `writeVersionSnapshot`; preserve round UUID on replacement, replace only its draft questions, resequence remaining rounds after delete/move, and audit. Because `rounds.config_version` has an immediate FK to `game_versions`, insert the new version row first within the transaction, update the round version, then fill its complete `config_json` snapshot before commit. For reordering a `(game_id,position)` UNIQUE table, first move existing positions to a disjoint offset inside the transaction, then assign 1..N. Publish validates every question and `maxAnswerBytes`, writes final snapshot/published version/status in one transaction; repeated publish is a no-op returning the same version. Adapt old create/publish functions to the same version bookkeeping without changing stage-one response fields.

```js
const locked = await client.query("SELECT status,current_version,published_version FROM games WHERE id=$1 FOR UPDATE", [gameId]);
if (locked.rows[0].status === "published") return frozenResult(locked.rows[0]);
await validateCompleteGame(client, gameId);
await client.query("UPDATE games SET status='published',published_version=current_version WHERE id=$1", [gameId]);
return {gameId,slug,version:locked.rows[0].current_version,status:"published"};
```

- [ ] **Step 4: Run green.** Target tests and `tests/platform/rounds.test.mjs` plus old integration; assert no prepared/public answer leak.
- [ ] **Step 5: Commit.** `git add src/platform/games/editor.mjs src/platform/quiz tests/platform/publication.test.mjs && git commit -m "feat: freeze versioned round drafts at publication"`.

### Task 5: Custom registration fields and game-scoped profiles

**Files:** Create `src/platform/players/profile.mjs`, `tests/platform/profile.test.mjs`; modify `src/platform/players/repository.mjs`, `src/platform/players/routes.mjs`.

**Interfaces:** `validateProfile(fields,values): Record<string,string>`; `registerPlayer(pool,gameId,{displayName,password,profile?})` keeps the old response; `GET /v2/games/:slug/registration` returns only public field labels/choices/requirements; `GET /v2/games/:gameId/players` requires member and returns private profiles.

- [ ] **Step 1: Write failing tests.** An empty-field stage-one game still registers as before. A published game with required text/select fields stores only validated keys/values; missing, unknown, wrong choice, >120 Unicode code points or a field definition from another game gets 400. Two games with the same player display name and distinct profiles do not leak profile data in public registration, standings or `/me` for the other game. Operator can view its own game's private profiles, not another game's.

```js
assert.deepEqual(validateProfile([{key:"team",type:"select",required:true,options:["A","B"]}],
  {team:"B"}), {team:"B"});
assert.throws(() => validateProfile([{key:"team",type:"select",required:true,options:["A","B"]}],
  {team:"C"}), /team/);
assert.equal((await pool.query("SELECT profile_json FROM players WHERE game_id=$1 AND id=$2",
  [game.id, playerId])).rows[0].profile_json.team, "B");
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/profile.test.mjs`.
- [ ] **Step 3: Implement.** Validate against the frozen game's own field schema, store `profile_json` in the registration transaction, never echo private values publicly. Keep display name required and login-code/password flow unchanged. Add member-only player list with profile and score for operator verification; do not expose password hashes, session tokens or another game's account.

```js
const rule = (await client.query("SELECT config_json FROM game_versions WHERE game_id=$1 AND version=$2",
  [gameId, publishedVersion])).rows[0].config_json;
const profile = validateProfile(rule.fields ?? [], input.profile ?? {});
await client.query("INSERT INTO players(game_id,id,display_name,login_code,password_hash,profile_json,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)",
  [gameId, playerId, displayName, loginCode, passwordHash, JSON.stringify(profile), now]);
```

- [ ] **Step 4: Run green.** Target tests, stage-one player tests and legacy suite; inspect exact public JSON projections.
- [ ] **Step 5: Commit.** `git add src/platform/players tests/platform/profile.test.mjs && git commit -m "feat: validate per-game registration fields"`.

### Task 6: Four-type submission and private draft persistence

**Files:** Create `src/platform/players/drafts.mjs`, `tests/platform/answers.test.mjs`, `tests/platform/drafts.test.mjs`; modify `src/platform/quiz/repository.mjs`, `src/platform/quiz/routes.mjs`.

**Interfaces:** `saveDraft(pool,{gameId,playerId,roundId,answers,receivedAt}): Promise<{savedAt}>`; existing `submitAnswers`, `settleDueRounds`, `getPublicRound` preserve signatures; `PUT /v2/games/:slug/rounds/:roundId/draft` and protected `/my` return draft, last confirmed submission and published score separately.

- [ ] **Step 1: Write failing tests.** In one game publish one of each kind, submit correct/wrong/empty answers, assert exact-set multiselect and text rules/length gifts; unsubmitted draft produces zero scores. Save draft, refresh `/my`, then submit, save later draft: `/my` distinguishes later unsubmitted changes from receipt. Late draft rejected; late same-key confirmed receipt still returned; submit with another game's question ID or overlong text gets 400. A published answer payload exposes standard answers only after settlement; reflection content remains private.

```js
await saveDraft(pool,{gameId,playerId,roundId,answers:{[questionId]:1},receivedAt:deadline-1});
assert.equal((await pool.query("SELECT count(*)::int AS n FROM round_scores")).rows[0].n, 0);
const receipt = await submitAnswers(pool,{gameId,playerId,roundId,answers:{[questionId]:1},
  requestKey:"one",receivedAt:deadline-1});
assert.deepEqual(await submitAnswers(pool,{gameId,playerId,roundId,answers:{[questionId]:1},
  requestKey:"one",receivedAt:deadline+1}),receipt);
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/answers.test.mjs tests/platform/drafts.test.mjs`.
- [ ] **Step 3: Implement.** Read `answer_rule_json` and `kind` via game/round-scoped query; `validateAnswer` rejects unknown IDs/types while leaving blanks worth 0, reuse `scoreAnswer` in transactional settlement. Save drafts only while open and before deadline; never read a draft in settlement. Protect `/my`, hide unreleased keys in `getPublicRound`, and preserve foundation's row lock and idempotent revision behavior.

```js
const questions = (await client.query("SELECT id,kind,options_json,answer_rule_json,points FROM questions WHERE game_id=$1 AND round_id=$2",
  [gameId,roundId])).rows;
for (const [id,value] of Object.entries(answers)) {
  const question = questions.find((item) => item.id === id);
  if (!question) throw httpError(400,"未知题目");
  validateAnswer(mapQuestion(question),value);
}
```

- [ ] **Step 4: Run green.** Target tests, old `tests/platform/submissions.test.mjs`, and `npm test`; no established choice score changes.
- [ ] **Step 5: Commit.** `git add src/platform/players/drafts.mjs src/platform/quiz tests/platform/answers.test.mjs tests/platform/drafts.test.mjs && git commit -m "feat: settle four quiz types and save private drafts"`.

### Task 7: Audited question void and score correction

**Files:** Create `src/platform/quiz/corrections.mjs`, `tests/platform/corrections.test.mjs`; modify `src/platform/quiz/routes.mjs`, `src/platform/quiz/repository.mjs`.

**Interfaces:** `voidQuestion(pool,gameId,questionId,ownerId,reason,now): Promise<{questionId,roundId}>`; `rescoreRound(client,gameId,roundId): Promise<void>` shares the scoring loop with normal settlement; `POST /v2/games/:gameId/questions/:questionId/void` is owner-only.

- [ ] **Step 1: Write failing tests.** Two games have the same score: voiding one game's published question changes every affected player in that game, not the other. Missing reason, duplicate void, un-published question, guessed foreign question ID and operator attempts get 400/409/404. Audit records actor/reason and a second recomputation does not double scores; original question/answer and submission remain unchanged.

```js
await voidQuestion(pool,gameA.id,qA.id,ownerA.id,"答案依据错误",31_100);
assert.equal((await pool.query("SELECT points FROM round_scores WHERE game_id=$1", [gameA.id])).rows[0].points, 0);
assert.equal((await pool.query("SELECT points FROM round_scores WHERE game_id=$1", [gameB.id])).rows[0].points, 7);
await assert.rejects(voidQuestion(pool,gameB.id,qA.id,ownerB.id,"wrong",31_101),
  (error) => error.status === 404);
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/corrections.test.mjs`.
- [ ] **Step 3: Implement.** In one transaction check owner/game/round published, insert `(game_id,question_id)` unique void marker, call the same score routine with void set, update all affected scores, insert audit details. Do not delete or edit frozen questions. After score change, public standings read committed scores; third-stage pool freeze later blocks future correction.

```js
await client.query(`INSERT INTO voided_questions(game_id,question_id,reason,actor_id,created_at)
  VALUES($1,$2,$3,$4,$5)`,[gameId,questionId,reason.trim(),ownerId,now]);
await rescoreRound(client,gameId,roundId);
await client.query(`INSERT INTO audit_events(game_id,actor_id,kind,target_id,details_json,occurred_at)
  VALUES($1,$2,'question_voided',$3,$4::jsonb,$5)`,
  [gameId,ownerId,questionId,JSON.stringify({reason:reason.trim()}),now]);
```

- [ ] **Step 4: Run green.** Target tests plus `tests/platform/answers.test.mjs` and existing published-score tests.
- [ ] **Step 5: Commit.** `git add src/platform/quiz tests/platform/corrections.test.mjs && git commit -m "feat: audit and rescore voided questions"`.

### Task 8: Operator membership, player recovery and public state

**Files:** Create `src/platform/games/members.mjs`, `src/platform/players/recovery.mjs`, `src/platform/quiz/state.mjs`, `tests/platform/members.test.mjs`, `tests/platform/recovery.test.mjs`, `tests/platform/state.test.mjs`; modify `src/platform/games/routes.mjs`, `src/platform/players/routes.mjs`, `src/platform/quiz/routes.mjs`.

**Interfaces:** `inviteOperator(pool,gameId,ownerId,login,now): Promise<member>`; `removeOperator(pool,gameId,ownerId,organizerId,now): Promise<void>`; `issueRecovery(pool,gameId,playerId,actorId,now): Promise<string>`; `redeemRecovery(pool,gameId,code,password,now): Promise<{playerId,sessionToken,loginCode}>`; `publicState(pool,slug,now): Promise<{game,rounds,serverTime}>`. Routes `POST /v2/games/:gameId/members`, `DELETE /v2/games/:gameId/members/:organizerId`, `POST /v2/games/:gameId/players/:playerId/recovery` (owner/operator), `POST /v2/games/:slug/recover` (player), `GET /v2/games/:slug/state` (public).

- [ ] **Step 1: Write failing tests.** Invite an existing organizer twice with one membership and one audit, remove and immediately deny its start/editor API, forbid owner removal and cross-game invite. Recovery code is single-use, ten-minute expiry, hashed at rest, scoped to game, resets password and revokes only the target player's old sessions; never exposes it publicly. Public state includes no profile/answers/personal scores; only prepared/open/published statuses, counts and timing. A manual start alone changes state; fake agenda time/refresh cannot.

```js
const code = await issueRecovery(pool,gameA.id,playerA.id,ownerA.id,1000);
assert.equal((await pool.query("SELECT code_hash FROM recovery_codes WHERE game_id=$1",
  [gameA.id])).rows[0].code_hash.includes(code), false);
await assert.rejects(redeemRecovery(pool,gameB.id,code,"new-password-1",1001),
  (error) => error.status === 409);
assert.equal((await publicState(pool,gameA.slug,1001)).rounds[0].status,"prepared");
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/members.test.mjs tests/platform/recovery.test.mjs tests/platform/state.test.mjs`.
- [ ] **Step 3: Implement.** Membership changes are owner-authorized transactional writes with scoped audit. Recovery uses 32 random bytes, SHA-256 in DB, checks game/player/expiry/used status under row lock and replaces password/session in one transaction; rate-limit generation/redemption separately. State joins only `games`/`rounds` and aggregate submission counts; personal `/my` remains authenticated. Route responses never include other games' member/profile data.

```js
const row = (await client.query(`SELECT player_id FROM recovery_codes
  WHERE game_id=$1 AND code_hash=$2 AND expires_at>$3 AND used_at IS NULL FOR UPDATE`,
  [gameId,tokenHash(code),now])).rows[0];
if (!row) throw httpError(409,"恢复码无效或过期");
await client.query("UPDATE player_sessions SET revoked_at=$3 WHERE game_id=$1 AND player_id=$2 AND revoked_at IS NULL",
  [gameId,row.player_id,now]);
```

- [ ] **Step 4: Run green.** Target and existing `tests/platform/players.test.mjs`, `rounds.test.mjs`, and stage-one integration.
- [ ] **Step 5: Commit.** `git add src/platform/games src/platform/players src/platform/quiz tests/platform/members.test.mjs tests/platform/recovery.test.mjs tests/platform/state.test.mjs && git commit -m "feat: manage operators recovery and public game state"`.

### Task 9: Bundle separate platform assets and safe static routes

**Files:** Create `scripts/build-platform.mjs`, `public/platform/index.html`, `public/platform/organizer.html`, `public/platform/player.html`, `public/platform/css/theme.css`, `public/platform/css/layout.css`, `public/platform/fonts/`, `public/platform/licenses/`, `tests/platform/assets.test.mjs`; modify `src/platform/http/app.mjs`, `package.json`, `package-lock.json`, `.gitignore`.

**Interfaces:** `buildPlatform(source=resolve("public/platform"),output=resolve("dist-platform")): string` from `scripts/build-platform.mjs`; `npm run build:platform` produces `dist-platform/` with `assets.json`, new pages, NES.css 2.3.0, font WOFF2 and both license texts. All CSS/JS/font references live under `/platform/assets/:buildHash/` (one 12-hex hash of the complete input asset set), preserving relative ES module imports and CSS font URLs. `buildPlatformApp({pool,staticDir})` enables GET `/`, `/organizer`, `/g/:slug` with `Cache-Control: no-store` and GET `/platform/*` within the built asset root; without `staticDir`, stage-one API-only behavior is unchanged.

- [ ] **Step 1: Write failing tests.** An app configured with `staticDir` refuses to advertise missing platform HTML until built; an app without `staticDir` keeps stage-one API tests working. After build all three routes, NES CSS, Chinese font and licenses return 200 without old brand; `/platform/../` or malformed encoding cannot read outside `dist-platform`; HTML/API no-store and content-hashed assets cached. Failure to load the font must leave readable system-font CSS fallback.

```js
assert.equal((await fetch(base + "/organizer")).status, 200);
assert.match(await (await fetch(base + "/g/quiz-night")).text(), /lang="zh-CN"/);
const manifest = JSON.parse(readFileSync(join(output,"assets.json"),"utf8"));
const css = await (await fetch(base + manifest.theme)).text();
assert.match(manifest.font,/^\/platform\/assets\/[a-f0-9]{12}\/fonts\/fusion-pixel-zh-hans\.woff2$/);
assert.match(css,/fusion-pixel-zh-hans\.woff2/);
assert.equal((await fetch(base + manifest.font)).status, 200);
assert.notEqual((await fetch(base + "/platform/%2e%2e/package.json")).status, 200);
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/assets.test.mjs`; expect missing build/routes/assets.
- [ ] **Step 3: Implement.** Pin `nes.css@2.3.0` and copy its built CSS/license at build time; download Fusion Pixel Font 2026.09.25 release asset `fusion-pixel-font-12px-proportional-otf.woff2-v2026.09.25.zip`, extract the single `zh-Hans` WOFF2 to `public/platform/fonts/fusion-pixel-zh-hans.woff2`, and copy its OFL-1.1 license. Keep original vendor sources unmodified and verify font header `wOF2`. Compute one SHA-256 hash of all input files, use its first 12 hex chars as the build directory name, copy assets into `dist-platform/assets/:buildHash/`, and write `assets.json`; HTML references the hashed root, while JS imports and CSS font URLs remain relative within it. Pass `staticDir:resolve("dist-platform")` in `main.mjs`; only this mode requires built HTML. Serve static files through a path-contained allowlist with CSP/MIME, no-store for HTML, immutable caching **only for URLs beneath the versioned asset directory**. The old `npm run build` and Pages workflow remain unchanged.

```js
const target = resolve(assetRoot, decodeURIComponent(path.slice("/platform/".length)));
if (!target.startsWith(assetRoot + sep) || !allowedExt.has(extname(target))) throw httpError(403,"asset denied");
res.writeHead(200,{"content-type":mime(extname(target)),
  "cache-control":/\/assets\/[a-f0-9]{12}\//.test(path)
    ? "public, max-age=31536000, immutable" : "no-store"});
res.end(readFileSync(target));
```

- [ ] **Step 4: Run green.** Target tests plus legacy `tests/server/ui.test.mjs`; check mobile browser console and repo license files, not only HTTP 200.
- [ ] **Step 5: Commit.** `git add scripts/build-platform.mjs public/platform src/platform/http/app.mjs tests/platform/assets.test.mjs package.json package-lock.json .gitignore && git commit -m "feat: serve separate Chinese pixel platform assets"`.

### Task 10: Organizer wizard and control console

**Files:** Create `public/platform/js/api.mjs`, `public/platform/js/editor.mjs`, `public/platform/js/organizer.mjs`, `tests/browser/organizer.test.mjs`; modify `public/platform/organizer.html`, `public/platform/index.html`, `public/platform/css/layout.css`, `package.json`, `package-lock.json`, `.github/workflows/platform-tests.yml`.

**Interfaces:** `api(path,{method="GET",body,timeoutMs=12000})` adds `x-quiz-action: 1`, same-origin credentials, AbortController; editor module exposes `renderEditor(root,snapshot,onSave)`. Browser test command `npm run test:browser` requires `TEST_DATABASE_URL` and installed Chromium.

- [ ] **Step 1: Install test-only browser runner and write failing Playwright tests against a fresh test schema.** Add `playwright@1.64.0` as a dev dependency, `test:browser` as `node --test tests/browser/*.test.mjs`, install Chromium for local testing, and write `tests/browser/helpers.mjs` using `newPlatformFixture`, `buildPlatform()` from Task 9 and `buildPlatformApp({pool,staticDir:resolve("dist-platform")})`. Rebuild static assets before each browser test suite. Organizer logs in, creates blank game, saves details/fields, adds one of each question, deletes/reorders draft rounds, navigates away/back and sees saved version, previews as player, publishes and copies join link. The same owner's stale second tab gets 409 while retaining typed text. Operator can start a round but cannot edit; buttons disabled after publish. At 320px there is no horizontal overflow and all required controls have accessible labels.

```js
await page.getByRole("button",{name:"创建游戏"}).click();
await page.getByLabel("游戏名称").fill("科学之夜");
await page.getByRole("button",{name:"保存草稿"}).click();
await expect(page.getByText("已保存 · 版本 2")).toBeVisible();
await page.setViewportSize({width:320,height:700});
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/browser/organizer.test.mjs`; expect missing controls/UI, not an uninstalled browser.
- [ ] **Step 3: Implement browser modules.** Render all user text through `textContent`; use NES buttons/containers with custom responsive grid. Autosave only explicit editor actions, disable duplicate clicks, preserve unsaved form fields on 409 or network error, show per-field errors. `owner` sees edit/publish/member actions; `operator` sees readonly config and start/correction controls. Preview is read-only and visually matches player cards without exposing admin-only answers to the public route.

```js
saveButton.addEventListener("click", async () => {
  const snapshot = readDraftForm();
  try {
    const next = await api(`/v2/games/${gameId}/details`, {
      method:"PATCH", body:{...snapshot,expectedVersion:currentVersion}
    });
    currentVersion = next.version;
    status.textContent = `已保存 · 版本 ${currentVersion}`;
  } catch (error) {
    status.textContent = error.status === 409 ? "版本冲突，当前输入仍保留" : "未保存，请重试";
  }
});
```

- [ ] **Step 4: Run green.** Browser target tests at 320/390/768/1440px and platform API tests; no console error or overflow.
- [ ] **Step 5: Commit.** `git add public/platform tests/browser/helpers.mjs tests/browser/organizer.test.mjs package.json package-lock.json .github/workflows/platform-tests.yml && git commit -m "feat: edit and publish games in a Chinese pixel wizard"`.

### Task 11: Player registration, quiz, receipts and results

**Files:** Create `public/platform/js/player.mjs`, `public/platform/js/submission.mjs`, `tests/browser/player.test.mjs`; modify `public/platform/player.html`, `public/platform/css/layout.css`.

**Interfaces:** `createPendingSubmission({gameId,playerId,roundId,answers},storage)` returns/reuses `{requestKey,answers}` until confirmed or edited; player UI consumes `GET /v2/games/:slug/state`, `/registration`, `/rounds/:id`, protected `/my`, `/draft`, `/submit`, `/standings` and recovery route from Tasks 5–8.

- [ ] **Step 1: Write failing Playwright tests.** Player joins with required custom field, sees login code, answers all four types, refresh restores draft, submits and sees receipt ID. Simulate timeout after server commits; retry keeps the same key/content and recovers the original receipt; change answer generates a new key. Log out on shared browser, join another account, never render prior local draft. After deadline and publication, display own score and only public leaderboard names; use a generated one-time recovery code to regain the original account with new password. With font blocked, 320px Chinese quiz remains legible; keyboard/IME composition does not auto-submit, and reduced-motion preference disables decorative animation.

```js
await page.getByLabel("展示名").fill("中文玩家");
await page.getByRole("button",{name:"加入游戏"}).click();
await page.getByRole("button",{name:"提交答卷"}).click();
await expect(page.getByText(/提交成功.*回执/)).toBeVisible();
await page.getByRole("button",{name:"退出账号"}).click();
await expect(page.getByText("上一位玩家的草稿")).toHaveCount(0);
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/browser/player.test.mjs`; expect absent player controls/state machine.
- [ ] **Step 3: Implement.** Cache drafts and pending key/content in scoped `sessionStorage`, clear on logout; server saves draft at most every 15 seconds plus blur/hidden flush. Sync server-time offset for countdown; poll state with backoff, never use a timer to open a round. Only a durable receipt changes status to success; timeouts remain unconfirmed, pending request is immutable until retry succeeds or player explicitly edits; published answers and rankings display after actual server state changes. Use native radio/checkbox/textarea with labels, composition-safe input handlers, ≥44px controls and readable Chinese fallbacks.

```js
const pending = createPendingSubmission({
  gameId, playerId, roundId, answers:structuredClone(currentAnswers)
}, sessionStorage);
try {
  const receipt = await api(`/v2/games/${slug}/rounds/${roundId}/submit`,
    {method:"POST",body:pending,timeoutMs:12_000});
  status.textContent = `提交成功 · 回执 ${receipt.id}`;
} catch {
  status.textContent = "未确认，可重试原提交";
}
```

- [ ] **Step 4: Run green.** Browser target, `tests/platform/drafts.test.mjs`, `tests/platform/answers.test.mjs` and old player's round tests.
- [ ] **Step 5: Commit.** `git add public/platform/player.html public/platform/js/player.mjs public/platform/js/submission.mjs public/platform/css/layout.css tests/browser/player.test.mjs && git commit -m "feat: play four-type quizzes with durable receipt UI"`.

### Task 12: End-to-end acceptance, documentation and compatibility

**Files:** Modify `tests/browser/organizer.test.mjs`, `tests/browser/player.test.mjs`, `tests/platform/integration.test.mjs`, `docs/platform-local-runbook.md`, `package.json`, `.github/workflows/platform-tests.yml`; add `tests/platform/release.test.mjs`, `scripts/verify-platform.mjs`.

**Interfaces:** `npm run test:platform`, `npm run test:browser`, `npm run build:platform`, `npm run check`, `npm run build` and `npm test` must all pass from a fresh `npm ci`. Old `npm start` and Pages behavior remain unchanged.

- [ ] **Step 1: Write failing release-probe and end-to-end tests.** A new `verifyPlatform(baseUrl)` checks health, generic home, organizer page, a known published join route, and state; a site serving only a legacy/Pages landing page fails. Two organizers independently create and publish games through HTTP; two browsers join, answer mixed types and recover after disconnect; one game voids a question without changing the other. Migrate a preexisting stage-one choice DB and assert published scores/answers survive. In browser, run 320/390/768/1440px and blocked-font route; published freeze, accessible labels, actual server-time offset countdown, and logout isolation are asserted. A missing build fails clearly, rather than serving a broken join link.

```js
const verified = await verifyPlatform(base, game.slug);
assert.deepEqual(verified, {health:true,home:true,organizer:true,player:true,state:true});
const response = await fetch(`${base}/g/${game.slug}`);
assert.equal(response.status,200);
assert.equal((await fetch(`${base}/v2/games/${game.slug}/state`)).status,200);
assert.equal((await pool.query("SELECT count(*)::int AS n FROM games")).rows[0].n,2);
assert.equal((await pool.query("SELECT count(*)::int AS n FROM round_scores WHERE game_id=$1",
  [gameA.id])).rows[0].n,2);
```

- [ ] **Step 2: Run red.** `TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test tests/platform/release.test.mjs`; expect missing `verifyPlatform` export. Targeted browser E2E regressions run separately.
- [ ] **Step 3: Implement release probe, runbook and CI.** `verifyPlatform(baseUrl,slug)` requests the five same-origin endpoints, checks expected HTML markers plus JSON status, returns booleans, and exits nonzero on missing API or static-only Pages. Add a documented same-origin local demo using separate `quiz_platform` DB, `npm run build:platform`, `npm run start:platform`, and explicit warning not to switch the live domain or claim the fourth-stage 10,000/5-second threshold. Extend `npm run check` to syntax-check `public/platform/js/*.mjs` in addition to the old app and server. CI runs PostgreSQL tests, `npx playwright install --with-deps chromium`, browser tests, both builds and syntax check. Preserve a manual off-volume backup procedure; no live production data in fixtures.

```yaml
- run: npm ci
- run: npm test
- run: npm run test:platform
- run: npm run build:platform
- run: npx playwright install --with-deps chromium
- run: npm run test:browser
- run: npm run check
```

- [ ] **Step 4: Full verification.** Run `npm ci`, `npm test`, `TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:platform`, `npm run build`, `npm run build:platform`, `TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:browser`, `npm run check`, `git diff --check`, and manually inspect rendered 320/390/768/1440px screenshots. Report PostgreSQL version, test counts and remaining third/fourth-stage work without suggesting the full game is production-ready.
- [ ] **Step 5: Commit.** `git add scripts/verify-platform.mjs tests/browser tests/platform/release.test.mjs docs/platform-local-runbook.md package.json .github/workflows/platform-tests.yml && git commit -m "test: verify generic organizer and player journeys"`.
