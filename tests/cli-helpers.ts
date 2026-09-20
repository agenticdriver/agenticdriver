import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
export class CliProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly finished: Promise<CliResult>;
  stdout = "";
  stderr = "";
  private exited = false;
  private updates = new Set<() => void>();
  constructor(
    entry: string[],
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
  ) {
    this.child = spawn(process.execPath, [...entry, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      shell: false,
    });
    // A test watchdog, never a host/model run deadline.
    const watchdog = setTimeout(() => this.child.kill("SIGKILL"), 20_000);
    watchdog.unref();
    for (const name of ["stdout", "stderr"] as const) {
      this.child[name].setEncoding("utf8");
      this.child[name].on("data", (data: string) => {
        this[name] += data;
        if (this[name].length > 2_000_000) this.child.kill("SIGKILL");
        for (const update of this.updates) update();
      });
    }
    this.finished = new Promise((resolve, reject) => {
      this.child.once("error", (error) => {
        clearTimeout(watchdog);
        this.exited = true;
        reject(error);
      });
      this.child.once("close", (code, signal) => {
        clearTimeout(watchdog);
        this.exited = true;
        resolve({ code, signal, stdout: this.stdout, stderr: this.stderr });
        for (const update of this.updates) update();
      });
    });
    this.child.stdin.on("error", () => {});
    this.child.stdin.end(options.input ?? "");
  }
  waitFor<T>(read: (output: string) => T | undefined): Promise<T> {
    return new Promise((resolve, reject) => {
      const update = () => {
        const value = read(this.stdout);
        if (value !== undefined) {
          this.updates.delete(update);
          resolve(value);
        } else if (this.exited) {
          this.updates.delete(update);
          reject(new Error("The CLI exited before the expected output."));
        }
      };
      this.updates.add(update);
      update();
    });
  }
  listening(): Promise<string> {
    return this.waitFor((output) => {
      for (const line of output.split("\n").slice(0, -1)) {
        const event = JSON.parse(line) as { event?: string; url?: string };
        if (event.event === "listening") return event.url;
      }
      return undefined;
    });
  }
  async stop() {
    if (!this.exited) this.child.kill("SIGTERM");
    return this.finished;
  }
}
