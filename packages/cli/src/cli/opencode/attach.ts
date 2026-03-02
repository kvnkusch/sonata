export async function attachOpencodeTui(input: {
  projectRoot: string
  baseUrl: string
  sessionId: string
  env: Record<string, string>
}): Promise<void> {
  const proc = Bun.spawn(["opencode", "attach", input.baseUrl, "--dir", input.projectRoot, "--session", input.sessionId], {
    stdio: ["inherit", "inherit", "inherit"],
    env: {
      ...process.env,
      ...input.env,
    },
  })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`opencode attach exited with code ${code}`)
  }
}
