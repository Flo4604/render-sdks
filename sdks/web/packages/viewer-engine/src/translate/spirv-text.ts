// A SPIR-V module as the text that `spirv-dis --raw-id` prints and `spirv-as`
// reads back. The lowering passes edit instructions in this form because the
// text names every operand, so the passes need no opcode grammar. Debug
// instructions are dropped on parse: naga names its own identifiers.

export interface Instruction {
  // The result id without its `%`, or undefined for instructions with none.
  result: string | undefined;
  op: string;
  // Operands as printed, including the result type id of a typed instruction.
  operands: string[];
}

const debugOps = new Set([
  "OpName",
  "OpMemberName",
  "OpSource",
  "OpSourceExtension",
  "OpSourceContinued",
  "OpString",
  "OpLine",
  "OpNoLine",
  "OpModuleProcessed",
]);

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < line.length) {
    const character = line[index];

    if (character === " " || character === "\t") {
      index++;
      continue;
    }

    if (character === ";") {
      break;
    }

    if (character === '"') {
      let end = index + 1;

      while (end < line.length && line[end] !== '"') {
        end += line[end] === "\\" ? 2 : 1;
      }

      tokens.push(line.slice(index, end + 1));
      index = end + 1;
      continue;
    }

    let end = index;

    while (end < line.length && line[end] !== " " && line[end] !== "\t") {
      end++;
    }

    tokens.push(line.slice(index, end));
    index = end;
  }

  return tokens;
}

export function parseInstruction(line: string): Instruction | undefined {
  const tokens = tokenize(line);

  if (tokens.length === 0) {
    return undefined;
  }

  if (tokens[1] === "=") {
    const result = tokens[0] ?? "";

    return {
      result: result.slice(1),
      op: tokens[2] ?? "",
      operands: tokens.slice(3),
    };
  }

  return { result: undefined, op: tokens[0] ?? "", operands: tokens.slice(1) };
}

export class SpirvModule {
  instructions: Instruction[];

  private counter = 0;

  constructor(text: string) {
    this.instructions = [];

    for (const line of text.split("\n")) {
      const instruction = parseInstruction(line);

      if (instruction === undefined || debugOps.has(instruction.op)) {
        continue;
      }

      this.instructions.push(instruction);
    }
  }

  // A fresh id. spirv-as numbers named ids itself.
  fresh(prefix = "l"): string {
    this.counter++;

    return `${prefix}_${this.counter}`;
  }

  text(): string {
    return (
      this.instructions
        .map((instruction) => {
          const body = [instruction.op, ...instruction.operands].join(" ");

          return instruction.result === undefined ? body : `%${instruction.result} = ${body}`;
        })
        .join("\n") + "\n"
    );
  }

  definitions(): Map<string, Instruction> {
    const map = new Map<string, Instruction>();

    for (const instruction of this.instructions) {
      if (instruction.result !== undefined) {
        map.set(instruction.result, instruction);
      }
    }

    return map;
  }

  // Index of the first function: new global declarations go before it.
  firstFunction(): number {
    const index = this.instructions.findIndex((instruction) => instruction.op === "OpFunction");

    return index < 0 ? this.instructions.length : index;
  }

  // Index after the last decoration: new decorations go there.
  decorationEnd(): number {
    let last = -1;

    this.instructions.forEach((instruction, index) => {
      if (
        instruction.op.startsWith("OpDecorate") ||
        instruction.op.startsWith("OpMemberDecorate")
      ) {
        last = index;
      }
    });

    if (last >= 0) {
      return last + 1;
    }

    return this.instructions.findIndex((instruction) => instruction.op.startsWith("OpType"));
  }

  // Orders the global declarations so every id is defined before its use.
  // Passes append declarations before the first function; a variable that an
  // earlier declaration names may then follow its user.
  sortGlobals(): void {
    const start = this.decorationEnd();
    const end = this.firstFunction();
    const globals = this.instructions.slice(start, end);
    const defined = new Map<string, Instruction>();

    for (const instruction of globals) {
      if (instruction.result !== undefined) {
        defined.set(instruction.result, instruction);
      }
    }

    const placed = new Set<Instruction>();
    const ordered: Instruction[] = [];
    const visit = (instruction: Instruction, depth: number) => {
      if (placed.has(instruction) || depth > 10000) {
        return;
      }

      placed.add(instruction);

      for (const operand of instruction.operands) {
        const dependency = operand.startsWith("%") ? defined.get(operand.slice(1)) : undefined;

        if (dependency !== undefined) {
          visit(dependency, depth + 1);
        }
      }

      ordered.push(instruction);
    };

    globals.forEach((instruction) => visit(instruction, 0));
    this.instructions.splice(start, end - start, ...ordered);
  }

  // Drops types, constants and variables nothing refers to, with their
  // decorations. Lowering leaves the original block types behind, and naga
  // validates every type even when no variable uses it.
  removeUnusedGlobals(): void {
    for (;;) {
      const start = this.decorationEnd();
      const end = this.firstFunction();
      const used = new Set<string>();

      this.instructions.forEach((instruction, index) => {
        const decoration = instruction.op === "OpDecorate" || instruction.op === "OpMemberDecorate";

        if (decoration) {
          return;
        }

        if (index >= start && index < end && instruction.result !== undefined) {
          // A global's own operands count as uses only if it is itself used,
          // which the next iteration settles.
        }

        for (const operand of instruction.operands) {
          if (operand.startsWith("%")) {
            used.add(operand.slice(1));
          }
        }
      });

      const removable = new Set<string>();

      for (let index = start; index < end; index++) {
        const instruction = this.instructions[index];

        if (instruction?.result !== undefined && !used.has(instruction.result)) {
          removable.add(instruction.result);
        }
      }

      if (removable.size === 0) {
        return;
      }

      this.instructions = this.instructions.filter((instruction) => {
        if (instruction.result !== undefined && removable.has(instruction.result)) {
          return false;
        }

        const decoration = instruction.op === "OpDecorate" || instruction.op === "OpMemberDecorate";

        return !(decoration && removable.has((instruction.operands[0] ?? "").slice(1)));
      });
    }
  }

  insertGlobals(instructions: Instruction[]): void {
    this.instructions.splice(this.firstFunction(), 0, ...instructions);
  }

  insertDecorations(instructions: Instruction[]): void {
    this.instructions.splice(this.decorationEnd(), 0, ...instructions);
  }

  // Finds a type or constant with these exact operands, or declares it.
  declare(op: string, operands: string[]): string {
    const key = operands.join(" ");

    for (const instruction of this.instructions) {
      if (instruction.op === op && instruction.operands.join(" ") === key) {
        return instruction.result ?? "";
      }
    }

    const result = this.fresh(op === "OpConstant" ? "c" : "t");

    this.insertGlobals([{ result, op, operands }]);

    return result;
  }

  // Replaces every use of the ids in `map` (keys and values without `%`).
  substitute(map: Map<string, string>): void {
    if (map.size === 0) {
      return;
    }

    for (const instruction of this.instructions) {
      instruction.operands = instruction.operands.map((operand) => {
        if (!operand.startsWith("%")) {
          return operand;
        }

        let id = operand.slice(1);

        while (map.has(id)) {
          id = map.get(id) ?? id;
        }

        return `%${id}`;
      });
    }
  }

  decorations(id: string): Instruction[] {
    return this.instructions.filter(
      (instruction) => instruction.op === "OpDecorate" && instruction.operands[0] === `%${id}`,
    );
  }

  decoration(id: string, name: string): string | undefined {
    const found = this.decorations(id).find((instruction) => instruction.operands[1] === name);

    return found?.operands[2];
  }

  memberDecoration(id: string, member: number, name: string): string | undefined {
    const found = this.instructions.find(
      (instruction) =>
        instruction.op === "OpMemberDecorate" &&
        instruction.operands[0] === `%${id}` &&
        instruction.operands[1] === String(member) &&
        instruction.operands[2] === name,
    );

    if (found === undefined) {
      return undefined;
    }

    return found.operands[3] ?? "";
  }
}

export function idOf(operand: string | undefined): string {
  if (operand === undefined || !operand.startsWith("%")) {
    throw new Error(`Expected an id operand, found ${String(operand)}`);
  }

  return operand.slice(1);
}
