import { execSync } from 'child_process';

export function ocAvailable(): boolean {
  try {
    execSync('oc whoami', { stdio: 'pipe', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export function oc(args: string): string {
  return execSync(`oc ${args}`, {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function viewerCreds(): { user: string; password: string } | null {
  const user = process.env.BRIDGE_VIEWER_USER?.trim();
  const password = process.env.BRIDGE_VIEWER_PASSWORD?.trim();
  if (!user || !password) return null;
  return { user, password };
}

/** First Running pod with runtimeClassName starting with kata-cc. */
export function findKataCcPod(): { ns: string; name: string; uid: string; node: string } | null {
  if (!ocAvailable()) return null;
  try {
    const json = oc(
      `get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"|"}{.metadata.name}{"|"}{.metadata.uid}{"|"}{.spec.nodeName}{"|"}{.spec.runtimeClassName}{"|"}{.status.phase}{"\\n"}{end}'`,
    );
    for (const line of json.split('\n')) {
      const [ns, name, uid, node, rc, phase] = line.split('|');
      if (ns && name && rc?.startsWith('kata-cc') && phase === 'Running') {
        return { ns, name, uid: uid || '', node: node || '' };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
