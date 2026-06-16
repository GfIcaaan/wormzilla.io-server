'use strict';

// Mirrors client Ph class (DataView, little-endian)
class BinaryWriter {
  constructor(size) {
    this.buf = Buffer.allocUnsafe(size);
    this.pos = 0;
  }

  // Ef - Int8
  writeInt8(v) { this.buf.writeInt8(v, this.pos); this.pos += 1; }
  // Rm - fixed Uint8(99)
  writeMarker() { this.buf.writeUInt8(99, this.pos); this.pos += 1; }
  // Db - Int16 LE
  writeInt16(v) { this.buf.writeInt16LE(v, this.pos); this.pos += 2; }
  // tn - Uint16 LE
  writeUInt16(v) { this.buf.writeUInt16LE(v, this.pos); this.pos += 2; }
  // yn - Uint32 LE
  writeUInt32(v) { this.buf.writeUInt32LE(v >>> 0, this.pos); this.pos += 4; }
  // Float32 LE
  writeFloat32(v) { this.buf.writeFloatLE(v, this.pos); this.pos += 4; }
  // Uint8
  writeUInt8(v) { this.buf.writeUInt8(v, this.pos); this.pos += 1; }
  // Int32 LE
  writeInt32(v) { this.buf.writeInt32LE(v, this.pos); this.pos += 4; }

  // Varint (MSB-flag chain, same as jb)
  writeVarint(v) {
    if (v < 128) {
      this.buf.writeUInt8(v, this.pos); this.pos += 1;
    } else if (v < 16384) {
      this.buf.writeUInt8((v >> 7) | 128, this.pos); this.pos += 1;
      this.buf.writeUInt8(v & 127, this.pos); this.pos += 1;
    } else if (v < 2097152) {
      this.buf.writeUInt8((v >> 14) | 128, this.pos); this.pos += 1;
      this.buf.writeUInt8(((v >> 7) & 127) | 128, this.pos); this.pos += 1;
      this.buf.writeUInt8(v & 127, this.pos); this.pos += 1;
    } else {
      this.buf.writeUInt8((v >> 21) | 128, this.pos); this.pos += 1;
      this.buf.writeUInt8(((v >> 14) & 127) | 128, this.pos); this.pos += 1;
      this.buf.writeUInt8(((v >> 7) & 127) | 128, this.pos); this.pos += 1;
      this.buf.writeUInt8(v & 127, this.pos); this.pos += 1;
    }
  }

  toBuffer() { return this.buf.subarray(0, this.pos); }
}

module.exports = BinaryWriter;
