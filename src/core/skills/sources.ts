import { isAbsolute } from 'node:path';

export interface ParsedSkillInstallSource {
  kind: 'local' | 'git' | 'github';
  value: string;
  github?: { owner: string; repo: string; path?: string; ref?: string };
}

function parseMaybeUrl(raw: string): URL | null {
  try {
    return new URL(raw.replace(/^git\+/, ''));
  } catch {
    return null;
  }
}

export function redactGitUrlCredentials(raw: string): string {
  const url = parseMaybeUrl(raw);
  if (!url) return raw;
  if (!url.username && !url.password) return raw;
  url.username = url.username ? '***' : '';
  url.password = url.password ? '***' : '';
  const redacted = url.toString();
  return raw.startsWith('git+') ? `git+${redacted}` : redacted;
}

export function assertNoGitUrlCredentials(raw: string): void {
  const url = parseMaybeUrl(raw);
  if (!url) return;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.username || url.password)) {
    throw new Error('git_url_credentials_not_allowed');
  }
}

export function assertSafeGitSkillPath(path: string): void {
  if (!path || path.includes('\0')) throw new Error('invalid_git_skill_path');
  if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) throw new Error('invalid_git_skill_path');
  if (path.split(/[\\/]+/).filter(Boolean).includes('..')) throw new Error('invalid_git_skill_path');
}

function decodeUrlPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new Error('invalid_github_skill_source');
  }
}

function hasRawPathTraversal(raw: string): boolean {
  return /(?:^|[\\/])(?:\.\.|%2e%2e)(?=$|[\\/#?])/i.test(raw);
}

function parseGitHubBrowserUrl(raw: string): ParsedSkillInstallSource | null {
  const url = parseMaybeUrl(raw);
  if (!url) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
  if (hasRawPathTraversal(raw)) throw new Error('invalid_git_skill_path');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeUrlPart);
  if (parts.length < 2) throw new Error('invalid_github_skill_source');
  const [owner, repoWithSuffix] = parts;
  const repo = repoWithSuffix.endsWith('.git') ? repoWithSuffix.slice(0, -'.git'.length) : repoWithSuffix;
  if (!owner || !repo) throw new Error('invalid_github_skill_source');
  let ref: string | undefined;
  let path: string | undefined;
  if (parts[2] === 'tree' || parts[2] === 'blob') {
    const rest = parts.slice(3);
    if (rest.length === 0) throw new Error('invalid_github_skill_source');
    const skillsIndex = rest.indexOf('skills');
    if (skillsIndex > 0) {
      ref = rest.slice(0, skillsIndex).join('/');
      path = rest.slice(skillsIndex).join('/');
    } else {
      ref = rest[0];
      path = rest.slice(1).join('/') || undefined;
    }
    const pathParts = path?.split('/');
    if (parts[2] === 'blob' && pathParts?.[pathParts.length - 1]?.toLowerCase() === 'skill.md') {
      path = pathParts.slice(0, -1).join('/') || undefined;
    }
  }
  if (path) assertSafeGitSkillPath(path);
  return {
    kind: 'github',
    value: raw,
    github: { owner, repo, ...(path ? { path } : {}), ...(ref ? { ref } : {}) },
  };
}

export function parseSkillInstallSource(raw: string): ParsedSkillInstallSource {
  if (raw.startsWith('github:')) {
    const rest = raw.slice('github:'.length);
    const parts = rest.split('/').filter(Boolean);
    if (parts.length < 2) throw new Error('invalid_github_skill_source');
    const path = parts.slice(2).join('/') || undefined;
    if (path) assertSafeGitSkillPath(path);
    return {
      kind: 'github',
      value: raw,
      github: { owner: parts[0], repo: parts[1], path },
    };
  }
  assertNoGitUrlCredentials(raw);
  const githubSource = parseGitHubBrowserUrl(raw);
  if (githubSource) return githubSource;
  if (raw.startsWith('git+') || raw.endsWith('.git') || raw.startsWith('git@')) {
    return { kind: 'git', value: raw.replace(/^git\+/, '') };
  }
  return { kind: 'local', value: raw };
}

export function githubToGitUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}
