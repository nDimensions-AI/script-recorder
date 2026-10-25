import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  lstatSync,
  existsSync,
  openSync,
  readSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { canonical, id } from "../../common/webinar/schema";

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export const digest = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
export const stableId = (v: unknown) => {
  const h = digest(v);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const bytesHash = (v: Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
export function fileHash(filename: string) {
  const hash = createHash("sha256"),
    fd = openSync(filename, "r"),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      hash.update(buffer.subarray(0, n));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
export function assert(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
export type Row = Record<string, any>;
export class Db {
  db: DatabaseSync;
  constructor(
    public filename: string,
    schema?: string,
  ) {
    this.db = new DatabaseSync(filename);
    const version = (this.db.prepare("PRAGMA user_version").get() as Row)
      .user_version;
    if (version > 1) {
      this.db.close();
      throw new DomainError(
        "VALIDATION",
        "This project needs a newer application version.",
      );
    }
    if (version === 1 && schema) {
      const migration = this.db
        .prepare("SELECT checksum FROM schema_migrations WHERE version=1")
        .get() as Row | undefined;
      if (migration?.checksum !== bytesHash(Buffer.from(schema))) {
        this.db.close();
        throw new DomainError(
          "VALIDATION",
          "Project schema checksum does not match this application.",
        );
      }
    }
    this.db.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    if (!version && schema) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // WAL and synchronous have already been configured outside the transaction.
        this.db.exec(schema.replace(/^PRAGMA .*;$/gm, ""));
        this.db.exec("PRAGMA user_version=1");
        this.db
          .prepare("INSERT INTO schema_migrations VALUES(1,?,?)")
          .run(bytesHash(Buffer.from(schema)), now());
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        this.db.close();
        throw e;
      }
    }
  }
  get(sql: string, ...args: SQLInputValue[]): Row | undefined {
    const row = this.db.prepare(sql).get(...args);
    return row ? { ...row } : undefined;
  }
  all(sql: string, ...args: SQLInputValue[]): Row[] {
    return this.db
      .prepare(sql)
      .all(...args)
      .map((row) => ({ ...row }));
  }
  run(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args);
  }
  tx<T>(fn: () => T): T {
    const nested = this.db.isTransaction,
      savepoint = "sp_" + uid().replaceAll("-", "");
    this.db.exec(nested ? "SAVEPOINT " + savepoint : "BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec(nested ? "RELEASE " + savepoint : "COMMIT");
      return v;
    } catch (e) {
      this.db.exec(nested ? "ROLLBACK TO " + savepoint : "ROLLBACK");
      if (nested) this.db.exec("RELEASE " + savepoint);
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
export function safeId(value: unknown): string {
  return id.parse(value);
}
export function contained(root: string, relative: string): string {
  assert(
    !path.isAbsolute(relative),
    "FORBIDDEN",
    "Absolute asset paths are forbidden.",
  );
  const resolved = path.resolve(root, relative),
    base = realpathSync(root);
  const rel = path.relative(base, resolved);
  assert(
    rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel),
    "FORBIDDEN",
    "Asset escapes project.",
  );
  let cursor = base;
  for (const part of rel.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (existsSync(cursor)) {
      assert(
        !lstatSync(cursor).isSymbolicLink(),
        "FORBIDDEN",
        "Linked project paths are unsupported.",
      );
      const actual = realpathSync(cursor),
        r = path.relative(base, actual);
      assert(
        !r.startsWith("..") && !path.isAbsolute(r),
        "FORBIDDEN",
        "Asset escapes project.",
      );
    }
  }
  return resolved;
}
export function atomicFile(filename: string, bytes: Uint8Array): void {
  mkdirSync(path.dirname(filename), { recursive: true });
  const tmp = filename + "." + uid() + ".tmp";
  const fd = openSync(tmp, "wx", 0o600);
  try {
    let n = 0;
    while (n < bytes.byteLength)
      n += writeSync(fd, bytes, n, bytes.byteLength - n);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filename);
}
export function readJson<T>(filename: string): T {
  return JSON.parse(readFileSync(filename, "utf8"));
}
