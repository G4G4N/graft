import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { sha256 } from "./hash.js";

/**
 * Content-addressed, immutable blob storage. Blobs are written once and never change,
 * so any tier (server memory, node-local cache, HTTP cache) can cache them without coordination.
 */
export interface BlobStore {
  put(data: Buffer): string;
  get(hash: string): Buffer | null;
  has(hash: string): boolean;
}

/** Filesystem blob store: gzip-compressed files under <root>/ab/cd/<hash>. */
export class FsBlobStore implements BlobStore {
  private cache = new Map<string, Buffer>();
  private cacheBytes = 0;

  constructor(private root: string, private maxCacheBytes = 64 * 1024 * 1024) {
    mkdirSync(root, { recursive: true });
  }

  private pathFor(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  put(data: Buffer): string {
    const hash = sha256(data);
    if (this.has(hash)) return hash;
    const p = this.pathFor(hash);
    mkdirSync(join(this.root, hash.slice(0, 2), hash.slice(2, 4)), { recursive: true });
    const tmp = p + "." + randomBytes(6).toString("hex") + ".tmp";
    writeFileSync(tmp, gzipSync(data, { level: 6 }));
    renameSync(tmp, p); // atomic publish
    this.remember(hash, data);
    return hash;
  }

  get(hash: string): Buffer | null {
    const hit = this.cache.get(hash);
    if (hit) {
      // refresh LRU position
      this.cache.delete(hash);
      this.cache.set(hash, hit);
      return hit;
    }
    const p = this.pathFor(hash);
    if (!existsSync(p)) return null;
    const data = gunzipSync(readFileSync(p));
    this.remember(hash, data);
    return data;
  }

  has(hash: string): boolean {
    return this.cache.has(hash) || existsSync(this.pathFor(hash));
  }

  private remember(hash: string, data: Buffer) {
    if (data.length > this.maxCacheBytes / 8) return;
    this.cache.set(hash, data);
    this.cacheBytes += data.length;
    while (this.cacheBytes > this.maxCacheBytes) {
      const [k, v] = this.cache.entries().next().value as [string, Buffer];
      this.cache.delete(k);
      this.cacheBytes -= v.length;
    }
  }
}

/** In-memory blob store (tests). */
export class MemoryBlobStore implements BlobStore {
  private m = new Map<string, Buffer>();
  put(data: Buffer) {
    const h = sha256(data);
    this.m.set(h, data);
    return h;
  }
  get(hash: string) {
    return this.m.get(hash) ?? null;
  }
  has(hash: string) {
    return this.m.has(hash);
  }
}
