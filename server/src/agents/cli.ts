const decoder = new TextDecoder();

export function hasCli(command: string): boolean {
  const proc = Bun.spawnSync(["which", command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0;
}

export function getCliVersion(command: string, args: string[] = ["--version"]): string | null {
  const proc = Bun.spawnSync([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return null;

  const stdout = decoder.decode(proc.stdout).trim();
  if (stdout) return stdout.split("\n")[0] ?? null;

  const stderr = decoder.decode(proc.stderr).trim();
  if (stderr) return stderr.split("\n")[0] ?? null;

  return null;
}
