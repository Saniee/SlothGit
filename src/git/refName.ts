// Branch name rules from `git check-ref-format --branch`, checked as you type instead of failing in git.

/** Why `name` can't be a branch name, or undefined when it can. */
export function branchNameError(name: string): string | undefined {
  if (!name) return 'Enter a branch name.';
  if (/\s/.test(name)) return 'Branch names cannot contain spaces.';
  if (/[\x00-\x1f\x7f~^:?*[\\]/.test(name)) return 'Branch names cannot contain ~ ^ : ? * [ or \\.';
  if (name.includes('..')) return 'Branch names cannot contain "..".';
  if (name.includes('@{')) return 'Branch names cannot contain "@{".';
  // git allows it, but "@" also means HEAD.
  if (name === '@') return '"@" means HEAD; pick another name.';
  if (name.startsWith('-')) return 'Branch names cannot start with "-".';
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'Branch names cannot start or end with "/", or contain "//".';
  if (name.endsWith('.')) return 'Branch names cannot end with ".".';
  if (name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) {
    return 'No part of a branch name can start with "." or end with ".lock".';
  }
  return undefined;
}
