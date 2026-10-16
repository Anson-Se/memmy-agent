import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { BrowserAccessApproval } from '../../../../src/core/agent-runtime/tools/browser-access-approval.js';
import { BrowserUseSitePolicyReader } from '../../../../src/core/agent-runtime/tools/browser-use-site-policy-store.js';
import { BrowserCapabilityApproval } from '../../../../src/core/agent-runtime/tools/browser-capability-approval.js';

it('honors saved website allow and deny decisions and clears them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-access-'));
  try {
    const file = path.join(root, 'access.json');
    const access = new BrowserAccessApproval(file);
    fs.writeFileSync(file, JSON.stringify({ 'https://allow.example': 'allow', 'https://deny.example': 'deny' }));
    expect(await access.authorize('https://allow.example/page', new Set())).toBe(true);
    expect(await access.authorize('https://deny.example/page', new Set(['https://deny.example']))).toBe(false);
    access.clear();
    expect(fs.existsSync(file)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('applies a site matrix before legacy browsing grants and file transfer prompts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-policy-'));
  try {
    const accessPath = path.join(root, 'access.json');
    const policyPath = path.join(root, 'site-policy.json');
    fs.writeFileSync(accessPath, JSON.stringify({ 'https://ask.example': 'allow',
      'https://blocked.example': 'allow' }));
    fs.writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [
      { pattern: 'https://ask.example', access: 'ask', downloads: 'ask', uploads: 'ask', fullCdp: 'block' },
      { pattern: 'https://blocked.example', access: 'block', downloads: 'allow', uploads: 'allow', fullCdp: 'block' },
      { pattern: 'https://allowed.example', access: 'allow', downloads: 'allow', uploads: 'allow', fullCdp: 'block' },
    ] }));
    const reader = new BrowserUseSitePolicyReader(policyPath);
    const browsing = new BrowserAccessApproval(accessPath, reader);
    const transfers = new BrowserCapabilityApproval(reader);
    vi.spyOn(browsing as any, 'requestDecision').mockResolvedValue('deny');
    expect(await browsing.authorize('https://ask.example/', new Set())).toBe(false);
    expect((browsing as any).requestDecision).toHaveBeenCalledOnce();
    expect(await browsing.authorize('https://blocked.example/', new Set(['https://blocked.example']))).toBe(false);
    expect(await browsing.authorize('https://allowed.example/', new Set())).toBe(true);
    expect(await transfers.authorize('upload', 'https://allowed.example/', ['file.txt'])).toBe(true);
    expect(await transfers.authorize('upload', 'https://blocked.example/', ['file.txt'])).toBe(false);
    expect(reader.decision('https://ask.example/', 'downloads')).toBe('ask');
    vi.spyOn(browsing as any, 'requestDecision').mockImplementation(async () => {
      fs.writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [
        { pattern: 'https://ask.example', access: 'block', downloads: 'ask',
          uploads: 'ask', fullCdp: 'block' },
      ] }));
      return 'allow';
    });
    expect(await browsing.authorize('https://ask.example/', new Set())).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('asks again in an existing chat after website permissions are revoked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-revoke-'));
  try {
    const accessPath = path.join(root, 'access.json');
    const policyPath = path.join(root, 'site-policy.json');
    const access = new BrowserAccessApproval(accessPath, new BrowserUseSitePolicyReader(policyPath));
    const prompt = vi.spyOn(access as any, 'requestDecision')
      .mockResolvedValueOnce('allow-once').mockResolvedValue('deny');
    const grants = new Set<string>();
    expect(await access.authorize('https://test.example/page', grants)).toBe(true);
    expect(await access.authorize('https://test.example/next', grants)).toBe(true);
    expect(prompt).toHaveBeenCalledOnce();
    fs.writeFileSync(accessPath, JSON.stringify({ 'https://test.example': 'allow' }));
    expect(await access.authorize('https://test.example/page', grants)).toBe(true);
    fs.writeFileSync(accessPath, '{}');
    expect(await access.authorize('https://test.example/page', grants)).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(grants.has('https://test.example')).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('does not apply a pending temporary approval after settings change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-pending-revoke-'));
  try {
    const accessPath = path.join(root, 'access.json');
    const policyPath = path.join(root, 'site-policy.json');
    const access = new BrowserAccessApproval(accessPath, new BrowserUseSitePolicyReader(policyPath));
    let approve!: (decision: string) => void;
    vi.spyOn(access as any, 'requestDecision').mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    const grants = new Set<string>();
    const pending = access.authorize('https://test.example/page', grants);
    fs.writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [
      { pattern: 'https://test.example', access: 'ask', downloads: 'ask', uploads: 'ask', fullCdp: 'block' },
    ] }));
    approve('allow-once');
    expect(await pending).toBe(false);
    expect(grants.size).toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
