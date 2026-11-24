// Classic, single-volume ZIP. Inspect metadata and establish disjoint physical
// ranges for the entire archive before handing any contents to a decoder.
const decoder = new TextDecoder();

function invalid(reason) {
  throw new Error('Invalid ZIP: ' + reason);
}

export function checkZipLimit(limit, maximum, actual, path) {
  if (actual > maximum) {
    throw Object.assign(new Error('ZIP package exceeds ' + limit + '.'), {
      code: 'ZIP_RESOURCE_LIMIT',
      details: { limit, [limit]: maximum, actual, ...(path === undefined ? {} : { path }) },
    });
  }
}

export function readZipDirectory(bytes, { allowDeflate = false, limits = {} } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = offset => view.getUint16(offset, true);
  const u32 = offset => view.getUint32(offset, true);
  let end = bytes.length - 22;
  const earliest = Math.max(0, end - 65535);
  while (end >= earliest) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
    end--;
  }
  if (end < earliest) invalid('missing end of central directory record');
  const count = u16(end + 10);
  const central = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count) invalid('multi-volume archive');
  if (central + u32(end + 12) !== end || count * 46 > end - central) invalid('central directory bounds');
  checkZipLimit('maxEntries', limits.maxEntries ?? 65535, count);

  const entries = [];
  const names = new Set();
  let cursor = central;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) invalid('central directory entry');
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const checksum = u32(cursor + 16);
    const compressed = u32(cursor + 20);
    const size = u32(cursor + 24);
    const nameLength = u16(cursor + 28);
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + u16(cursor + 30) + u16(cursor + 32);
    const local = u32(cursor + 42);
    if (next > end || u16(cursor + 34) || local + 30 > central) invalid('entry bounds');
    if (flags & ~0x080e) invalid('unsupported entry flags');
    if (method !== 0 && !(allowDeflate && method === 8)) invalid('unsupported ZIP compression method');
    if (method === 0 && compressed !== size) invalid('stored entry size mismatch');
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    const name = decoder.decode(nameBytes);
    if (names.has(name)) invalid('duplicate entry name "' + name + '"');
    names.add(name);
    checkZipLimit('maxEntryNameLength', limits.maxEntryNameLength ?? 65535, name.length, name);
    checkZipLimit('maxEntryBytes', limits.maxEntryBytes ?? central, size, name);
    total += size;
    checkZipLimit('maxUncompressedBytes', limits.maxUncompressedBytes ?? central, total);

    const dataStart = local + 30 + u16(local + 26) + u16(local + 28);
    const dataEnd = dataStart + compressed;
    if (dataEnd > central || u32(local) !== 0x04034b50 || u16(local + 6) !== flags
      || u16(local + 8) !== method || u16(local + 26) !== nameLength
      || !nameBytes.every((byte, n) => byte === bytes[local + 30 + n])) invalid('inconsistent local header');
    let rangeEnd = dataEnd;
    if (flags & 8) {
      // A streaming writer places sizes and CRC after the data.
      if (rangeEnd + 4 <= central && u32(rangeEnd) === 0x08074b50) rangeEnd += 4;
      if (rangeEnd + 12 > central || u32(rangeEnd) !== checksum || u32(rangeEnd + 4) !== compressed
        || u32(rangeEnd + 8) !== size) invalid('data descriptor mismatch');
      rangeEnd += 12;
    } else if (u32(local + 14) !== checksum || u32(local + 18) !== compressed || u32(local + 22) !== size) {
      invalid('inconsistent local checksum or size');
    }
    entries.push({ name, method, size, checksum, local, dataStart, dataEnd, rangeEnd });
    cursor = next;
  }
  if (cursor !== end) invalid('central directory size mismatch');
  const physical = [...entries].sort((a, b) => a.local - b.local);
  for (let i = 1; i < physical.length; i++) {
    if (physical[i].local < physical[i - 1].rangeEnd) invalid('overlapping entries');
  }
  return entries;
}
