// ET-GR-04's victim: three nodes in a row, the last of which never ends, so the
// test can kill this process with SIGKILL while it runs.
import { appendFileSync } from "node:fs"

import { createGraph } from "../../src/edit/graph/index.js"
import { openJournal } from "../../src/edit/graph/journal.js"

const [file, log, hang] = process.argv.slice(2)
const ran = (name) => appendFileSync(log, `${name}\n`)
const journal = openJournal(file)
const graph = createGraph({
  journal,
  nodes: {
    a: { version: 1, run: async () => (ran("a"), 1) },
    b: {
      version: 1,
      run: async ({ need }) => {
        const value = (await need("a")) + 1
        ran("b")
        return value
      },
    },
    c: {
      version: 1,
      run: async ({ need }) => {
        const value = (await need("b")) + 1
        ran("c")
        if (hang === "hang") await new Promise(() => setInterval(() => {}, 1000))
        return value
      },
    },
  },
})
console.log(await graph.demand("c"))
journal.close()
