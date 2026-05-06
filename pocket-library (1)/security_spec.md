# Security Specification for Pocket Library

## 1. Data Invariants
- **Identity Isolation**: All reading data (books, stats, bookmarks, annotations) is strictly partitioned by `userId`. A user can only access data if `request.auth.uid == userId`.
- **Relational Integrity**: Sub-resources (sessions, bookmarks, annotations) are only accessible through their parent `book` document.
- **Strict Schema**: Every write (create/update) must include all required fields with correct types.
- **Audit Trails**: `updatedAt` and `date` fields must use `request.time` to ensure temporal integrity.

## 2. The "Dirty Dozen" Payloads
These payloads attempt to bypass security logic and must be blocked by the rules.

1. **Identity Spoofing**: Create a book with `ownerId` set to a different user's UID.
2. **Resource Hijacking**: Attempt to `get` or `list` books from `/users/attacker_uid/books` where `attacker_uid` is not the current user.
3. **Ghost Update**: Update a book but inject a `verified: true` field that isn't in the schema.
4. **ID Poisoning**: Create a book with an ID containing malicious characters (e.g., `../../../etc/passwd`).
5. **Denial of Wallet**: Store a 1MB string in the `title` field of a book.
6. **Immutable Violation**: Attempt to change the `ownerId` of an existing book during an update.
7. **Orphaned Write**: Create a bookmark under a book ID that doesn't exist (using `exists()` on parent).
8. **Negative Stats**: Update `totalTime` or `pagesRead` with negative integers.
9. **Timestamp Spoofing**: Send a hardcoded date string for `updatedAt` instead of using `serverTimestamp()`.
10. **Shadow Session**: Add a reading session to a book owned by a different user.
11. **Annotation XSS**: Save an annotation containing `<script>` tags (schema should check size/content if possible, though rules mostly check size).
12. **Metadata Omission**: Update a book but remove the `chapters` array.

## 3. The Test Runner Plan
The `firestore.rules.test.ts` will verify:
- `get`/`list` on any `/users/{userId}` path fails if `userId != auth.uid`.
- `create` book fails if `ownerId != auth.uid`.
- `update` book fails if `ownerId` is changed.
- `create` bookmark fails if it's not under a book the user owns.
- All size constraints are enforced.
