// Cross-browser alias: Firefox exposes `browser`, Chrome exposes `chrome`.
const api = typeof browser !== 'undefined' ? browser : chrome

const MSG = {
  SIDE_Q: 'side-q',
  DELTA: 'delta',
  DONE: 'done',
  ERROR: 'error',
  CANCEL: 'cancel',
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const DEFAULT_MODEL = 'gpt-5-mini'

const SYSTEM_PROMPT =
  "You answer a user's side-question about a snippet from a ChatGPT reply. " +
  'Be concise: at most 3 sentences unless the question explicitly asks for more. ' +
  'Plain text only, no preamble, no markdown headers.'

api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'side-q') return

  const abortController = new AbortController()

  port.onDisconnect.addListener(() => abortController.abort())
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === MSG.CANCEL) {
      abortController.abort()
      return
    }
    if (msg?.type !== MSG.SIDE_Q) return

    try {
      await streamAnswer(port, msg, abortController.signal)
    } catch (err) {
      if (err?.name === 'AbortError') return
      safePost(port, { type: MSG.ERROR, message: err?.message || String(err) })
    }
  })
})

async function streamAnswer(port, { snippet, messageText, question }, signal) {
  const { apiKey, model } = await api.storage.local.get(['apiKey', 'model'])
  if (!apiKey) {
    safePost(port, {
      type: MSG.ERROR,
      message:
        'No OpenAI API key set. Open the extension options and paste one in.',
    })
    return
  }

  const body = {
    model: model || DEFAULT_MODEL,
    stream: true,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `CONTEXT (full assistant message):\n${messageText}\n\n` +
          `HIGHLIGHTED:\n${snippet}\n\n` +
          `QUESTION:\n${question}`,
      },
    ],
  }

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    safePost(port, {
      type: MSG.ERROR,
      message: `OpenAI ${res.status}: ${text.slice(0, 500) || res.statusText}`,
    })
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      handleSseEvent(event, port)
    }
  }

  safePost(port, { type: MSG.DONE })
}

function handleSseEvent(event, port) {
  for (const line of event.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const json = JSON.parse(payload)
      const delta = json?.choices?.[0]?.delta?.content
      if (delta) safePost(port, { type: MSG.DELTA, text: delta })
    } catch {
      // ignore malformed frames — OpenAI occasionally sends keep-alives
    }
  }
}

function safePost(port, msg) {
  try {
    port.postMessage(msg)
  } catch {
    // port was closed on the content-script side — nothing we can do
  }
}
