// journal.sqlite (DATA_MODEL §3.2): jobs, steps, measurements, and the graph's
// verifying traces. On open, a step left `running` by a crash becomes `pending`.

import { DatabaseSync } from "node:sqlite"

const SCHEMA = `
create table if not exists jobs (id integer primary key, kind text not null, project_version text, status text not null default 'pending', progress integer not null default 0, error text, started_at text, finished_at text, dispatch text, request text);
create table if not exists steps (job integer not null default 0, id text not null, kind text not null, input_hash text, status text not null, attempts integer not null default 0, resources text not null default '', output_key text, log text, primary key (job, id));
create table if not exists calls (job integer not null, task text, tier text, input_tokens integer, cached_tokens integer, output_tokens integer, ms integer, result text);
create table if not exists answers (job integer not null, n integer not null, task text not null, source text not null, value text not null, primary key (job, n));
create table if not exists measurements (job integer not null, gate text not null, key text not null, value real, at_time integer);
create table if not exists traces (id text primary key, version integer not null, deps text not null, output_hash text not null, value text not null);
`

export function openJournal(file) {
  const db = new DatabaseSync(file)
  if (file !== ":memory:") db.exec("pragma journal_mode = wal")
  db.exec(SCHEMA)
  db.exec("update steps set status = 'pending' where status = 'running'")
  db.exec("update jobs set status = 'pending' where status = 'running'")

  const plain = (row) => (row ? { ...row } : null)
  return {
    close: () => db.close(),

    trace(id) {
      const row = db.prepare("select * from traces where id = ?").get(id)
      return row ? { id: row.id, version: row.version, deps: JSON.parse(row.deps), hash: row.output_hash, value: JSON.parse(row.value) } : null
    },
    saveTrace({ id, version, deps, hash, value }) {
      db.prepare("insert or replace into traces (id, version, deps, output_hash, value) values (?, ?, ?, ?, ?)").run(id, version, JSON.stringify(deps), hash, JSON.stringify(value))
    },

    step({ job = 0, id, kind, status, resources = "", outputKey = null, log = null }) {
      db.prepare(
        `insert into steps (job, id, kind, status, attempts, resources, output_key, log) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (job, id) do update set status = excluded.status, attempts = attempts + excluded.attempts, output_key = coalesce(excluded.output_key, output_key), log = excluded.log`,
      ).run(job, id, kind, status, status === "running" ? 1 : 0, resources, outputKey, log)
    },
    steps: (job) => (job === undefined ? db.prepare("select * from steps").all() : db.prepare("select * from steps where job = ?").all(job)).map(plain),

    addJob({ kind, projectVersion = null, dispatch = null, request = null }) {
      return Number(db.prepare("insert into jobs (kind, project_version, dispatch, request) values (?, ?, ?, ?)").run(kind, projectVersion, dispatch, request === null ? null : JSON.stringify(request)).lastInsertRowid)
    },
    setJob(id, fields) {
      const keys = Object.keys(fields)
      db.prepare(`update jobs set ${keys.map((key) => `${key} = ?`).join(", ")} where id = ?`).run(...keys.map((key) => fields[key]), id)
    },
    job: (id) => plain(db.prepare("select * from jobs where id = ?").get(id)),
    jobs: (status) => (status ? db.prepare("select * from jobs where status = ? order by id").all(status) : db.prepare("select * from jobs order by id").all()).map(plain),

    /** A Director call: what was asked, how big, how it went; never the prompt (§3.2). */
    call({ job = 0, task, tier, input_tokens = null, cached_tokens = null, output_tokens = null, ms = null, result }) {
      db.prepare("insert into calls (job, task, tier, input_tokens, cached_tokens, output_tokens, ms, result) values (?, ?, ?, ?, ?, ?, ?, ?)").run(job, task, tier, input_tokens, cached_tokens, output_tokens, ms, result)
    },
    calls: (job) => db.prepare("select * from calls where job = ? order by rowid").all(job).map(plain),
    /** A Director slot's final answer, for `kriya edit replay` (EDIT_LOOP §10): the value, never the prompt. */
    answer({ job = 0, task, source, value }) {
      const n = db.prepare("select count(*) as n from answers where job = ?").get(job).n
      db.prepare("insert into answers (job, n, task, source, value) values (?, ?, ?, ?, ?)").run(job, n, task, source, JSON.stringify(value))
    },
    answers: (job) => db.prepare("select task, source, value from answers where job = ? order by n").all(job).map(plain),

    measure(job, { gate, key, value, at = null }) {
      db.prepare("insert into measurements (job, gate, key, value, at_time) values (?, ?, ?, ?, ?)").run(job, gate, key, value, at)
    },
    measurements: (job) => db.prepare("select * from measurements where job = ?").all(job).map(plain),
  }
}
