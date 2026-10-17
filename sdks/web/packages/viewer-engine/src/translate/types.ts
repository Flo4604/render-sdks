// Type and layout queries over a SPIR-V text module, used by the lowering
// passes to compute byte offsets inside explicitly laid out blocks.

import { idOf, type Instruction, type SpirvModule } from "./spirv-text.ts";

export type SpirvType =
  | { kind: "void" }
  | { kind: "bool" }
  | { kind: "int"; width: number; signed: boolean }
  | { kind: "float"; width: number }
  | { kind: "vector"; component: string; count: number }
  | { kind: "matrix"; column: string; count: number }
  | { kind: "array"; element: string; length: number; stride: number | undefined }
  | { kind: "runtimeArray"; element: string; stride: number | undefined }
  | { kind: "struct"; members: string[] }
  | { kind: "pointer"; storage: string; pointee: string }
  | { kind: "image"; instruction: Instruction }
  | { kind: "sampler" }
  | { kind: "sampledImage"; image: string }
  | { kind: "other"; op: string };

export class TypeTable {
  private readonly module: SpirvModule;

  private definitions: Map<string, Instruction>;

  constructor(module: SpirvModule) {
    this.module = module;
    this.definitions = module.definitions();
  }

  refresh(): void {
    this.definitions = this.module.definitions();
  }

  // Types and constants declared after construction are found on a miss.
  definition(id: string): Instruction | undefined {
    const found = this.definitions.get(id);

    if (found !== undefined) {
      return found;
    }

    this.refresh();

    return this.definitions.get(id);
  }

  constantValue(id: string): number | undefined {
    const instruction = this.definition(id);

    if (instruction?.op !== "OpConstant") {
      return undefined;
    }

    const value = Number(instruction.operands[1]);

    return Number.isFinite(value) ? value : undefined;
  }

  type(id: string): SpirvType {
    const instruction = this.definition(id);

    if (instruction === undefined) {
      throw new Error(`Unknown type %${id}`);
    }

    const operands = instruction.operands;

    switch (instruction.op) {
      case "OpTypeVoid": {
        return { kind: "void" };
      }

      case "OpTypeBool": {
        return { kind: "bool" };
      }

      case "OpTypeInt": {
        return { kind: "int", width: Number(operands[0]), signed: operands[1] === "1" };
      }

      case "OpTypeFloat": {
        return { kind: "float", width: Number(operands[0]) };
      }

      case "OpTypeVector": {
        return { kind: "vector", component: idOf(operands[0]), count: Number(operands[1]) };
      }

      case "OpTypeMatrix": {
        return { kind: "matrix", column: idOf(operands[0]), count: Number(operands[1]) };
      }

      case "OpTypeArray": {
        const length = this.constantValue(idOf(operands[1]));

        if (length === undefined) {
          throw new Error(`Array %${id} has a non-constant length`);
        }

        return {
          kind: "array",
          element: idOf(operands[0]),
          length,
          stride: this.stride(id),
        };
      }

      case "OpTypeRuntimeArray": {
        return { kind: "runtimeArray", element: idOf(operands[0]), stride: this.stride(id) };
      }

      case "OpTypeStruct": {
        return { kind: "struct", members: operands.map(idOf) };
      }

      case "OpTypePointer": {
        return { kind: "pointer", storage: operands[0] ?? "", pointee: idOf(operands[1]) };
      }

      case "OpTypeImage": {
        return { kind: "image", instruction };
      }

      case "OpTypeSampler": {
        return { kind: "sampler" };
      }

      case "OpTypeSampledImage": {
        return { kind: "sampledImage", image: idOf(operands[0]) };
      }

      default: {
        return { kind: "other", op: instruction.op };
      }
    }
  }

  private stride(id: string): number | undefined {
    const value = this.module.decoration(id, "ArrayStride");

    return value === undefined ? undefined : Number(value);
  }

  memberOffset(struct: string, member: number): number {
    const value = this.module.memberDecoration(struct, member, "Offset");

    if (value === undefined) {
      throw new Error(`Struct %${struct} member ${member} has no Offset`);
    }

    return Number(value);
  }

  // How a member matrix is stored: its stride and whether rows are contiguous.
  matrixLayout(struct: string, member: number): { stride: number; rowMajor: boolean } {
    const stride = this.module.memberDecoration(struct, member, "MatrixStride");
    const rowMajor = this.module.memberDecoration(struct, member, "RowMajor") !== undefined;

    return { stride: stride === undefined ? 16 : Number(stride), rowMajor };
  }

  // Bytes a value of this type covers in an explicit layout.
  byteSize(id: string, matrix?: { stride: number; rowMajor: boolean }): number {
    const type = this.type(id);

    switch (type.kind) {
      case "int":
      case "float": {
        return type.width / 8;
      }

      case "vector": {
        return this.byteSize(type.component) * type.count;
      }

      case "matrix": {
        const layout = matrix ?? { stride: 16, rowMajor: false };
        const column = this.type(type.column);
        const rows = column.kind === "vector" ? column.count : 1;

        if (layout.rowMajor) {
          return layout.stride * (rows - 1) + 4 * type.count;
        }

        return layout.stride * (type.count - 1) + 4 * rows;
      }

      case "array": {
        const stride = type.stride ?? this.byteSize(type.element);

        return stride * (type.length - 1) + this.byteSize(type.element, matrix);
      }

      case "runtimeArray": {
        return 0;
      }

      case "struct": {
        let size = 0;

        type.members.forEach((member, index) => {
          const layout = this.matrixLayout(id, index);
          size = Math.max(size, this.memberOffset(id, index) + this.byteSize(member, layout));
        });

        return size;
      }

      default: {
        throw new Error(`Type %${id} (${type.kind}) has no explicit layout size`);
      }
    }
  }

  // The result type id of an instruction, or undefined.
  resultType(instruction: Instruction): string | undefined {
    const first = instruction.operands[0];

    if (first === undefined || !first.startsWith("%") || instruction.result === undefined) {
      return undefined;
    }

    if (instruction.op.startsWith("OpType") || instruction.op === "OpExtInstImport") {
      return undefined;
    }

    return first.slice(1);
  }
}
