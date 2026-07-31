export const MAX_CONTEXT_MESSAGES = 24;
export const MAX_CONTEXT_CHARACTERS = 50_000;
export const MAX_CONTEXT_BYTES = 96_000;
export const MAX_USER_CHARACTERS = 12_000;
export const MAX_ASSISTANT_CHARACTERS = 32_000;

function limitForRole(role) {
  return role === 'assistant' ? MAX_ASSISTANT_CHARACTERS : MAX_USER_CHARACTERS;
}

/**
 * Keep the newest context that the server will accept. If trimming lands in
 * the middle of a turn, drop the orphaned assistant message at the front.
 */
export function prepareRequestHistory(history) {
  const selected = [];
  let characters = 0;
  const encoder = new TextEncoder();

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    if (typeof message.content !== 'string') continue;

    const content = message.content.slice(0, limitForRole(message.role));
    if (!content) continue;
    if (selected.length >= MAX_CONTEXT_MESSAGES) break;
    if (characters + content.length > MAX_CONTEXT_CHARACTERS) break;

    const candidate = [{ role: message.role, content }, ...selected];
    const encodedBytes = encoder.encode(JSON.stringify({ messages: candidate })).byteLength;
    if (encodedBytes > MAX_CONTEXT_BYTES) break;

    selected.unshift(candidate[0]);
    characters += content.length;
  }

  while (selected[0]?.role === 'assistant') {
    selected.shift();
  }

  return selected;
}

export function storeAssistantMessage(content) {
  return {
    role: 'assistant',
    content: content.slice(0, MAX_ASSISTANT_CHARACTERS),
  };
}
