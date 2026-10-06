# Display boundary decision (disposable qualification contract v2)

This contract applies only to this disposable qualification fixture. It is not an AlterLab or product decision.

The presentation boundary owns display-name normalization: trim surrounding whitespace and use lowercase display text. Stored profile identifiers and the source profile object remain unchanged.

`profile.teamLabel` is an optional input. A supplied nonempty string is included verbatim as the third colon-separated segment in `renderProfile`'s existing string output. If `teamLabel` is absent, keep the existing two-segment output. Do not add a dependency for this behavior.

Examples:

- `{ id: "User-7", name: "  ALICE  ", teamLabel: "Platform" }` → `"User-7:alice:Platform"`
- `{ id: "User-7", name: "  ALICE  " }` → `"User-7:alice"`

The two-issue workflow keeps #101 as the normalization prerequisite and #102 as its real consumer integration successor.
