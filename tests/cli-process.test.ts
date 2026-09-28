import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runProcess } from "../src/providers/cli-process.js";

// Descendants deliberately inherit both pipes and ignore SIGTERM. They do not
// detach from the process group: this tests cleanup, not hostile-code isolation.
const fixture = String.raw`
const {spawn} = require('node:child_process');
const mode = process.argv[1];
process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e',
  "process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000);"
], {stdio:['ignore', 1, 2, 'ipc']});
child.once('message', () => {
  process.stdout.write(JSON.stringify({parent:process.pid, child:child.pid})+'\n', () => {
    if(mode === 'exit') process.stdout.write('complete 🌍\n', () => process.exit(0));
    if(mode === 'error') process.stderr.write('private diagnostic\n', () => process.exit(7));
    if(mode === 'overflow') process.stdout.write('x'.repeat(2000001));
    if(mode === 'parse') process.stdout.write('invalid protocol\n');
  });
});
`;

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      // An orphan may briefly await init's waitpid; it cannot execute or hold pipes.
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
    }
    return true;
  } catch (error) {
    if (
      ["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return false;
    throw error;
  }
}

async function assertStopped(pids: number[]) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await Promise.all(pids.map(alive))).some(Boolean)) return;
    await delay(20);
  }
  assert.fail("A fixture process is still executing after CLI cleanup");
}

async function exercise(
  mode: string,
  inspect: (operation: Promise<string>, stop: AbortController) => Promise<void>,
  callbacks: {
    onReady?: (stop: AbortController) => void;
    onLine?: (line: string) => void;
    onExit?: (code: number | null) => void;
    classifyExit?: () => never;
  } = {},
) {
  const stop = new AbortController();
  const pids: number[] = [];
  let watchdogFired = false;
  // Test infrastructure only. runProcess receives no SDK run/idle deadline.
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    stop.abort();
  }, 5000);
  const operation = runProcess(process.execPath, ["-e", fixture, mode], {
    env: {},
    signal: stop.signal,
    onLine(line) {
      if (!pids.length) {
        const ready = JSON.parse(line);
        assert.ok(Number.isSafeInteger(ready.parent) && ready.parent > 1);
        assert.ok(Number.isSafeInteger(ready.child) && ready.child > 1);
        pids.push(ready.parent, ready.child);
        callbacks.onReady?.(stop);
      } else callbacks.onLine?.(line);
    },
    onExit: callbacks.onExit,
    classifyExit: callbacks.classifyExit,
  });
  try {
    await inspect(operation, stop);
    assert.equal(watchdogFired, false, "Fixture needed its watchdog to settle");
    assert.equal(pids.length, 2);
    await assertStopped(pids);
  } finally {
    clearTimeout(watchdog);
    stop.abort();
    // Only fixture-owned process identities; no broad process-name cleanup.
    for (const pid of pids) {
      if (await alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
    await operation.catch(() => {});
  }
}

const posix = { skip: process.platform === "win32" };

test(
  "a finished CLI reaps pipe-holding descendants and drains its final output",
  posix,
  async () => {
    let code: number | null | undefined;
    await exercise(
      "exit",
      async (operation, stop) => {
        assert.match(await operation, /complete 🌍\n$/);
        assert.equal(stop.signal.aborted, false);
      },
      {
        onExit: (value) => {
          code = value;
        },
      },
    );
    assert.equal(code, 0);
  },
);

test(
  "explicit cancellation reaps a SIGTERM-resistant process group",
  posix,
  async () => {
    await exercise(
      "wait",
      async (operation) => {
        await assert.rejects(operation, { code: "CANCELLED" });
      },
      { onReady: (stop) => stop.abort() },
    );
  },
);

test(
  "a failing CLI reaps descendants and keeps private stderr out of errors",
  posix,
  async () => {
    await exercise("error", async (operation) => {
      await assert.rejects(operation, (error: unknown) => {
        assert.equal((error as { code: string }).code, "CLI_FAILED");
        assert.ok(!String(error).includes("private diagnostic"));
        return true;
      });
    });
  },
);

test(
  "output overflow and parser failure each clean up the native process group",
  posix,
  async () => {
    await exercise("overflow", async (operation) => {
      await assert.rejects(operation, { code: "CLI_OUTPUT_LIMIT" });
    });
    const failure = new Error("fixture parser rejected the stream");
    await exercise(
      "parse",
      async (operation) => {
        await assert.rejects(operation, (error: unknown) => error === failure);
      },
      {
        onLine: () => {
          throw failure;
        },
      },
    );
  },
);

test(
  "exit and diagnostic callback exceptions reject after native cleanup",
  posix,
  async () => {
    const failure = new Error("fixture callback failed");
    await exercise(
      "exit",
      async (operation) => {
        await assert.rejects(operation, (error: unknown) => error === failure);
      },
      {
        onExit: () => {
          throw failure;
        },
      },
    );
    await exercise(
      "error",
      async (operation) => {
        await assert.rejects(operation, (error: unknown) => error === failure);
      },
      {
        classifyExit: () => {
          throw failure;
        },
      },
    );
  },
);
