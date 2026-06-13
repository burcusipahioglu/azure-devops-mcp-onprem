import { FILE_CONTENT_TRUNCATION_LIMIT } from "../constants.js";

// How many leading bytes to sniff when deciding if content is binary.
const BINARY_SNIFF_BYTES = 8192;

export type DecodedFileContent =
  | { binary: true }
  | { binary: false; content: string; truncated: boolean };

// Decode a fetched file buffer for LLM context. Two guards, both about not
// shipping useless tokens:
//   - Binary detection: a NUL byte in the first 8KB means the file is binary
//     (a .dll/.png/.pdb), which utf-8 decodes to mojibake the model can't use.
//     Return { binary: true } so the caller reports the file changed WITHOUT
//     dumping its bytes. (NUL-byte is git's own heuristic — robust and
//     denylist-free; the only false-positive is UTF-16 text, rare in source.)
//   - Truncation: cap at maxBytes (characters, despite the name — substring)
//     so a huge file can't blow the context window. The [truncated] marker
//     tells the model the content was cut, so it won't claim it saw all of it.
export function decodeFileContent(
  buffer: Buffer,
  maxBytes?: number
): DecodedFileContent {
  const sniffLen = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sniffLen; i++) {
    if (buffer[i] === 0) return { binary: true };
  }

  const decoded = buffer.toString("utf-8");
  const limit = maxBytes ?? FILE_CONTENT_TRUNCATION_LIMIT;
  if (decoded.length > limit) {
    return {
      binary: false,
      content: decoded.substring(0, limit) + "\n... [truncated, file too large]",
      truncated: true,
    };
  }
  return { binary: false, content: decoded, truncated: false };
}
