/**
 * Small Server-Sent Events parser. It intentionally handles only the fields
 * this app needs and never evaluates or inserts streamed data as HTML.
 */
export function createSseParser(onData) {
  let lineBuffer = '';
  let dataLines = [];

  const dispatch = () => {
    if (dataLines.length > 0) {
      onData(dataLines.join('\n'));
      dataLines = [];
    }
  };

  const processLine = (line) => {
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }

    if (line === '') {
      dispatch();
      return;
    }

    if (line.startsWith(':')) {
      return;
    }

    if (line === 'data') {
      dataLines.push('');
      return;
    }

    if (line.startsWith('data:')) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  };

  return {
    push(chunk) {
      lineBuffer += chunk;

      let newlineIndex = lineBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        processLine(lineBuffer.slice(0, newlineIndex));
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        newlineIndex = lineBuffer.indexOf('\n');
      }
    },

    finish() {
      if (lineBuffer.length > 0) {
        processLine(lineBuffer);
        lineBuffer = '';
      }
      dispatch();
    },
  };
}
