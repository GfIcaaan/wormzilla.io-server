'use strict';

// ─── XOR Cipher (matches client's o() function) ───────────────────────────

function encodeResponse(str) {
  const encoded = encodeURIComponent(str);
  let key = Math.floor(Math.random() * 256);
  let result = key.toString(16).padStart(2, '0');
  for (let i = 0; i < encoded.length; i++) {
    key = (3793 + 4513 * key) & 255;
    result += (encoded.charCodeAt(i) ^ key).toString(16).padStart(2, '0');
  }
  return result;
}

// ─── BinaryReader ──────────────────────────────────────────────────────────

class BinaryReader {
  constructor(buffer) {
    if (buffer instanceof Buffer) {
      this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else {
      this.view = new DataView(buffer);
    }
    this.offset = 0;
  }

  get bytesLeft() { return this.view.byteLength - this.offset; }

  readInt8()    { const v = this.view.getInt8(this.offset);               this.offset += 1; return v; }
  readUint8()   { const v = this.view.getUint8(this.offset);              this.offset += 1; return v; }
  readUint16()  { const v = this.view.getUint16(this.offset, false);      this.offset += 2; return v; }
  readInt16()   { const v = this.view.getInt16(this.offset, false);       this.offset += 2; return v; }
  readInt32()   { const v = this.view.getInt32(this.offset, false);       this.offset += 4; return v; }
  readUint32()  { const v = this.view.getUint32(this.offset, false);      this.offset += 4; return v; }
  readFloat32() { const v = this.view.getFloat32(this.offset, false);     this.offset += 4; return v; }

  readVarInt() {
    // NOTE: byte order matches the client's VarInt decoder (T.Tn.h.kb in
    // 0tEwHoKWpm.js): the FIRST byte read holds the HIGH bits and the LAST
    // byte read holds the LOW 7 bits -- i.e. big-endian-style continuation,
    // not the little-endian-style ordering used by protobuf-style VarInts.
    // This must mirror writeVarInt() below exactly or every multi-byte
    // VarInt (any count > 127, e.g. food/spawn counts) decodes to a
    // completely different number on the client, desyncing every byte
    // that follows it in the packet.
    let b1 = this.readUint8();
    if ((b1 & 0x80) === 0) return b1;
    let b2 = this.readUint8();
    if ((b2 & 0x80) === 0) return (b2 & 0x7F) | ((b1 & 0x7F) << 7);
    let b3 = this.readUint8();
    if ((b3 & 0x80) === 0) return (b3 & 0x7F) | ((b2 & 0x7F) << 7) | ((b1 & 0x7F) << 14);
    let b4 = this.readUint8();
    return (b4 & 0x7F) | ((b3 & 0x7F) << 7) | ((b2 & 0x7F) << 14) | ((b1 & 0x7F) << 21);
  }

  readString(len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.readInt16());
    return s;
  }
}

// ─── BinaryWriter ──────────────────────────────────────────────────────────

class BinaryWriter {
  constructor(size = 4096) {
    this._chunks = [];
    this._buf = Buffer.allocUnsafe(size);
    this._pos = 0;
    this._size = size;
  }

  _ensure(n) {
    if (this._pos + n > this._size) {
      this._chunks.push(this._buf.slice(0, this._pos));
      this._size = Math.max(4096, n * 2);
      this._buf = Buffer.allocUnsafe(this._size);
      this._pos = 0;
    }
  }

  writeInt8(v)    { this._ensure(1); this._buf.writeInt8(v, this._pos);       this._pos += 1; }
  writeUint8(v)   { this._ensure(1); this._buf.writeUInt8(v, this._pos);      this._pos += 1; }
  writeInt16(v)   { this._ensure(2); this._buf.writeInt16BE(v, this._pos);    this._pos += 2; }
  writeInt32(v)   { this._ensure(4); this._buf.writeInt32BE(v, this._pos);    this._pos += 4; }
  writeUint16(v)  { this._ensure(2); this._buf.writeUInt16BE(v, this._pos);   this._pos += 2; }
  writeUint32(v)  { this._ensure(4); this._buf.writeUInt32BE(v >>> 0, this._pos); this._pos += 4; }
  writeFloat32(v) { this._ensure(4); this._buf.writeFloatBE(v, this._pos);    this._pos += 4; }

  writeVarInt(val) {
    // NOTE: must match the client's VarInt decoder (T.Tn.h.kb in
    // 0tEwHoKWpm.js) exactly. The client treats the FIRST byte it reads as
    // the HIGH bits and the LAST byte as the LOW 7 bits of the value, e.g.
    // for 2 bytes: result = byte2 | ((byte1 << 7) & 16256) -- byte1 (read
    // first) is shifted left, byte2 (read last) is the low bits. This is
    // the opposite order of a standard protobuf-style VarInt (which is why
    // the previous implementation -- low byte first -- silently produced a
    // different number on the client for any value >= 128, corrupting the
    // read offset for every byte after it in the same packet, including
    // the spawn/food section that crashes with "Cannot read properties of
    // undefined (reading 'Ja')" once the registry index it lands on by
    // accident is out of range).
    val = val >>> 0;
    if (val < 128) {
      this.writeUint8(val);
    } else if (val < 16384) {
      this.writeUint8(((val >> 7) & 0x7F) | 0x80);
      this.writeUint8(val & 0x7F);
    } else if (val < 2097152) {
      this.writeUint8(((val >> 14) & 0x7F) | 0x80);
      this.writeUint8(((val >> 7) & 0x7F) | 0x80);
      this.writeUint8(val & 0x7F);
    } else {
      this.writeUint8(((val >> 21) & 0x7F) | 0x80);
      this.writeUint8(((val >> 14) & 0x7F) | 0x80);
      this.writeUint8(((val >> 7) & 0x7F) | 0x80);
      this.writeUint8(val & 0x7F);
    }
  }

  writeString(str) {
    for (let i = 0; i < str.length; i++) this.writeUint16(str.charCodeAt(i));
  }

  toBuffer() {
    if (this._chunks.length === 0) return this._buf.slice(0, this._pos);
    this._chunks.push(this._buf.slice(0, this._pos));
    return Buffer.concat(this._chunks);
  }
}

module.exports = { encodeResponse, BinaryReader, BinaryWriter };