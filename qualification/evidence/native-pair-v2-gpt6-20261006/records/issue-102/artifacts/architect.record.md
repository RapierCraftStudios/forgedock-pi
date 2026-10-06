<!-- FORGE:ARCHITECT -->
<!-- FORGE:RECORD {"v":1,"record_id":"sha256:aa991acbe3faf278ad5e9f8914e681debb33fe6f511561a9c9b639ccdacd907a","source_head":"713aced2e0e5efef105dbc379bc1687d8c65414c","inputs":[],"supersedes":null,"execution":{"repository":"example/product","issue":102,"target":"integration","model":"openai-codex/gpt-6-luna","remediation_limit":1}} -->
## Implementation Plan

**Issue**: [example/product#102](https://github.com/example/product/issues/102)
**Source head**: `713aced2e0e5efef105dbc379bc1687d8c65414c`
**Inputs**: none
**Supersedes**: none

# ARCHITECT — Issue #102

Use the existing profile-rendering composition: retain `profileId(profile)` for identifiers and `normalizeDisplayName(profile.name)` for the producer-normalized name, then conditionally append `:${profile.teamLabel}` only for a supplied nonempty string. Copy the label byte-for-byte as a JavaScript string (no trim, case conversion, or mutation). Keep the current two-segment form when no nonempty label is present. The existing real-consumer test should continue proving the omitted-label and normalized-name cases, and should prove the optional verbatim label and that the input object remains unchanged. Add no dependency and do not modify #101 producer code.
