import './style.css';
import { prepareRequestHistory, storeAssistantMessage } from './history.js';
import { createSseParser } from './sse.js';

const chat = document.querySelector('#chat');
const messagesElement = document.querySelector('#messages');
const welcome = document.querySelector('#welcome');
const form = document.querySelector('#composer');
const promptInput = document.querySelector('#prompt');
const sendButton = document.querySelector('#send');
const newChatButton = document.querySelector('#new-chat');
const themeToggle = document.querySelector('#theme-toggle');
const toast = document.querySelector('#toast');

const explicitEndpoint = import.meta.env.VITE_CHAT_ENDPOINT?.trim();
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim().replace(/\/$/, '');
const publicApiKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
const chatEndpoint =
  explicitEndpoint || (supabaseUrl ? `${supabaseUrl}/functions/v1/chat` : '/api/chat');

let history = [];
let activeController = null;
let toastTimer = null;
let chatGeneration = 0;

function makeIcon() {
  const wrapper = document.createElement('div');
  wrapper.className = 'message-avatar';
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.innerHTML = `
    <svg viewBox="0 0 24 24">
      <path d="M13.2 2 5.7 13.1h5.2L10.8 22l7.5-11.1h-5.2L13.2 2Z"></path>
    </svg>`;
  return wrapper;
}

function appendUserMessage(content) {
  const article = document.createElement('article');
  article.className = 'message message-user';

  const body = document.createElement('div');
  body.className = 'message-body';

  const label = document.createElement('p');
  label.className = 'message-label';
  label.textContent = 'You';

  const text = document.createElement('p');
  text.className = 'message-text';
  text.textContent = content;

  body.append(label, text);
  article.append(body);
  messagesElement.append(article);
}

function appendAssistantMessage() {
  const article = document.createElement('article');
  article.className = 'message message-assistant';

  const body = document.createElement('div');
  body.className = 'message-body';

  const label = document.createElement('p');
  label.className = 'message-label';
  label.textContent = 'DeepSeek';

  const reasoning = document.createElement('details');
  reasoning.className = 'reasoning';
  reasoning.hidden = true;

  const summary = document.createElement('summary');
  summary.textContent = 'Reasoning…';

  const reasoningText = document.createElement('pre');
  reasoningText.className = 'reasoning-text';
  reasoning.append(summary, reasoningText);

  const text = document.createElement('p');
  text.className = 'message-text';

  const indicator = document.createElement('span');
  indicator.className = 'thinking-indicator';
  indicator.setAttribute('aria-label', 'DeepSeek is reasoning');
  indicator.innerHTML = '<span></span><span></span><span></span>';
  text.append(indicator);

  body.append(label, reasoning, text);
  article.append(makeIcon(), body);
  messagesElement.append(article);

  return { article, reasoning, reasoningText, summary, text };
}

function updateAssistant(refs, state, finished = false) {
  if (state.reasoning) {
    refs.reasoning.hidden = false;
    refs.reasoningText.textContent = state.reasoning;
  }

  if (state.content) {
    refs.text.textContent = state.content;
  }

  if (finished) {
    refs.summary.textContent = 'Reasoning';
    if (!state.content) {
      refs.text.textContent = state.reasoning
        ? 'The model completed its reasoning without returning a final answer.'
        : 'No response was returned.';
    }
  }
}

function setBusy(isBusy) {
  promptInput.disabled = isBusy;
  sendButton.disabled = !isBusy && promptInput.value.trim().length === 0;
  sendButton.classList.toggle('is-generating', isBusy);
  sendButton.setAttribute('aria-label', isBusy ? 'Stop generating' : 'Send message');
  chat.setAttribute('aria-busy', String(isBusy));
  if (isBusy) sendButton.focus({ preventScroll: true });
}

function resizePrompt() {
  promptInput.style.height = '0px';
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
  if (!activeController) {
    sendButton.disabled = promptInput.value.trim().length === 0;
  }
}

function scrollToBottom(behavior = 'smooth') {
  chat.scrollTo({ top: chat.scrollHeight, behavior });
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 4500);
}

const GENERIC_ERROR = 'Something went wrong. Please try again.';

/**
 * Messages this app raised on purpose are safe to show. Anything else is an
 * internal fault (a JSON parse failure on the upstream stream, a network
 * TypeError) whose text can carry raw upstream fragments, so it is replaced
 * with a fixed sentence.
 */
class ChatDisplayError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChatDisplayError';
  }
}

function displayableError(error) {
  if (error instanceof ChatDisplayError && error.message) return error.message;
  return GENERIC_ERROR;
}

async function readError(response) {
  try {
    const body = await response.json();
    // Only this app's own `{ error: <string> }` contract is surfaced. A nested
    // shape can only come from an intermediary (gateway, CDN, proxy), and its
    // wording is internal detail that must not reach the transcript.
    if (typeof body.error === 'string') return body.error;
  } catch {
    // The fallback below is deliberately generic so server details stay private.
  }

  if (response.status === 429) {
    return 'Too many requests. Please wait a moment and try again.';
  }
  if (response.status === 403) {
    return 'This chat cannot be used from this address.';
  }
  if (response.status === 503) {
    return 'The chat service has not been configured yet.';
  }
  return `The chat request failed (${response.status}).`;
}

function parseChunk(data, state) {
  if (data === '[DONE]') return;

  const event = JSON.parse(data);
  if (event.error) {
    // The stream is proxied from the model provider, so anything in `error`
    // is upstream internal detail. Never surface it in the transcript.
    throw new ChatDisplayError(
      'The chat service could not complete this response. Please try again.',
    );
  }

  const delta = event.choices?.[0]?.delta;
  if (!delta) return;

  if (typeof delta.reasoning_content === 'string') {
    state.reasoning += delta.reasoning_content;
  }
  if (typeof delta.content === 'string') {
    state.content += delta.content;
  }
}

async function submitPrompt(rawPrompt) {
  const content = rawPrompt.trim();
  if (!content || activeController) return;

  welcome.hidden = true;
  appendUserMessage(content);
  const historyBeforeRequest = history;
  const requestHistory = prepareRequestHistory([...history, { role: 'user', content }]);
  history = requestHistory;

  promptInput.value = '';
  resizePrompt();

  const assistantRefs = appendAssistantMessage();
  const assistant = { role: 'assistant', content: '', reasoning: '' };
  const controller = new AbortController();
  const generation = chatGeneration;
  activeController = controller;
  setBusy(true);
  scrollToBottom();

  let renderFrame = 0;
  const scheduleRender = () => {
    if (renderFrame) return;
    renderFrame = window.requestAnimationFrame(() => {
      renderFrame = 0;
      updateAssistant(assistantRefs, assistant);
      scrollToBottom('auto');
    });
  };

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (publicApiKey) {
      headers.apikey = publicApiKey;
      headers.Authorization = `Bearer ${publicApiKey}`;
    }

    const response = await fetch(chatEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: requestHistory }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ChatDisplayError(await readError(response));
    }
    if (!response.body) {
      throw new ChatDisplayError('The server returned an empty response.');
    }

    const decoder = new TextDecoder();
    const parser = createSseParser((data) => {
      parseChunk(data, assistant);
      scheduleRender();
    });

    const reader = response.body.getReader();

    try {
      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        parser.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
    
    parser.push(decoder.decode());
    parser.finish();

    if (renderFrame) {
      window.cancelAnimationFrame(renderFrame);
      renderFrame = 0;
    }
    updateAssistant(assistantRefs, assistant, true);

    if (assistant.content && generation === chatGeneration) {
      history = [...requestHistory, storeAssistantMessage(assistant.content)];
    }
  } catch (error) {
    if (renderFrame) {
      window.cancelAnimationFrame(renderFrame);
      renderFrame = 0;
    }

    if (error?.name === 'AbortError') {
      updateAssistant(assistantRefs, assistant, true);
      if (assistant.content && generation === chatGeneration) {
        history = [...requestHistory, storeAssistantMessage(assistant.content)];
      }
      showToast('Generation stopped.');
    } else {
      if (generation === chatGeneration) history = historyBeforeRequest;
      assistantRefs.article.classList.add('message-error');
      assistantRefs.reasoning.hidden = true;
      assistantRefs.text.textContent = displayableError(error);
    }
  } finally {
    if (activeController === controller) {
      activeController = null;
      setBusy(false);
      promptInput.focus();
      scrollToBottom();
    }
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (activeController) {
    activeController.abort();
    return;
  }
  void submitPrompt(promptInput.value);
});

promptInput.addEventListener('input', resizePrompt);
promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

newChatButton.addEventListener('click', () => {
  chatGeneration += 1;
  activeController?.abort();
  activeController = null;
  history = [];
  messagesElement.replaceChildren();
  welcome.hidden = false;
  promptInput.disabled = false;
  promptInput.value = '';
  resizePrompt();
  setBusy(false);
  promptInput.focus();
  chat.scrollTo({ top: 0 });
});

document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.addEventListener('click', () => {
    void submitPrompt(button.dataset.prompt || '');
  });
});

resizePrompt();

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#131414' : '#ffffff';
}

const savedTheme = localStorage.getItem('theme') || 'light';
applyTheme(savedTheme);

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
});
