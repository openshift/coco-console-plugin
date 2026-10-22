import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { navigateTo, assertNoReactErrors, waitForContent } from './helpers.js';
import { findKataCcPod, oc, ocAvailable } from './cluster.js';

/**
 * Manual matrix B-34: failed evidence UI on CoCo workload (Pod) detail.
 *
 * Seeds its own attestation-evidence ConfigMap; restores after. Does not use
 * OSC or Trustee console routes. Detail page watches a Pod by URL name — never
 * use a Deployment name here.
 */
const CM_NAME = 'attestation-evidence-pw-b34';

function applyEvidence(
  pod: { ns: string; name: string; uid: string; node: string },
  verdict: 'failed' | 'passed',
) {
  const http = verdict === 'passed' ? '200' : '403';
  const manifest = `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${CM_NAME}
  namespace: ${pod.ns}
  labels:
    trustee.attestation/evidence: "true"
    trustee.attestation/pod: "${pod.name}"
data:
  evidence.json: |
    {
      "schema": "trustee.attestation.evidence/v1",
      "source": "sidecar",
      "timestamp": "${new Date().toISOString()}",
      "workload": {
        "namespace": "${pod.ns}",
        "name": "${pod.name}",
        "uid": "${pod.uid}",
        "node": "${pod.node}",
        "runtimeClassName": "kata-cc",
        "hasInitData": false
      },
      "trustee": {
        "kbsEndpoint": "http://kbs-service.trustee-operator-system:8080"
      },
      "probe": {
        "method": "cdh-get-resource",
        "cdhPath": "/cdh/resource/default/demo/key",
        "httpStatus": "${http}"
      },
      "verdict": "${verdict}"
    }
`;
  const tmp = path.join(os.tmpdir(), `${CM_NAME}-${verdict}.yaml`);
  fs.writeFileSync(tmp, manifest);
  execSync(`oc apply -f ${tmp}`, { encoding: 'utf8', timeout: 60_000 });
  fs.unlinkSync(tmp);
}

test.describe('B-34 failed evidence UI', () => {
  let pod: ReturnType<typeof findKataCcPod>;

  test.beforeAll(() => {
    test.skip(!ocAvailable(), 'oc / KUBECONFIG required to seed evidence ConfigMap');
    pod = findKataCcPod();
    test.skip(!pod, 'No Running kata-cc* pod found to attach evidence');
    applyEvidence(pod!, 'failed');
  });

  test.afterAll(() => {
    if (!pod || !ocAvailable()) return;
    try {
      applyEvidence(pod, 'passed');
    } catch {
      try {
        oc(`delete cm -n ${pod.ns} ${CM_NAME} --ignore-not-found`);
      } catch {
        /* ignore */
      }
    }
  });

  test('Attestation tab shows evidence rejected for failed verdict', async ({
    page,
    baseURL,
  }) => {
    test.skip(!pod, 'No kata-cc pod');
    await navigateTo(
      page,
      baseURL!,
      `/confidential-containers/workloads/${pod!.ns}/${pod!.name}`,
    );
    await waitForContent(
      page,
      /evidence rejected|Attestation evidence|Attestation service|verdict/i,
      240_000,
    );

    const main = page.locator('#content-scrollable, body').first();
    await expect(main).toContainText(/evidence rejected/i, { timeout: 60_000 });
    await expect(main).toContainText(/failed/i);
    await assertNoReactErrors(page);
  });
});
