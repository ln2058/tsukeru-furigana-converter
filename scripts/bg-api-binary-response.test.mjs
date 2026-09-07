import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = process.getBuiltinModule('fs');

function makeHeaders(values = {}) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  return {
    get(name) {
      return normalized[String(name).toLowerCase()] || '';
    },
  };
}

function makeResponse({ contentType, contentLength, chunks, blob }) {
  let chunkIndex = 0;
  let cancelled = false;
  let released = false;
  const response = {
    headers: makeHeaders({ 'Content-Type': contentType, 'Content-Length': contentLength }),
    body: chunks
      ? {
        getReader() {
          return {
            async read() {
              if (chunkIndex >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: chunks[chunkIndex++] };
            },
            async cancel() { cancelled = true; },
            releaseLock() { released = true; },
          };
        },
      }
      : null,
    async blob() { return blob; },
  };
  return {
    response,
    wasCancelled: () => cancelled,
    wasReleased: () => released,
  };
}

function loadBinaryHelpers(browserName) {
  const fileUrl = new URL(`../${browserName}/js/bg-api.js`, import.meta.url);
  let source = readFileSync(fileUrl, 'utf8')
    .replace(/import\s+\{[\s\S]*?\}\s+from\s+'\.\/bg-cache\.js';\s*/m, '')
    .replace(/import\s+\{[\s\S]*?\}\s+from\s+'\.\/utils\.js';\s*/m, '')
    .replace(/^export\s+/gm, '');
  source += `
    globalThis.__api = { normalizeResponseMimeType, readBoundedResponseBlob };
  `;
  const sandbox = {
    Blob,
    Uint8Array,
    URL,
    console: { info() {}, warn() {}, error() {} },
    crypto: { randomUUID: () => `${browserName}-session` },
    fetch: async () => { throw new Error('unexpected fetch'); },
  };
  vm.runInNewContext(source, sandbox, { filename: fileUrl.pathname });
  return sandbox.__api;
}

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName} normalizes and rejects binary response MIME types`, async () => {
    const api = loadBinaryHelpers(browserName);
    assert.equal(api.normalizeResponseMimeType(' Audio/MPEG; charset=binary '), 'audio/mpeg');

    const invalid = makeResponse({
      contentType: 'text/html; charset=utf-8',
      blob: new Blob(['not audio'], { type: 'text/html' }),
    });
    await assert.rejects(
      () => api.readBoundedResponseBlob(invalid.response, {
        maxBytes: 1024,
        allowedMimeTypes: ['audio/mpeg'],
      }),
      /Unexpected response content type/,
    );
  });

  test(`${browserName} rejects a declared oversized response before reading it`, async () => {
    const api = loadBinaryHelpers(browserName);
    let blobRead = false;
    const fixture = makeResponse({
      contentType: 'application/zip',
      contentLength: 11,
      blob: new Blob(['small'], { type: 'application/zip' }),
    });
    fixture.response.blob = async () => {
      blobRead = true;
      return new Blob(['small'], { type: 'application/zip' });
    };

    await assert.rejects(
      () => api.readBoundedResponseBlob(fixture.response, {
        maxBytes: 10,
        allowedMimeTypes: ['application/zip'],
      }),
      /exceeds the permitted size/,
    );
    assert.equal(blobRead, false);
  });

  test(`${browserName} cancels a stream that exceeds its limit`, async () => {
    const api = loadBinaryHelpers(browserName);
    const fixture = makeResponse({
      contentType: 'audio/mpeg',
      chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
    });

    await assert.rejects(
      () => api.readBoundedResponseBlob(fixture.response, {
        maxBytes: 4,
        allowedMimeTypes: ['audio/mpeg'],
      }),
      /exceeds the permitted size/,
    );
    assert.equal(fixture.wasCancelled(), true);
    assert.equal(fixture.wasReleased(), true);
  });

  test(`${browserName} returns valid audio and ZIP blobs with validated MIME types`, async () => {
    const api = loadBinaryHelpers(browserName);
    const audio = makeResponse({
      contentType: 'AUDIO/MPEG; charset=binary',
      chunks: [new Uint8Array([1, 2, 3])],
    });
    const audioBlob = await api.readBoundedResponseBlob(audio.response, {
      maxBytes: 10,
      allowedMimeTypes: ['audio/mpeg'],
    });
    assert.equal(audioBlob.type, 'audio/mpeg');
    assert.equal(audioBlob.size, 3);

    const zip = makeResponse({
      contentType: 'application/zip; charset=binary',
      blob: new Blob([new Uint8Array([4, 5])], { type: 'application/octet-stream' }),
    });
    const zipBlob = await api.readBoundedResponseBlob(zip.response, {
      maxBytes: 10,
      allowedMimeTypes: ['application/zip'],
    });
    assert.equal(zipBlob.type, 'application/zip');
    assert.equal(zipBlob.size, 2);
  });
}
