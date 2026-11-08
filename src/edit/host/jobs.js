// The Host owns jobs (EDD-03): each lives in its project's journal, so a job in
// progress when the Host dies resumes on the next start with no finished node redone.

import { projectAt } from "../core/history.js"

// A render is of the version it was asked for, not whatever the project has become by
// the time it runs: an edit or an undo right after "Render" changed the film (found by EG-5)
function versionOf(state, number) {
  const at = state.journal.job(number).project_version ?? null
  return at === state.log.head ? state.log.current : projectAt(state.log, at, { index: state.index })
}

export function createJobs({ projects, emit, log, onDispatch, beforeStory }) {
  const running = new Map() // "<project>.<n>" → AbortController

  const idOf = (state, number) => `${state.id}.${number}`
  const view = (state, row) => ({ id: idOf(state, row.id), project: state.id, kind: row.kind, status: row.status, progress: row.progress, error: row.error, output: row.dispatch })

  async function run(state, number, request) {
    const id = idOf(state, number)
    const controller = new AbortController()
    running.set(id, controller)
    const update = (fields, error) => {
      state.journal.setJob(number, fields)
      const current = view(state, state.journal.job(number))
      emit("job", current)
      // A job from Kriya says how it's going to Kriya too (TAVI_INTEGRATION §4)
      if (request.dispatch) void Promise.resolve(onDispatch?.(request, current, error)).catch((failure) => log(`job ${id}: report failed: ${failure.name}`))
    }
    update({ status: "running", started_at: new Date().toISOString() })
    try {
      const onStep = (done, total) => update({ progress: Math.floor((done * 100) / total) })
      const output =
        request.kind === "index"
          ? JSON.stringify(await projects.indexAsset(state, request.asset, { signal: controller.signal, onStep }))
          : request.kind === "make"
            ? JSON.stringify(await projects.make(state, request, { job: number, signal: controller.signal, onStep, ...(request.dispatch && beforeStory && { beforeStory: (...args) => beforeStory(request, ...args) }) }))
          : request.kind === "revise"
            ? JSON.stringify(await projects.revise(state, request, { job: number, signal: controller.signal, onStep }))
            : request.kind === "replay"
              ? JSON.stringify(await projects.replay(state, request.of, { job: number, signal: controller.signal, onStep }))
            : (await state.engine.render({ ...request, job: number, signal: controller.signal, onStep, project: request.project ?? versionOf(state, number) })).file
      update({ status: "done", progress: 100, dispatch: output, finished_at: new Date().toISOString() })
    } catch (error) {
      if (controller.signal.aborted) update({ status: "canceled", finished_at: new Date().toISOString() })
      else {
        log(`job ${id} failed: ${error.reason ?? error.name}`)
        update({ status: "failed", error: error.message, finished_at: new Date().toISOString() }, error)
      }
    } finally {
      running.delete(id)
    }
  }

  return {
    count: () => running.size,

    start(state, request) {
      const number = state.journal.addJob({ kind: request.kind ?? "render", projectVersion: state.log.head, request })
      void run(state, number, request)
      return view(state, state.journal.job(number))
    },

    async list() {
      const jobs = []
      await projects.each((state) => {
        jobs.push(...state.journal.jobs().map((row) => view(state, row)))
      })
      return jobs
    },

    cancel(id) {
      const controller = running.get(id)
      controller?.abort(new Error("Canceled"))
      return !!controller
    },

    /** What a crash left unfinished. */
    resume: () =>
      projects.each((state) => {
        for (const row of state.journal.jobs("pending")) void run(state, row.id, JSON.parse(row.request))
      }),
  }
}
