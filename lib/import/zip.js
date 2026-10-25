// Random-access zip reader over a File/Blob: reads the central directory, then one entry at a time via slice(),
// so a several-hundred-MB deck never has to sit in memory at once (phones kill tabs that try).
import { inflateSync } from '../vendor/fflate.mjs';

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 0x100000000;
const bytesOf = async (file, start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());
const td = new TextDecoder();

export async function openZip(file) {
  const tailLen = Math.min(file.size, 65557);
  const tail = await bytesOf(file, file.size - tailLen, file.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("This doesn't look like an Anki package (not a zip file).");
  let count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOff = u32(tail, eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {
    // Zip64: the locator sits just before the end record and points at the zip64 end record.
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new Error('Unsupported zip layout.');
    const recOff = u64(tail, loc + 8);
    const rec = await bytesOf(file, recOff, recOff + 56);
    count = u64(rec, 32); cdSize = u64(rec, 40); cdOff = u64(rec, 48);
  }
  const cd = await bytesOf(file, cdOff, cdOff + cdSize);
  const entries = new Map();
  let p = 0;
  for (let n = 0; n < count && u32(cd, p) === 0x02014b50; n++) {
    const method = u16(cd, p + 10);
    let csize = u32(cd, p + 20), size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const name = td.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // Zip64 extra field holds the real values for any field set to 0xffffffff, in this order.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = u16(cd, x), len = u16(cd, x + 2);
      if (id === 1) {
        let q = x + 4;
        if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; }
        if (offset === 0xffffffff) offset = u64(cd, q);
      }
      x += 4 + len;
    }
    entries.set(name, { name, method, csize, size, offset });
    p = xEnd + commentLen;
  }

  async function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    const head = await bytesOf(file, e.offset, e.offset + 30);
    if (u32(head, 0) !== 0x04034b50) throw new Error('Corrupt zip entry: ' + name);
    const start = e.offset + 30 + u16(head, 26) + u16(head, 28);
    const raw = await bytesOf(file, start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8) return inflateSync(raw, { out: new Uint8Array(e.size) });
    throw new Error(`Unsupported compression (method ${e.method}) for ${name}`);
  }
  return { entries, has: name => entries.has(name), read };
}
