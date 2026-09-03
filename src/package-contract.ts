import { existsSync, readFileSync } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";

/** The five user-facing prompt-routed ForgeDock skills. */
export const FORGE_PUBLIC_SKILLS = Object.freeze([
  "forgedock-work-on",
  "forgedock-orchestrate",
  "forgedock-quality-gate",
  "forgedock-review-pr",
  "forgedock-review-pr-staging",
] as const);

export const FORGE_NESTED_SKILL_TRANSLATIONS = Object.freeze({
  "test-gate": "forgedock-test-gate",
  issue: "forgedock-issue",
} as const);

export interface ForgeSkillReference {
  from: string;
  requested: string;
  target: string;
  kind: "skill" | "spec";
}

export interface ForgeSkillResolution {
  references: readonly ForgeSkillReference[];
  missing: readonly ForgeSkillReference[];
}

/**
 * Resolve a nested reference without executing it. This intentionally only
 * checks package discoverability; active Pi-native prompt specs own routing and behavior.
 */
export function resolveForgeSkillReference(
  requested: string,
  packageRoot: string,
): { target: string; kind: "skill" | "spec" } | undefined {
  const name = requested.trim().replace(/^\//, "");
  if (
    !/^[a-z][a-z0-9_-]*(?::[a-z0-9_-]+)*(?:\/[a-z0-9_-]+)*$/.test(name) &&
    !/^forgedock-[a-z][a-z0-9_-]*(?::[a-z0-9_-]+)*(?:\/[a-z0-9_-]+)*$/.test(name)
  )
    return undefined;
  const translated =
    FORGE_NESTED_SKILL_TRANSLATIONS[name as keyof typeof FORGE_NESTED_SKILL_TRANSLATIONS];
  if (translated) {
    const target = join(packageRoot, "skills", translated, "SKILL.md");
    return existsSync(target) ? { target, kind: "skill" } : undefined;
  }

  const specName = name.startsWith("forgedock-")
    ? name.slice("forgedock-".length)
    : name;
  const commandPath = specName.replaceAll(":", "/");
  const candidates = [
    join(packageRoot, "specs", "original", "commands", `${commandPath}.md`),
    join(packageRoot, "specs", "original", "commands", commandPath, "SKILL.md"),
  ];
  const target = candidates.find((candidate) => existsSync(candidate));
  return target ? { target, kind: "spec" } : undefined;
}

/**
 * Walk the references reachable from the five public prompt skills. Every
 * reference must resolve either to a packaged translation or to the packaged
 * command tree. No phase is selected and no workflow is run here.
 */
export function resolveReachableForgeSkillReferences(
  packageRoot: string,
): ForgeSkillResolution {
  const root = resolve(packageRoot);
  const queue: Array<{
    from: string;
    requested: string;
    target: string;
    kind: "skill" | "spec";
  }> = [];
  for (const name of FORGE_PUBLIC_SKILLS) {
    const skillPath = join(root, "skills", name, "SKILL.md");
    queue.push({
      from: skillPath,
      requested: name.replace(/^forgedock-/, ""),
      target: skillPath,
      kind: "skill",
    });
    const resolved = resolveForgeSkillReference(name.replace(/^forgedock-/, ""), root);
    if (resolved) {
      queue.push({
        from: skillPath,
        requested: name.replace(/^forgedock-/, ""),
        target: resolved.target,
        kind: resolved.kind,
      });
    }
  }
  const references: ForgeSkillReference[] = [];
  const missing: ForgeSkillReference[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const reference: ForgeSkillReference = {
      from: relative(root, current.from),
      requested: current.requested,
      target: relative(root, current.target),
      kind: current.kind,
    };
    references.push(reference);
    if (!existsSync(current.target)) {
      missing.push(reference);
      continue;
    }
    const identity = normalize(current.target);
    if (visited.has(identity)) continue;
    visited.add(identity);
    const content = readFileSync(current.target, "utf8");
    for (const requested of extractSkillReferences(content)) {
      const resolved = resolveForgeSkillReference(requested, root);
      const child: ForgeSkillReference = {
        from: relative(root, current.target),
        requested,
        target: resolved ? relative(root, resolved.target) : "",
        kind: resolved?.kind ?? "spec",
      };
      references.push(child);
      if (!resolved) {
        missing.push(child);
      } else if (!visited.has(normalize(resolved.target))) {
        queue.push({
          from: current.target,
          requested,
          target: resolved.target,
          kind: resolved.kind,
        });
      }
    }
  }

  return { references, missing };
}

function extractSkillReferences(content: string): readonly string[] {
  const found = new Set<string>();
  // Support both the prose `Skill("name", ...)` form and the structured
  // `Skill(skill="name", ...)` form used by the original corpus.
  const pattern = /\bSkill\s*\(\s*(?:skill\s*=\s*)?["']([^"']+)["']/g;
  for (const match of content.matchAll(pattern)) {
    const name = match[1]?.trim();
    // Examples such as Skill("...") and Skill("subcommand") are prose
    // placeholders, not executable references.
    if (
      name &&
      name !== "subcommand" &&
      /^[a-z][a-z0-9_-]*(?::[a-z0-9_-]+)*(?:\/[a-z0-9_-]+)*$/.test(name)
    )
      found.add(name);
  }
  return [...found];
}
