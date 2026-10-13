import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const setting = manifest.contributes.configuration.properties['silykat.commentShortcut'];
const bindings: { command: string; key: string; mac: string; when: string }[] = manifest.contributes.keybindings;

describe('comment shortcut setting', () => {
  it('defaults to Ctrl+Cmd+C', () => {
    expect(setting.default).toBe('ctrl+cmd+c');
  });

  it('has exactly one keybinding per preset, gated on the setting', () => {
    const presets = (setting.enum as string[]).filter((v) => v !== 'none');
    expect(bindings.map((b) => b.when.match(/commentShortcut == '([^']+)'/)?.[1]).sort()).toEqual([...presets].sort());
    for (const b of bindings) expect(b.command).toBe('silykat.commentSelection');
  });

  it('offers "none" without any keybinding', () => {
    expect(setting.enum).toContain('none');
    expect(bindings.some((b) => b.when.includes("== 'none'"))).toBe(false);
  });

  it('describes every option', () => {
    expect(setting.enumDescriptions).toHaveLength(setting.enum.length);
  });
});
