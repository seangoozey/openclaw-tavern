import { RPError } from "../errors.js";
import { RP_ERROR_CODES } from "../types.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data || "");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length, 0);
  typeBuffer.copy(header, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, payload])), 0);
  return Buffer.concat([header, payload, crc]);
}

function makeTextChunk(keyword, value) {
  return makeChunk(
    "tEXt",
    Buffer.concat([
      Buffer.from(keyword, "latin1"),
      Buffer.from([0]),
      Buffer.from(String(value || ""), "latin1"),
    ]),
  );
}

function parseBase64JsonChunk(encoded, keyword) {
  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    throw new RPError(RP_ERROR_CODES.PARSE_FAILED, `Failed to decode ${keyword} base64 payload`);
  }

  try {
    return JSON.parse(decoded);
  } catch {
    throw new RPError(RP_ERROR_CODES.PARSE_FAILED, `Failed to parse ${keyword} JSON payload`);
  }
}

export function extractCharacterCardJsonFromPng(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new RPError(RP_ERROR_CODES.PARSE_FAILED, "PNG payload must be a Buffer");
  }
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new RPError(RP_ERROR_CODES.PARSE_FAILED, "Invalid PNG signature");
  }

  let offset = 8;
  let v2Fallback;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > buffer.length) {
      break;
    }

    if (type === "tEXt") {
      const chunk = buffer.subarray(dataStart, dataEnd);
      const separator = chunk.indexOf(0x00);
      if (separator > 0) {
        const keyword = chunk.subarray(0, separator).toString("utf8");
        const encoded = chunk.subarray(separator + 1).toString("utf8").trim();
        if (keyword === "ccv3") {
          return parseBase64JsonChunk(encoded, keyword);
        }
        if (keyword === "chara" && !v2Fallback) {
          v2Fallback = parseBase64JsonChunk(encoded, keyword);
        }
      }
    }

    offset = dataEnd + 4;
  }

  if (v2Fallback) {
    return v2Fallback;
  }

  throw new RPError(RP_ERROR_CODES.PARSE_FAILED, "PNG has no ccv3 or chara tEXt chunk");
}

export function extractCharaJsonFromPng(buffer) {
  return extractCharacterCardJsonFromPng(buffer);
}

export function embedCharacterCardJsonInPng(buffer, card, { legacyChara = true } = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new RPError(RP_ERROR_CODES.PARSE_FAILED, "PNG payload must be a Buffer");
  }
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new RPError(RP_ERROR_CODES.PARSE_FAILED, "Invalid PNG signature");
  }

  const cardJson = JSON.stringify(card);
  const encoded = Buffer.from(cardJson, "utf8").toString("base64");
  const replacementChunks = [makeTextChunk("ccv3", encoded)];
  if (legacyChara) {
    replacementChunks.push(makeTextChunk("chara", encoded));
  }

  const chunks = [];
  let inserted = false;
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;

    if (chunkEnd > buffer.length) {
      throw new RPError(RP_ERROR_CODES.PARSE_FAILED, "PNG contains a truncated chunk");
    }

    if (type === "tEXt") {
      const chunk = buffer.subarray(dataStart, dataEnd);
      const separator = chunk.indexOf(0x00);
      const keyword = separator > 0 ? chunk.subarray(0, separator).toString("latin1") : "";
      if (keyword === "ccv3" || keyword === "chara") {
        offset = chunkEnd;
        continue;
      }
    }

    if (type === "IEND" && !inserted) {
      chunks.push(...replacementChunks);
      inserted = true;
    }

    chunks.push(buffer.subarray(offset, chunkEnd));
    offset = chunkEnd;

    if (type === "IEND") {
      break;
    }
  }

  if (!inserted) {
    throw new RPError(RP_ERROR_CODES.PARSE_FAILED, "PNG missing IEND chunk");
  }

  return Buffer.concat([PNG_SIGNATURE, ...chunks]);
}
