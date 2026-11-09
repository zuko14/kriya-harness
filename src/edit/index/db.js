// index.sqlite (DATA_MODEL §3.1): what the layers found, one file per project in
// ~/.kriya/edit/<project id>/. Rows are keyed by the media's fingerprint, so two
// assets of the same file share one set of results; ids are made per asset on read
// ("a1:w0"). Times are integer flicks. Everything but `corrections` can be rebuilt.

import { DatabaseSync } from "node:sqlite"

import { decimalSplit } from "./layers/retakes.js"

const SCHEMA = `
create table if not exists assets (asset text primary key, media text not null, kind text not null);
create table if not exists layers (media text not null, layer text not null, model_version text not null, status text not null, notice text, data text, updated_at text not null, primary key (media, layer));
create table if not exists words (media text not null, n integer not null, start integer not null, "end" integer not null, text text not null, lang text, speaker text, conf real, flags text not null default '', primary key (media, n));
create virtual table if not exists words_fts using fts5 (text, media unindexed, n unindexed);
create table if not exists corrections (asset text not null, word text not null, text text not null, at text not null);
create table if not exists sentences (media text not null, n integer not null, start integer not null, "end" integer not null, first_word integer not null, last_word integer not null, speaker text, take_group integer, score real, primary key (media, n));
create table if not exists takes (media text not null, "group" integer not null, sentence integer not null, rank integer not null, signals text not null, primary key (media, "group", sentence));
create table if not exists shots (media text not null, n integer not null, start integer not null, "end" integer not null, kind text not null, blur real, exposure real, shake real, motion real, primary key (media, n));
create table if not exists faces (media text not null, shot integer, t integer not null, box text not null, eye text, chin text, identity integer, gaze text);
create table if not exists events (media text not null, start integer not null, "end" integer not null, kind text not null, conf real);
create table if not exists beats (media text not null, n integer not null, t integer not null, downbeat integer not null, strength real, primary key (media, n));
create table if not exists bars (media text not null, n integer not null, start integer not null, "end" integer not null, energy real, primary key (media, n));
create index if not exists faces_media on faces (media, t);
create index if not exists events_media on events (media, kind, start);
`

// The tables each layer owns: a re-run replaces exactly these rows
const OWNED = { L1: ["events"], L2: ["words", "words_fts"], L5: ["sentences", "takes"], L6: ["shots"], L8: ["faces"], L12: ["beats", "bars"] }

const flagList = (text) => (text ? text.split(",") : [])

export function openIndexDb(file) {
  const db = new DatabaseSync(file)
  if (file !== ":memory:") db.exec("pragma journal_mode = wal")
  db.exec(SCHEMA)

  const tx = (work) => {
    db.exec("begin")
    try {
      const value = work()
      db.exec("commit")
      return value
    } catch (error) {
      db.exec("rollback")
      throw error
    }
  }

  const mediaOf = (asset) => db.prepare("select media from assets where asset = ?").get(asset)?.media ?? null

  return {
    db,
    tx,
    close: () => db.close(),

    setAsset: (asset, media, kind) => db.prepare("insert or replace into assets (asset, media, kind) values (?, ?, ?)").run(asset, media, kind),
    mediaOf,

    layer(media, layer) {
      const row = db.prepare("select * from layers where media = ? and layer = ?").get(media, layer)
      return row ? { ...row, data: row.data ? JSON.parse(row.data) : null } : null
    },
    layers: (media) => db.prepare("select layer, model_version, status, notice from layers where media = ? order by layer").all(media).map((row) => ({ ...row })),

    /** Replaces a layer's rows and status in one transaction, so a crash leaves the old result or the new one. */
    saveLayer(media, layer, { version, status, notice = null, data = null, write }) {
      tx(() => {
        for (const table of OWNED[layer] ?? []) db.prepare(`delete from ${table} where media = ?`).run(media)
        write?.(db)
        db.prepare("insert or replace into layers (media, layer, model_version, status, notice, data, updated_at) values (?, ?, ?, ?, ?, ?, ?)").run(media, layer, version, status, notice, data === null ? null : JSON.stringify(data), new Date().toISOString())
      })
    },

    /**
     * The person's fix of a misheard word. Kept by word id beside the recogniser's rows,
     * which a re-index replaces; the word's original text is kept too, so a re-index
     * that moves the words never lands a fix on a different word.
     * Text equal to the recogniser's, or empty, removes the fix.
     */
    correct(asset, word, text) {
      const media = mediaOf(asset)
      const n = Number(word.slice(`${asset}:w`.length))
      const row = media && word.startsWith(`${asset}:w`) && Number.isInteger(n) ? db.prepare("select text from words where media = ? and n = ?").get(media, n) : null
      if (!row) return false
      tx(() => {
        db.prepare("delete from corrections where asset = ? and word = ?").run(asset, word)
        if (text && text !== row.text) db.prepare("insert into corrections (asset, word, text, at) values (?, ?, ?, ?)").run(asset, word, JSON.stringify({ text, was: row.text }), new Date().toISOString())
      })
      return true
    },

    /** Rows for Edit Core and the views, for these assets (DATA_MODEL §3.1 shapes, ids per asset). */
    read(assets = db.prepare("select asset from assets order by asset").all().map((row) => row.asset)) {
      const raw = { words: [], sentences: [], takes: [], shots: [], faces: [], silences: [], beats: [], bars: [], timestamps: {}, subjects: {} }
      for (const asset of assets) {
        const media = mediaOf(asset)
        if (!media) continue
        const fixes = new Map(db.prepare("select word, text from corrections where asset = ?").all(asset).map((c) => [c.word, JSON.parse(c.text)]))
        for (const w of db.prepare('select * from words where media = ? order by n').all(media)) {
          const id = `${asset}:w${w.n}`
          const fix = fixes.get(id)
          const fixed = fix && fix.was === w.text
          raw.words.push({ id, asset, start: w.start, end: w.end, text: fixed ? fix.text : w.text, conf: fixed ? 1 : w.conf, flags: flagList(w.flags).filter((f) => !fixed || f !== "low_confidence"), ...(fixed ? { heard: w.text } : {}) })
        }
        // An index made before decimalSplit flagged "5" in "5 .5" as a stutter: unflagged on read, so it isn't cut
        const spoken = raw.words.filter((w) => w.asset === asset)
        spoken.forEach((w, i) => w.flags.includes("stutter") && decimalSplit(w, spoken[i + 1]) && (w.flags = w.flags.filter((f) => f !== "stutter")))
        for (const s of db.prepare('select * from sentences where media = ? order by n').all(media)) {
          raw.sentences.push({ id: `${asset}:s${s.n}`, asset, start: s.start, end: s.end, firstWord: `${asset}:w${s.first_word}`, lastWord: `${asset}:w${s.last_word}`, takeGroup: s.take_group === null ? null : `${asset}:g${s.take_group}`, score: s.score })
        }
        for (const t of db.prepare('select * from takes where media = ? order by "group", rank').all(media)) {
          raw.takes.push({ group: `${asset}:g${t.group}`, sentence: `${asset}:s${t.sentence}`, rank: t.rank, signals: JSON.parse(t.signals) })
        }
        for (const s of db.prepare("select * from shots where media = ? order by n").all(media)) {
          raw.shots.push({ id: `${asset}:sh${s.n}`, asset, start: s.start, end: s.end, kind: s.kind, blur: s.blur, exposure: s.exposure, shake: s.shake, motion: s.motion })
        }
        for (const f of db.prepare("select * from faces where media = ? order by t").all(media)) {
          raw.faces.push({ asset, shot: f.shot === null ? null : `${asset}:sh${f.shot}`, t: f.t, box: JSON.parse(f.box), identity: f.identity })
        }
        // The reframe solver's subject: the face track seen most, its centre and box width per sample (ED7, ED11)
        const own = raw.faces.filter((f) => f.asset === asset && f.shot !== null)
        const counts = new Map()
        for (const f of own) counts.set(f.identity, (counts.get(f.identity) ?? 0) + 1)
        const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
        if (main !== undefined) raw.subjects[asset] = own.filter((f) => f.identity === main).map((f) => ({ t: f.t, x: f.box.x + f.box.w / 2, w: f.box.w, shot: f.shot }))
        for (const e of db.prepare("select start, \"end\" from events where media = ? and kind = 'silence' order by start").all(media)) raw.silences.push({ asset, start: e.start, end: e.end })
        for (const b of db.prepare("select * from beats where media = ? order by n").all(media)) raw.beats.push({ id: `${asset}:b${b.n}`, asset, t: b.t, downbeat: b.downbeat === 1, strength: b.strength })
        for (const b of db.prepare('select * from bars where media = ? order by n').all(media)) raw.bars.push({ asset, start: b.start, end: b.end, energy: b.energy })
        const probe = db.prepare("select data from layers where media = ? and layer = 'L0' and status = 'ok'").get(media)
        const timestamps = probe?.data ? JSON.parse(probe.data).timestamps : null
        if (timestamps) raw.timestamps[asset] = timestamps
      }
      return raw
    },
  }
}
