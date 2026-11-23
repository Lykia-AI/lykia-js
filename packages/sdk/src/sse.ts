/**
 * Minimal Server-Sent Events parser (WHATWG `text/event-stream` rules):
 * LF / CRLF / CR line endings, comment lines, multi-line `data`, UTF-8 split across chunks.
 */

export interface ServerSentEvent {
  event: string | undefined;
  data: string;
  id: string | undefined;
}

/** Maximum size of one event's data; a larger event is a protocol violation. */
const MAX_EVENT_BYTES = 16 * 1024 * 1024;

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  /** Called on every network read (including keep-alive comments); used for idle timeouts. */
  onRead?: () => void,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let dataLines: string[] = [];
  let dataSize = 0;
  let eventName: string | undefined;
  let lastId: string | undefined;
  let pendingCR = false;
  let finished = false;

  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  function* processLine(line: string): Generator<ServerSentEvent> {
    if (line === '') {
      if (dataLines.length > 0) {
        yield { event: eventName, data: dataLines.join('\n'), id: lastId };
      }
      dataLines = [];
      dataSize = 0;
      eventName = undefined;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        dataSize += value.length + 1;
        if (dataSize > MAX_EVENT_BYTES) throw new Error('SSE event exceeds the maximum size');
        dataLines.push(value);
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        if (!value.includes('\0')) lastId = value;
        break;
      default:
        break;
    }
  }

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      onRead?.();
      buffer += decoder.decode(value, { stream: true });
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer.charCodeAt(i);
        if (pendingCR) {
          pendingCR = false;
          if (ch === 10 /* \n */) {
            start = i + 1;
            continue;
          }
        }
        if (ch === 10 || ch === 13) {
          const line = buffer.slice(start, i);
          if (ch === 13) pendingCR = true;
          start = i + 1;
          yield* processLine(line);
        }
      }
      buffer = buffer.slice(start);
      if (buffer.length > MAX_EVENT_BYTES) throw new Error('SSE line exceeds the maximum size');
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield* processLine(buffer);
    // A stream that ends without a trailing blank line still dispatches the last event.
    yield* processLine('');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // The consumer stopped early (break / throw / abort): close the connection.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
