// Plain DOM, no framework: the Studio shares no React tree with the harness, and
// needs none of its own for this much UI.

/** h("button", { class: "x", onclick }, "Text", child) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value)
    else if (key === "class") el.className = value
    else if (key === "dataset") Object.assign(el.dataset, value)
    else if (value === true) el.setAttribute(key, "")
    else el.setAttribute(key, String(value))
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child))
  return el
}

export const clear = (el) => {
  el.replaceChildren()
  return el
}

/** Fetch against the Host, same origin. Answers JSON; a refusal throws its plain message. */
export async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(value.message ?? `The Edit Host answered ${response.status}.`)
    error.status = response.status
    error.value = value
    throw error
  }
  return value
}
