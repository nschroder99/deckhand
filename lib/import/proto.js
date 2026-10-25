// Minimal protobuf reader for the handful of Anki messages we need. No schema: callers pick fields by number.
// Returns { [fieldNo]: [values...] }, where each value is a Number (varint), a Uint8Array (length-delimited),
// or a float (fixed32 read as float32). fixed64 is skipped.

export function decode(buf) {
  const out = {};
  let i = 0;
  const push = (f, v) => (out[f] ||= []).push(v);
  const varint = () => {
    let r = 0, mul = 1, b;
    do { b = buf[i++]; r += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    return r;
  };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (i < buf.length) {
    const key = varint();
    const f = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) push(f, varint());
    else if (wire === 2) { const n = varint(); push(f, buf.subarray(i, i + n)); i += n; }
    else if (wire === 5) { push(f, view.getFloat32(i, true)); i += 4; }
    else if (wire === 1) i += 8;
    else throw new Error('protobuf: unsupported wire type ' + wire);
  }
  return out;
}

const td = new TextDecoder();
export const str = (m, f, d = '') => (m[f] ? td.decode(m[f][0]) : d);
export const num = (m, f, d = 0) => (m[f] ? m[f][0] : d);
export const msg = (m, f) => (m[f] ? decode(m[f][0]) : {});
export const bytes = (m, f) => (m[f] ? m[f][0] : null);

// Packed repeated floats (e.g. learning steps), also accepting the unpacked form.
export function floats(m, f) {
  const vals = m[f] || [];
  const out = [];
  for (const v of vals) {
    if (v instanceof Uint8Array) {
      const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
      for (let j = 0; j + 4 <= v.length; j += 4) out.push(dv.getFloat32(j, true));
    } else out.push(v);
  }
  return out;
}
