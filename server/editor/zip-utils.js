const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return textEncoder.encode(value);
  throw new Error('Unsupported ZIP entry data type.');
}

function makeCrc32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

const crc32Table = makeCrc32Table();

function crc32(data) {
  const bytes = toUint8Array(data);
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = crc32Table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function concatUint8Arrays(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.length;
  });
  return output;
}

function normalizePath(path) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('ZIP entry path must be a non-empty string.');
  }
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.includes('..')) {
    throw new Error(`ZIP entry path cannot contain '..': ${path}`);
  }
  return normalized;
}

function createStoredZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('ZIP export requires at least one entry.');
  }

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  entries.forEach((entry, index) => {
    const path = normalizePath(String(entry.path || ''));
    const nameBytes = textEncoder.encode(path);
    const data = toUint8Array(entry.data);
    const checksum = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0);
    writeUint16(localView, 8, 0); // compression method: stored
    writeUint16(localView, 10, 0);
    writeUint16(localView, 12, 0);
    writeUint32(localView, 14, checksum);
    writeUint32(localView, 18, data.length);
    writeUint32(localView, 22, data.length);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    localHeader.set(nameBytes, 30);

    localChunks.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, 0);
    writeUint16(centralView, 14, 0);
    writeUint32(centralView, 16, checksum);
    writeUint32(centralView, 20, data.length);
    writeUint32(centralView, 24, data.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, offset);
    centralHeader.set(nameBytes, 46);

    centralChunks.push(centralHeader);
    offset += localHeader.length + data.length;

    if (index > 65535) {
      throw new Error('ZIP export supports at most 65535 entries.');
    }
  });

  const centralDirectory = concatUint8Arrays(centralChunks);
  const localData = concatUint8Arrays(localChunks);

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  writeUint32(eocdView, 0, 0x06054b50);
  writeUint16(eocdView, 4, 0);
  writeUint16(eocdView, 6, 0);
  writeUint16(eocdView, 8, entries.length);
  writeUint16(eocdView, 10, entries.length);
  writeUint32(eocdView, 12, centralDirectory.length);
  writeUint32(eocdView, 16, localData.length);
  writeUint16(eocdView, 20, 0);

  return concatUint8Arrays([localData, centralDirectory, eocd]);
}

function findEndOfCentralDirectory(bytes) {
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      return i;
    }
  }
  return -1;
}

function parseStoredZip(arrayBuffer) {
  const bytes = toUint8Array(arrayBuffer);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP: missing end of central directory record.');
  }

  const eocdView = new DataView(bytes.buffer, bytes.byteOffset + eocdOffset, bytes.byteLength - eocdOffset);
  const entryCount = eocdView.getUint16(10, true);
  const centralSize = eocdView.getUint32(12, true);
  const centralOffset = eocdView.getUint32(16, true);

  if (centralOffset + centralSize > bytes.length) {
    throw new Error('Invalid ZIP: central directory exceeds file length.');
  }

  const files = new Map();
  let pointer = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + pointer, bytes.byteLength - pointer);
    if (view.getUint32(0, true) !== 0x02014b50) {
      throw new Error('Invalid ZIP: malformed central directory entry.');
    }

    const compressionMethod = view.getUint16(10, true);
    const checksum = view.getUint32(16, true);
    const compressedSize = view.getUint32(20, true);
    const uncompressedSize = view.getUint32(24, true);
    const fileNameLength = view.getUint16(28, true);
    const extraLength = view.getUint16(30, true);
    const commentLength = view.getUint16(32, true);
    const localHeaderOffset = view.getUint32(42, true);

    const nameStart = pointer + 46;
    const nameEnd = nameStart + fileNameLength;
    const fileName = textDecoder.decode(bytes.slice(nameStart, nameEnd));

    const localView = new DataView(bytes.buffer, bytes.byteOffset + localHeaderOffset, bytes.byteLength - localHeaderOffset);
    if (localView.getUint32(0, true) !== 0x04034b50) {
      throw new Error(`Invalid ZIP: malformed local header for ${fileName}.`);
    }
    const localNameLength = localView.getUint16(26, true);
    const localExtraLength = localView.getUint16(28, true);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;

    if (compressionMethod !== 0) {
      throw new Error(`Unsupported ZIP compression for ${fileName}; only stored entries are supported.`);
    }

    const data = bytes.slice(dataStart, dataEnd);
    if (uncompressedSize !== data.length) {
      throw new Error(`Invalid ZIP entry size for ${fileName}.`);
    }
    if (crc32(data) !== checksum) {
      throw new Error(`ZIP CRC mismatch for ${fileName}.`);
    }

    files.set(fileName, data);
    pointer = nameEnd + extraLength + commentLength;
  }

  return files;
}

function decodeUtf8(bytes) {
  return textDecoder.decode(toUint8Array(bytes));
}

export {
  crc32,
  createStoredZip,
  parseStoredZip,
  decodeUtf8,
  toUint8Array,
};
