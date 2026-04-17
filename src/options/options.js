const api = typeof browser !== 'undefined' ? browser : chrome

const keyInput = document.getElementById('api-key')
const modelSelect = document.getElementById('model')
const statusEl = document.getElementById('status')
const saveBtn = document.getElementById('save')
const testBtn = document.getElementById('test')

init()

async function init() {
  const { apiKey = '', model = 'gpt-5-mini' } = await api.storage.local.get([
    'apiKey',
    'model',
  ])
  keyInput.value = apiKey
  modelSelect.value = model
  saveBtn.addEventListener('click', onSave)
  testBtn.addEventListener('click', onTest)
}

async function onSave() {
  const apiKey = keyInput.value.trim()
  const model = modelSelect.value
  await api.storage.local.set({ apiKey, model })
  setStatus('Saved.', 'ok')
}

async function onTest() {
  const apiKey = keyInput.value.trim()
  if (!apiKey) return setStatus('Enter a key first.', 'err')
  setStatus('Testing…', '')
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (res.ok) {
      setStatus('Key works.', 'ok')
    } else {
      const text = await res.text().catch(() => '')
      setStatus(
        `OpenAI ${res.status}: ${text.slice(0, 200) || res.statusText}`,
        'err',
      )
    }
  } catch (err) {
    setStatus(`Network error: ${err.message}`, 'err')
  }
}

function setStatus(text, kind) {
  statusEl.textContent = text
  statusEl.className = `status ${kind}`
}
