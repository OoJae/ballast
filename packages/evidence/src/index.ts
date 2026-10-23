export {
  COMPRESSED,
  type CompressedEntry,
  compressSegment,
  type Digest,
  digestFile,
} from "./compress.js";
export { merkleRoot, merkleRootHex } from "./merkle.js";
export {
  chainHash,
  hourKey,
  MANIFEST,
  type ManifestEntry,
  ROOTS,
  type RootEntry,
  SegmentWriter,
  type SegmentWriterOptions,
  segmentRelPath,
} from "./segments.js";
export { type VerifyReport, verifyRecordings } from "./verify.js";
// The SQLite store, CIP-20 anchoring and bundle export load a native addon and a wasm module,
// so they live behind subpaths ("@ballast/evidence/db", "/anchor", "/bundle"). The recorder's
// import of this entry point stays as light as it was.
