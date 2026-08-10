# Asset archive ingestion boundary — 2026-08-10

Issue: [#377](https://github.com/zajalist/hayba/issues/377)

## Outcome

Marketplace ZIPs no longer enter `adm-zip` or an eager `extractAllTo` path.
AmbientCG and Sketchfab now cross one fail-closed boundary:

`bounded download -> complete lazy metadata preflight -> private streamed extraction -> atomic promotion -> UE import`

The import continuation is structurally after all four filesystem stages. Any
download, metadata, path, inflation, checksum, deadline, or promotion rejection
deletes the request-owned cache and cannot call `python_run`.

Poly Haven does not consume archives, but now shares the bounded downloader,
uses a unique request cache, rejects provider-supplied unsafe/colliding leaf
names, and deletes a partial request cache if any file fails.

## Non-disableable ceilings

Defaults are centralized in `DEFAULT_ARCHIVE_LIMITS`. A caller may lower them;
zero, negative, fractional, non-finite, or unsafe-integer values are rejected.

| Boundary | Default |
|---|---:|
| compressed download/archive | 512 MiB |
| download deadline | 120 s |
| provider lookup metadata | 8 MiB |
| provider lookup deadline | 30 s |
| validation + extraction deadline | 120 s |
| central directory | 16 MiB |
| entries | 4,096 |
| filename | 1,024 UTF-8 bytes |
| extra field | 4,096 bytes per entry |
| path depth | 32 components |
| compressed bytes per entry | 512 MiB |
| uncompressed bytes per entry | 256 MiB |
| total uncompressed bytes | 2 GiB |
| compression ratio | 200:1 |

Download size is enforced once from `Content-Length` when present and again on
the actual response stream. Both download and extraction deadlines abort their
active pipelines and remove private staging directories. Provider lookup JSON
is also decoded only after a bounded stream completes; invalid UTF-8/JSON and
network errors never echo response bodies, signed URLs, or authorization data.

## ZIP policy

The parser reads the EOCD and central directory with bounded positional reads;
declared entry sizes never drive allocation. It accepts only single-disk,
non-ZIP64, unencrypted stored/deflated regular files and directories. It rejects:

- absolute, drive, UNC, device, ADS, NUL, control, Win32-invalid, dot,
  traversal, backslash, trailing-dot/space, reserved-device, non-NFC, and
  compatibility-normalizing names;
- filename/depth/metadata, entry-count, entry-size, total-size, ratio, and
  wall-clock overruns;
- symlink, special-file, reparse, NTFS, and ASi Unix metadata; extraction only
  creates new regular files/directories, so no hardlink primitive exists;
- duplicate normalized names, case collisions, file/directory collisions,
  duplicate local offsets, overlapping local records, and local/central
  metadata disagreement;
- unsupported compression, empty/directory-only archives, malformed extra
  fields, truncation, inflated-size mismatch, and CRC mismatch.

All entries are planned before the first output byte. Each file is opened with
exclusive creation inside a private `mkdtemp` root. Every resolved destination
must remain under that root, and each existing parent is rechecked as a real
directory rather than a link. The final destination is never opened for write
and is not replaced if already present.

## Path-replacement / TOCTOU posture

Preflight and extraction use one open read-only file handle. Entry streams use
positional reads from that handle rather than reopening the archive pathname,
so renaming or replacing the path after inspection cannot substitute different
bytes. The immutable plan still enforces output byte limits and CRC on every
entry, failing closed if the underlying file is concurrently corrupted.

## Deterministic proof

`secure-archive.test.ts` builds ZIP bytes directly, without the production
parser or `adm-zip`, and covers:

- valid stored/deflated/empty files and CRC verification;
- declared 4 GB size, ratio bomb, entry flood, per-entry and total size,
  filename and depth ceilings;
- zip slip, backslash traversal, absolute/drive/device/ADS paths, reserved and
  trailing-dot/space names;
- symlink/reparse metadata, duplicate/case/file-parent collisions, overlapping
  publication targets, truncation, and an inflation-time CRC failure after an
  earlier file was staged;
- response-stream overrun, stalled-response deadline, extraction deadline,
  existing download/extraction targets, and private-root cleanup;
- zero UE-import continuation calls after both archive rejection and download
  rejection.

The production dependency manifest is intentionally outside this change because
#380 owns dependency updates. Once that change removes direct `adm-zip`, only
the separately assessed optional ONNX installation path may remain in the
lockfile; there is no Hayba runtime import or use of `adm-zip` after #377.
