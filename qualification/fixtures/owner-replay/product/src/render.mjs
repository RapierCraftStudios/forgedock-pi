import { displayName, profileId } from "./profile.mjs";

export function renderProfile(profile) {
  return `${profileId(profile)}:${displayName(profile)}`;
}
