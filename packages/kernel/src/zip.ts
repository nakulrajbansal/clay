// Minimal ZIP (STORE method only) for .clay archives (doc 04 §7).
// Dependency-free on purpose — the kernel budget (doc 06 §6) outweighs
// compression: SQLite files are small at personal scale.

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++)
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; data: Uint8Array };

export function zipWrite(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL_SIG, true);
    local.setUint16(4, 20, true);              // version needed
    local.setUint16(6, 0, true);               // flags
    local.setUint16(8, 0, true);               // method: STORE
    local.setUint32(10, 0, true);              // time/date
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.data.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);              // extra len
    chunks.push(new Uint8Array(local.buffer), name, entry.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, CENTRAL_SIG, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0, true);
    cd.setUint16(10, 0, true);
    cd.setUint32(12, 0, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, entry.data.length, true);
    cd.setUint32(24, entry.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);            // local header offset
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + entry.data.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, EOCD_SIG, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdOffset, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of [...chunks, ...central, new Uint8Array(eocd.buffer)]) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export function zipRead(bytes: Uint8Array): ZipEntry[] {
  if (bytes.byteLength < 22) throw new Error("not a zip archive (too small)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let index = bytes.length - 22;
    index >= Math.max(0, bytes.length - 22 - 65_535); index--) {
    if (view.getUint32(index, true) === EOCD_SIG) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end record)");
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskCount = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (disk !== 0 || centralDisk !== 0 || diskCount !== count)
    throw new Error("corrupt zip: multi-disk or entry count mismatch");
  if (count > 32) throw new Error("corrupt zip: too many entries");
  if (commentLength !== 0 || eocd + 22 !== bytes.length)
    throw new Error("corrupt zip: unsupported trailing data or archive comment");
  if (cdOffset > eocd || cdSize > eocd || cdOffset + cdSize !== eocd)
    throw new Error("corrupt zip: invalid central directory bounds");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  const localRanges: Array<{ start: number; end: number }> = [];
  let pos = cdOffset;
  for (let index = 0; index < count; index++) {
    if (pos + 46 > eocd || view.getUint32(pos, true) !== CENTRAL_SIG)
      throw new Error("corrupt zip: bad or truncated central directory");
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const entryCommentLength = view.getUint16(pos + 32, true);
    const startDisk = view.getUint16(pos + 34, true);
    const localOffset = view.getUint32(pos + 42, true);
    const centralEnd = pos + 46 + nameLength + extraLength + entryCommentLength;
    if (centralEnd > eocd || flags !== 0 || method !== 0 || compressedSize !== size
        || extraLength !== 0 || entryCommentLength !== 0 || startDisk !== 0)
      throw new Error("corrupt zip: unsupported or incoherent central entry");
    const centralNameBytes = bytes.subarray(pos + 46, pos + 46 + nameLength);
    let name: string;
    try { name = decoder.decode(centralNameBytes); }
    catch { throw new Error("corrupt zip: entry name is not valid UTF-8"); }

    if (localOffset + 30 > cdOffset || view.getUint32(localOffset, true) !== LOCAL_SIG)
      throw new Error(`corrupt zip: bad local header for '${name}'`);
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (localFlags !== flags || localMethod !== method || localCrc !== crc
        || localCompressedSize !== compressedSize || localSize !== size
        || localNameLength !== nameLength || localExtraLength !== 0 || dataEnd > cdOffset)
      throw new Error(`corrupt zip: incoherent local header for '${name}'`);
    const localNameBytes = bytes.subarray(localNameStart, localNameEnd);
    if (localNameBytes.length !== centralNameBytes.length
        || localNameBytes.some((byte, offset) => byte !== centralNameBytes[offset]))
      throw new Error(`corrupt zip: local name mismatch for '${name}'`);
    const data = bytes.subarray(dataStart, dataEnd);
    if (crc32(data) !== crc)
      throw new Error(`corrupt zip: crc mismatch for '${name}'`);
    entries.push({ name, data });
    localRanges.push({ start: localOffset, end: dataEnd });
    pos = centralEnd;
  }
  if (pos !== cdOffset + cdSize)
    throw new Error("corrupt zip: central directory size mismatch");
  localRanges.sort((left, right) => left.start - right.start);
  let localEnd = 0;
  for (const range of localRanges) {
    if (range.start !== localEnd)
      throw new Error("corrupt zip: overlapping or unsupported local data");
    localEnd = range.end;
  }
  if (localEnd !== cdOffset)
    throw new Error("corrupt zip: unsupported data before central directory");
  return entries;
}
