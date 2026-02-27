import z from "zod"

export abstract class NamedError extends Error {
  abstract schema(): z.core.$ZodType
  abstract toObject(): { name: string; data: any }

  static create<Name extends string, Data extends z.core.$ZodType>(name: Name, data: Data) {
    const schema = z
      .object({
        name: z.literal(name),
        data,
      })
      .meta({ ref: name })

    const Result = class extends NamedError {
      public static readonly Schema = schema
      public override readonly name = name as Name

      constructor(
        public readonly data: z.input<Data>,
        options?: ErrorOptions,
      ) {
        super(name, options)
        this.name = name
      }

      static isInstance(input: any): input is InstanceType<typeof Result> {
        return typeof input === "object" && input !== null && "name" in input && (input as any).name === name
      }

      schema() {
        return schema
      }

      toObject() {
        return { name, data: this.data }
      }
    }

    Object.defineProperty(Result, "name", { value: name })
    return Result
  }
}
