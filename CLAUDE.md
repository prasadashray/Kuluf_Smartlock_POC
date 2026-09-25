# IndiaLock Connect - Agent Instructions

> This is the repository's standing instruction file (auto-loaded by Claude Code). New agent? Read
> `docs/AGENT_START_HERE.md` next. Verify every claim against the code, tests and logs — see "Source of Truth".

## Project Rule

This is an IoT electronic-lock integration project.

The objective of Phase 1 is a working POC connecting the actual physical lock to our platform.

The POC is intended to become the foundation for subsequent full-stack development.

## Source of Truth

When determining project status, use this priority:

1. Actual source code
2. Automated tests
3. Runtime logs/evidence
4. Technical documentation
5. Project state documents
6. Previous conversation history

Never assume conversation history is available.

## Required Reading

Before making architectural or protocol changes, read:

- docs/AGENT_START_HERE.md
- docs/PROJECT_STATE.md
- docs/PROTOCOL_NOTES.md
- docs/DECISIONS.md
- docs/NEXT_STEPS.md

Also inspect:

- Technical Docs/TDD_IndiaLock_Connect.pdf
- Technical Docs/TT808_ELOCK_Protocol_English.pdf
- Technical Docs/TT808通讯协议扩展版(完整)A13_ELOCK.pdf

## Protocol Authority

The TT808/ELOCK technical documents are the primary authority for protocol behavior.

Never invent protocol fields, message IDs, byte layouts, checksums, escaping rules or device behavior.

When uncertain, mark the item UNKNOWN or REQUIRES VENDOR CONFIRMATION.

## Development Principle

Build a reusable foundation, not disposable POC code.

However, do not prematurely build production features that are outside the current POC.

## Hardware Safety

The physical lock is real hardware.

Do not perform destructive, irreversible or potentially damaging operations without appropriate confirmation.

## Evidence

Every hardware/protocol discovery should be recorded.

Prefer:

CONFIRMED
INFERRED
UNKNOWN
HARDWARE-SPECIFIC
REQUIRES VENDOR CONFIRMATION
REQUIRES HARDWARE TEST

## Before Changing Architecture

Explain:
- current architecture
- proposed change
- evidence requiring the change
- alternatives
- impact

Do not change architecture merely because another technology appears attractive.
