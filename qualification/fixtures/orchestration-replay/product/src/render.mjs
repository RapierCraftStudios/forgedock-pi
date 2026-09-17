import { normalizeDisplayName, profileId } from "./profile.mjs";

export function renderProfile(profile) {
  return `${profileId(profile)}:${normalizeDisplayName(profile.name)}`;
}
