import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface LeaseOwner {
  token: string;
  pid: number;
  label: string;
  threadId: string;
  acquiredAt: string;
}

function leaseDirectoryName(threadId: string): string {
  return createHash("sha256").update(threadId).digest("hex");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Atomic filesystem leases prevent Stable and Nightly from owning one thread at once. */
export class SharedThreadLeaseManager {
  private readonly token = randomUUID();
  private readonly owned = new Map<string, string>();

  constructor(
    private readonly rootDir = process.env.PORACODE_SHARED_THREAD_LEASES_DIR?.trim(),
    private readonly label = process.env.PORACODE_CHANNEL?.trim() || "Poracode",
  ) {}

  acquire(threadId: string): void {
    if (!this.rootDir || this.owned.has(threadId)) return;
    mkdirSync(this.rootDir, { recursive: true });
    const leaseDir = join(this.rootDir, leaseDirectoryName(threadId));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        mkdirSync(leaseDir);
        const owner: LeaseOwner = {
          token: this.token,
          pid: process.pid,
          label: this.label,
          threadId,
          acquiredAt: new Date().toISOString(),
        };
        try {
          writeFileSync(join(leaseDir, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
        } catch (error) {
          rmSync(leaseDir, { recursive: true, force: true });
          throw error;
        }
        this.owned.set(threadId, leaseDir);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = this.readOwner(leaseDir);
        if (owner && processIsAlive(owner.pid)) {
          throw new Error(
            `This conversation is already open in ${owner.label}. Close it there before starting it here.`,
            { cause: error },
          );
        }
        // The winning process writes owner.json immediately after the atomic
        // mkdir. Treat a fresh owner-less directory as live instead of racing
        // to remove it between those two operations.
        if (!owner) {
          try {
            if (Date.now() - statSync(leaseDir).mtimeMs < 30_000) {
              throw new Error("This conversation is being opened in another Poracode app.", {
                cause: error,
              });
            }
          } catch (statError) {
            if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw statError;
          }
        }
        rmSync(leaseDir, { recursive: true, force: true });
      }
    }

    throw new Error("Unable to acquire the shared conversation lock.");
  }

  release(threadId: string): void {
    const leaseDir = this.owned.get(threadId);
    if (!leaseDir) return;
    this.owned.delete(threadId);
    const owner = this.readOwner(leaseDir);
    if (!owner || owner.token === this.token) {
      rmSync(leaseDir, { recursive: true, force: true });
    }
  }

  releaseAll(): void {
    for (const threadId of [...this.owned.keys()]) this.release(threadId);
  }

  private readOwner(leaseDir: string): LeaseOwner | null {
    try {
      return JSON.parse(readFileSync(join(leaseDir, "owner.json"), "utf8")) as LeaseOwner;
    } catch {
      return null;
    }
  }
}
