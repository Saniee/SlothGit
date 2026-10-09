// Web URLs for commits and pull requests on common Git hosts. Pure logic.

export type HostKind = 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'gitea';

export interface WebRepo {
  /** e.g. "https://github.com/owner/repo" */
  url: string;
  kind: HostKind;
}

/** Converts a remote URL (https, ssh or scp-style) to the repository's web URL. */
export function toWebRepo(remoteUrl: string): WebRepo | undefined {
  let host: string;
  let repoPath: string;

  // Local paths have no web page; "C:\repo" or "C:/repo" would otherwise parse as host "C" in scp syntax.
  if (/^[a-zA-Z]:[\\/]/.test(remoteUrl) || remoteUrl.includes('\\')) return undefined;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(remoteUrl);
  const url = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(remoteUrl);
  if (url) {
    [, host, repoPath] = url;
  } else if (scp) {
    [, host, repoPath] = scp;
  } else {
    return undefined;
  }
  repoPath = repoPath.replace(/\.git\/?$/, '').replace(/\/$/, '');

  // Azure DevOps: git@ssh.dev.azure.com:v3/org/project/repo and https://dev.azure.com/org/project/_git/repo
  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    const [, org, project, repo] = repoPath.split('/');
    return { url: `https://dev.azure.com/${org}/${project}/_git/${repo}`, kind: 'azure' };
  }
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) {
    return { url: `https://${host}/${repoPath}`, kind: 'azure' };
  }

  const kind: HostKind = host.includes('gitlab')
    ? 'gitlab'
    : host.includes('bitbucket')
      ? 'bitbucket'
      : host.includes('gitea') || host.includes('codeberg') || host.includes('forgejo')
        ? 'gitea'
        : 'github';
  return { url: `https://${host}/${repoPath}`, kind };
}

/** Encodes a branch name for a URL path, keeping slashes readable. */
function branchPart(name: string): string {
  return encodeURIComponent(name).replace(/%2F/g, '/');
}

export function commitUrl(repo: WebRepo, sha: string): string {
  switch (repo.kind) {
    case 'gitlab':
      return `${repo.url}/-/commit/${sha}`;
    case 'bitbucket':
      return `${repo.url}/commits/${sha}`;
    default:
      return `${repo.url}/commit/${sha}`;
  }
}

/** URL that starts a pull/merge request from `branch` (its name on the remote) into `base`. */
export function pullRequestUrl(repo: WebRepo, branch: string, base?: string): string {
  const q = encodeURIComponent;
  switch (repo.kind) {
    case 'gitlab':
      return (
        `${repo.url}/-/merge_requests/new?merge_request[source_branch]=${q(branch)}` +
        (base ? `&merge_request[target_branch]=${q(base)}` : '')
      );
    case 'bitbucket':
      return `${repo.url}/pull-requests/new?source=${q(branch)}` + (base ? `&dest=${q(base)}` : '');
    case 'azure':
      return `${repo.url}/pullrequestcreate?sourceRef=${q(branch)}` + (base ? `&targetRef=${q(base)}` : '');
    case 'gitea':
      return `${repo.url}/compare/${base ? `${branchPart(base)}...` : ''}${branchPart(branch)}`;
    default:
      return `${repo.url}/compare/${base ? `${branchPart(base)}...` : ''}${branchPart(branch)}?expand=1`;
  }
}
