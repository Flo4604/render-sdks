// LZ4 block decoding for vtex_c mips. The pak stores each compressed mip as one
// LZ4 block (the client's LZ4_decompress_safe), and the executor decodes them in
// assets/vtex.cpp; this is the same decoder, so the browser uploads the same
// words the executor does.

function readLength(input: Uint8Array, position: { offset: number }, initial: number): number {
  let length = initial;

  if (initial !== 15) {
    return length;
  }

  for (;;) {
    if (position.offset >= input.length) {
      throw new Error("LZ4 length runs past the input");
    }

    const byte = input[position.offset++] ?? 0;
    length += byte;

    if (byte !== 255) {
      return length;
    }
  }
}

// Decodes one LZ4 block into exactly `output.length` bytes.
export function decodeLz4Block(input: Uint8Array, output: Uint8Array): void {
  const position = { offset: 0 };
  let out = 0;

  while (position.offset < input.length) {
    const token = input[position.offset++] ?? 0;
    const literals = readLength(input, position, token >> 4);

    if (literals > input.length - position.offset || literals > output.length - out) {
      throw new Error("LZ4 literals exceed the block");
    }

    output.set(input.subarray(position.offset, position.offset + literals), out);
    position.offset += literals;
    out += literals;

    if (position.offset >= input.length) {
      break;
    }

    if (position.offset + 2 > input.length) {
      throw new Error("LZ4 match offset runs past the input");
    }

    const distance = (input[position.offset] ?? 0) | ((input[position.offset + 1] ?? 0) << 8);
    position.offset += 2;

    if (distance === 0 || distance > out) {
      throw new Error("LZ4 match offset is outside the output");
    }

    const match = readLength(input, position, token & 0x0f) + 4;

    if (match > output.length - out) {
      throw new Error("LZ4 match exceeds the output");
    }

    if (distance >= match) {
      output.copyWithin(out, out - distance, out - distance + match);
    } else {
      for (let index = 0; index < match; index++) {
        output[out + index] = output[out + index - distance] ?? 0;
      }
    }

    out += match;
  }

  if (out !== output.length) {
    throw new Error(`LZ4 block decoded ${out} bytes, expected ${output.length}`);
  }
}

export interface VtexMip {
  offset: number;
  storedBytes: number;
  bytes: number;
  compression: "lz4" | "none";
}

// Every mip of a vtex_c resource from level 0 down, concatenated: the GPU
// words of the texture (the exporter's pixelSha256 hashes these).
export function decodeVtexMips(resource: Uint8Array, mips: readonly VtexMip[]): Uint8Array {
  if (mips.length === 0) {
    throw new Error("A vtex_c texture requires its mip table");
  }

  let total = 0;

  for (const mip of mips) {
    total += mip.bytes;
  }

  const words = new Uint8Array(total);
  let written = 0;

  for (const mip of mips) {
    if (mip.offset > resource.length || mip.storedBytes > resource.length - mip.offset) {
      throw new Error("A vtex_c mip lies outside its resource");
    }

    const source = resource.subarray(mip.offset, mip.offset + mip.storedBytes);
    const target = words.subarray(written, written + mip.bytes);

    if (mip.compression === "lz4") {
      decodeLz4Block(source, target);
    } else if (mip.compression === "none" && mip.storedBytes === mip.bytes) {
      target.set(source);
    } else {
      throw new Error(`Unsupported vtex_c mip compression: ${String(mip.compression)}`);
    }

    written += mip.bytes;
  }

  return words;
}
