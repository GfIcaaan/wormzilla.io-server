'use strict';

// Mirrors client Wm class (DataView, little-endian)
class BinaryReader {
  constructor(buffer) {
    // Accept Buffer or ArrayBuffer
    this.dv = Buffer.isBuffer(buffer)
      ? new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new DataView(buffer);
    this.pos = 0;
  }

  // n() - getInt8
  readInt8() { const v = this.dv.getInt8(this.pos); this.pos += 1; return v; }
  // Fb() - getUint8
  readUInt8() { const v = this.dv.getUint8(this.pos); this.pos += 1; return v; }
  // Zb() - getUint16 LE
  readUInt16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  // s() - getInt16 LE
  readInt16() { const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  // Vf() - getInt32 LE
  readInt32() { const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  // mn() - getUint32 LE
  readUInt32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  // f() - getFloat32 LE
  readFloat32() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }

  // jb() - varint MSB-chain
  readVarint() {
    let w = this.readUInt8();
    if ((w & 128) === 0) return w;
    let y = this.readUInt8();
    if ((y & 128) === 0) return (y | (w << 7) & 16256);
    let R = this.readUInt8();
    if ((R & 128) === 0) return (R | (y << 7) & 16256 | (w << 14) & 2080768);
    let gg = this.readUInt8();
    if ((gg & 128) === 0) return (gg | (R << 7) & 16256 | (y << 14) & 2080768 | (w << 21) & 266338304);
  }

  get byteLength() { return this.dv.byteLength; }
}

module.exports = BinaryReader;
