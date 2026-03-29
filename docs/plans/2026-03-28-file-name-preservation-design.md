# File Name Preservation Design

## Goal

Keep uploaded and returned files as close as possible to the user-visible original file name, while still avoiding collisions safely.

## Decisions

1. Incoming Discord attachments should preserve the original attachment name after minimal filesystem-safe sanitization.
2. If the destination path already exists, the bridge should insert a short random suffix before the extension, for example `report-a1b2c3d4.pdf`.
3. This collision rule applies both to the bridge cache directory and the bound workspace `inbox/`.
4. Outgoing files sent back to Discord should keep the selected file's basename exactly as stored on disk; the bridge should not invent a different display name.
5. Filename sanitization should stop erasing valid spaces and Unicode characters. It should only normalize obviously unsafe path characters such as separators, traversal markers, and control characters.

## Scope

- `src/attachments.ts`
- `src/fileTransfer.ts`
- `src/utils.ts`
- tests covering attachment download and outbound file naming

## Non-Goals

- No change to file search ranking
- No change to admin-only absolute path rules
- No change to attachment size limits
